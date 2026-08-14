import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stripUnsafeFormatting } from "./scopes";
import type { GitMetadata } from "./types";

const GIT_TIMEOUT_MS = 2_000;

interface GitResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

interface DirtyState {
  dirty: boolean;
  dirtyCount: number;
  dirtyPaths: string[];
}

/**
 * Git origins are identifiers, not navigation links. Removing credentials and
 * transport details both prevents accidental secret disclosure and lets SSH and
 * HTTPS clones of the same remote share a project identity.
 */
export function normalizeGitOrigin(rawOrigin: string, baseDir: string): string | null {
  if (/[\0\r\n]/.test(rawOrigin)) return null;

  const origin = rawOrigin.trim();
  if (!origin) return null;

  const scpMatch = origin.includes("://")
    ? null
    : origin.includes("@")
      ? origin.match(/^[^/@:]+@([^/:\s]+):(.+)$/)
      : origin.match(/^([^/:\s]+\.[^/:\s]*):(.+)$/);
  if (scpMatch) {
    const host = scpMatch[1]?.toLowerCase();
    const repositoryPath = normalizeRemotePath(scpMatch[2] ?? "");
    return host && repositoryPath ? `${host}/${repositoryPath}` : null;
  }

  try {
    const url = new URL(origin);

    if (url.protocol === "file:") {
      return normalizeLocalOrigin(decodeURIComponent(url.pathname), baseDir);
    }

    if (!url.hostname) return null;

    const repositoryPath = normalizeRemotePath(url.pathname);
    if (!repositoryPath) return null;

    // hostname excludes username/password, so tokens embedded in the authority
    // can never reach the normalized value or the hashes derived from it.
    return `${normalizeRemoteHost(url)}/${repositoryPath}`;
  } catch {
    // Relative and absolute filesystem remotes are legitimate. Any other
    // URL-like value is rejected instead of risking retention of credentials.
    if (origin.includes("://") || origin.includes("@")) return null;
    return normalizeLocalOrigin(origin, baseDir);
  }
}

export async function collectGitMetadata(cwd: string): Promise<GitMetadata> {
  const canonicalCwd = await validateCwd(cwd);
  const identity = await runGit(canonicalCwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
  ]);

  if (identity.timedOut || identity.exitCode !== 0) {
    throw new Error("cwd must be inside a readable Git worktree");
  }

  const identityLines = identity.stdout.trimEnd().split("\n");
  if (identityLines.length !== 3 || identityLines.some((line) => !isAbsolute(line))) {
    throw new Error("Git returned an incomplete worktree identity");
  }

  const [rawWorktreeRoot, rawGitDir, rawGitCommonDir] = identityLines as [string, string, string];
  const [worktreeRoot, gitDir, gitCommonDir] = await Promise.all([
    realpath(rawWorktreeRoot),
    realpath(rawGitDir),
    realpath(rawGitCommonDir),
  ]);

  const [branchResult, headResult, ignoreCaseResult, originResult, statusResult] = await Promise.all([
    runGit(worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(worktreeRoot, ["rev-parse", "--verify", "HEAD"]),
    runGit(worktreeRoot, ["config", "--type=bool", "--get", "core.ignorecase"]),
    runGit(worktreeRoot, ["remote", "get-url", "origin"]),
    runGit(worktreeRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
  ]);

  const origin = originResult.exitCode === 0 && !originResult.timedOut
    ? normalizeGitOrigin(originResult.stdout.trimEnd(), worktreeRoot)
    : null;
  const dirtyState = statusResult.exitCode === 0 && !statusResult.timedOut
    ? parsePorcelainV2(statusResult.stdout)
    : null;

  return {
    projectId: stableId("project", origin ? `origin:${origin}` : `common:${gitCommonDir}`),
    localRepoId: stableId("clone", gitCommonDir),
    repoName: basename(worktreeRoot),
    worktreeId: stableId("worktree", worktreeRoot),
    worktreeRoot,
    gitDir,
    gitCommonDir,
    branch: branchResult.exitCode === 0 && !branchResult.timedOut
      ? branchResult.stdout.trimEnd() || null
      : null,
    headOid: headResult.exitCode === 0 && !headResult.timedOut
      ? headResult.stdout.trimEnd() || null
      : null,
    ignoreCase: ignoreCaseResult.exitCode === 0 && !ignoreCaseResult.timedOut
      ? ignoreCaseResult.stdout.trim() === "true"
      : false,
    origin,
    dirty: dirtyState?.dirty ?? null,
    dirtyCount: dirtyState?.dirtyCount ?? null,
    dirtyPaths: dirtyState?.dirtyPaths ?? [],
    metadataComplete: dirtyState !== null,
  };
}

function normalizeRemotePath(rawPath: string): string {
  return rawPath
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\.git$/i, "");
}

