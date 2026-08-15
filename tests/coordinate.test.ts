import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coordinateAnnouncement, sanitizeReason, sanitizeSummary } from "../src/coordinate";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("sanitizeSummary", () => {
  test("collapses lines and strips control formatting", () => {
    expect(sanitizeSummary("  Refactor\n\u202etoken\t refresh  ")).toBe("Refactor token refresh");
  });

  test("rejects empty and oversized summaries", () => {
    expect(() => sanitizeSummary("\n\t")).toThrow("visible text");
    expect(() => sanitizeSummary("x".repeat(161))).toThrow("at most 160");
  });
});

describe("sanitizeReason", () => {
  test("requires a reason for a stopped announcement", () => {
    expect(() => sanitizeReason(undefined, "stopped")).toThrow("requires a reason");
    expect(() => sanitizeReason("\n\t", "stopped")).toThrow("requires a reason");
    expect(() => sanitizeReason("x".repeat(201), "stopped")).toThrow("at most 200");
  });

  test("cleans the reason like a summary", () => {
    expect(sanitizeReason("  waiting on\n‮user  input ", "stopped")).toBe(
      "waiting on user input",
    );
  });

  test("drops the reason for every non-stopped state", () => {
    expect(sanitizeReason("ignored", "working")).toBeNull();
    expect(sanitizeReason("ignored", "done")).toBeNull();
    expect(sanitizeReason(undefined, "working")).toBeNull();
  });
});

test("two announcements share Git-derived traffic and advisory claims", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-frequency-coordinate-test-"));
  temporaryDirectories.push(directory);
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Agent Frequency Test");
  git(directory, "config", "user.email", "agent-frequency@example.invalid");
  writeFileSync(join(directory, "tracked.txt"), "initial\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-qm", "initial");

  const dbPath = join(directory, "agent-frequency.sqlite3");
  const first = await coordinateAnnouncement(
    {
      summary: "Edit the tracked file",
      cwd: directory,
      scopes: [{ path: "tracked.txt", access: "exclusive" }],
      timebox: "15m",
    },
    { agentId: "Codex A001", agentLabel: "Codex", clientSurface: "t3-code" },
    { dbPath, nowMs: 1_800_000_000_000 },
  );
  const second = await coordinateAnnouncement(
    {
      summary: "Review tracked file",
      cwd: directory,
      scopes: [{ path: "tracked.txt", access: "shared" }],
      timebox: "15m",
    },
    { agentId: "Claude B002", agentLabel: "Claude", clientSurface: "claude-app" },
    { dbPath, nowMs: 1_800_000_001_000 },
  );

  expect(first.status).toBe("granted");
  expect(first.self.lease_id).toMatch(/^[a-f0-9]{32}$/);
  expect(second.status).toBe("blocked");
  expect(second.traffic_scope).toBe("worktree");
  expect(second.hidden_peers).toEqual({
    same_worktree: 0,
    same_clone: 0,
    same_project: 0,
    other_project: 0,
  });
  expect(first.self.surface).toBe("t3-code");
  expect(second.peers[0]?.surface).toBe("t3-code");
  expect(second.peers.map((peer) => [peer.agent_id, peer.summary])).toEqual([
    ["Codex A001", "Edit the tracked file"],
  ]);
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}
