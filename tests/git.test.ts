import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { collectGitMetadata, normalizeGitOrigin } from "../src/git";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("normalizeGitOrigin", () => {
  test("removes credentials, transport, query strings, and .git suffixes", () => {
    expect(normalizeGitOrigin(
      "https://oauth:secret@GitHub.com/Fabrizio/AgentFrequency.git?access_token=also-secret#fragment",
      "/tmp",
    )).toBe("github.com/Fabrizio/AgentFrequency");
    expect(normalizeGitOrigin("git@github.com:Fabrizio/AgentFrequency.git", "/tmp"))
      .toBe("github.com/Fabrizio/AgentFrequency");
    expect(normalizeGitOrigin("ssh://git@GITHUB.com/Fabrizio/AgentFrequency.git", "/tmp"))
      .toBe("github.com/Fabrizio/AgentFrequency");
    expect(normalizeGitOrigin("git@github.com:Fabrizio/AgentFrequency.git?token=secret", "/tmp"))
      .toBe("github.com/Fabrizio/AgentFrequency");
    expect(normalizeGitOrigin("user:secret@example.com:Fabrizio/AgentFrequency.git", "/tmp"))
      .toBeNull();
  });

  test("normalizes local origins to credential-free file URLs", () => {
    expect(normalizeGitOrigin("../remotes/agent-frequency.git", "/tmp/worktree"))
      .toBe("file:///tmp/remotes/agent-frequency");
    expect(normalizeGitOrigin("https://token@example.com", "/tmp")).toBeNull();
    expect(normalizeGitOrigin("bad\norigin", "/tmp")).toBeNull();
  });
});

describe("collectGitMetadata", () => {
  test("collects stable identity and porcelain-v2 dirty paths", async () => {
    const repository = await createRepository();
    const nestedCwd = join(repository, "src");
    await mkdir(nestedCwd);

    await writeFile(join(repository, "tracked.txt"), "changed\n");
    await writeFile(join(nestedCwd, "name with spaces.txt"), "untracked\n");
    // Filenames are attacker-controllable and reach peers' transcripts; the
    // RLO override below must be stripped like every other peer-visible field.
    await writeFile(join(repository, "evil‮name.txt"), "untracked\n");
    git(repository, "remote", "add", "origin", "https://user:secret@GitHub.com/Fab/AgentFrequency.git");

    const httpsMetadata = await collectGitMetadata(nestedCwd);
    const canonicalRepository = await realpath(repository);

    expect(httpsMetadata.repoName).toBe(basename(repository));
    expect(httpsMetadata.worktreeRoot).toBe(canonicalRepository);
    expect(httpsMetadata.gitDir).toBe(join(canonicalRepository, ".git"));
    expect(httpsMetadata.gitCommonDir).toBe(join(canonicalRepository, ".git"));
    expect(httpsMetadata.branch).toBe("main");
    expect(httpsMetadata.headOid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(httpsMetadata.origin).toBe("github.com/Fab/AgentFrequency");
    expect(httpsMetadata.dirty).toBe(true);
    expect(httpsMetadata.dirtyCount).toBe(3);
    expect(httpsMetadata.dirtyPaths).toEqual([
      "evil name.txt",
      "src/name with spaces.txt",
      "tracked.txt",
    ]);
    expect(httpsMetadata.metadataComplete).toBe(true);
    expect(httpsMetadata.projectId).toMatch(/^[0-9a-f]{64}$/);
    expect(httpsMetadata.localRepoId).toMatch(/^[0-9a-f]{64}$/);
    expect(httpsMetadata.worktreeId).toMatch(/^[0-9a-f]{64}$/);

    git(repository, "remote", "set-url", "origin", "git@github.com:Fab/AgentFrequency.git");
    const sshMetadata = await collectGitMetadata(repository);
    expect(sshMetadata.projectId).toBe(httpsMetadata.projectId);
    expect(sshMetadata.localRepoId).toBe(httpsMetadata.localRepoId);
    expect(sshMetadata.worktreeId).toBe(httpsMetadata.worktreeId);
  });

  test("requires an absolute cwd in a Git worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-frequency-not-git-"));
    temporaryDirectories.push(directory);

    await expect(collectGitMetadata("relative/path")).rejects.toThrow("absolute path");
    await expect(collectGitMetadata(directory)).rejects.toThrow("Git worktree");
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "agent-frequency-git-"));
  temporaryDirectories.push(repository);

  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Agent Frequency Test");
  git(repository, "config", "user.email", "agent-frequency@example.test");
  await writeFile(join(repository, "tracked.txt"), "initial\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "Initial commit");
  return repository;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" },
    stdout: "ignore",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`test Git command failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}