function normalizeRemoteHost(url: URL): string {
  const defaultPort = (
    (url.protocol === "http:" && url.port === "80")
    || (url.protocol === "https:" && url.port === "443")
    || (url.protocol === "ssh:" && url.port === "22")
    || (url.protocol === "git:" && url.port === "9418")
  );
  return `${url.hostname.toLowerCase()}${url.port && !defaultPort ? `:${url.port}` : ""}`;
}

function normalizeLocalOrigin(origin: string, baseDir: string): string | null {
  if (!isAbsolute(baseDir)) return null;

  const absolutePath = resolve(baseDir, origin);
  const repositoryPath = absolutePath.replace(/\.git\/?$/i, "");
  return pathToFileURL(repositoryPath).href.replace(/\/$/, "");
}

function stableId(namespace: string, value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex");
}

async function validateCwd(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    throw new Error("cwd must exist and be readable");
  }

  if (!cwdStat.isDirectory()) throw new Error("cwd must be a directory");
  return realpath(cwd);
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" },
    stdout: "pipe",
    stderr: "ignore",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    process.kill();
  }, GIT_TIMEOUT_MS);

  try {
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    return { exitCode, stdout, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

function parsePorcelainV2(output: string): DirtyState {
  const records = output.split("\0");
  const dirtyPaths: string[] = [];
  let dirtyCount = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.startsWith("# ") || record.startsWith("! ")) continue;

    let path: string | null = null;
    if (record.startsWith("? ")) {
      path = record.slice(2);
    } else if (record.startsWith("1 ")) {
      path = fieldRemainder(record, 8);
    } else if (record.startsWith("2 ")) {
      path = fieldRemainder(record, 9);
      const originalPath = records[index + 1];
      if (originalPath) dirtyPaths.push(normalizeStatusPath(originalPath));
      index += 1;
    } else if (record.startsWith("u ")) {
      path = fieldRemainder(record, 10);
    }

    if (path !== null) {
      dirtyCount += 1;
      dirtyPaths.push(normalizeStatusPath(path));
    }
  }

  return {
    dirty: dirtyCount > 0,
    dirtyCount,
    dirtyPaths: [...new Set(dirtyPaths)].sort(),
  };
}

function fieldRemainder(record: string, leadingFieldCount: number): string | null {
  let spacesSeen = 0;
  for (let index = 0; index < record.length; index += 1) {
    if (record[index] !== " ") continue;
    spacesSeen += 1;
    if (spacesSeen === leadingFieldCount) return record.slice(index + 1);
  }
  return null;
}

function normalizeStatusPath(path: string): string {
  // Git's -z format is unquoted. POSIX separators keep path comparisons stable
  // if Agent Frequency data is ever consumed across platforms.
  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  // Dirty paths are shown to peers, and filenames are attacker-controllable
  // (untrusted checkouts, package postinstalls create files --untracked-files=all
  // picks up). Apply the same formatting defenses and length bound as scope
  // paths; these are display identifiers, not lookup keys.
  return stripUnsafeFormatting(normalized).slice(0, 512);
}
