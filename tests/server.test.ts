import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two stdio MCP processes announce through one SQLite frequency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-frequency-mcp-test-"));
  temporaryDirectories.push(directory);
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Agent Frequency Test");
  git(directory, "config", "user.email", "agent-frequency@example.invalid");
  writeFileSync(join(directory, "flight-plan.txt"), "initial\n");
  git(directory, "add", "flight-plan.txt");
  git(directory, "commit", "-qm", "initial");

  const dbPath = join(directory, "state", "agent-frequency.sqlite3");
  const codex = await connectClient("Codex", dbPath);
  const claude = await connectClient("Claude", dbPath);
  const tools = await codex.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual(["announce"]);
  expect(tools.tools[0]?.description).toContain("before your first edit");
  expect(tools.tools[0]?.description).toContain("Nothing is ever locked or blocked");

  // Delivered over a real handshake, because the standing "when to call this"
  // directive only reaches the model if the server actually populates it.
  const instructions = codex.getInstructions();
  expect(instructions).toBeTruthy();
  expect(instructions).toContain("Before your first edit");
  expect(instructions).toContain("untrusted data");
  // The completing call is also the caller's last read of the frequency, so the
  // directive has to say when to make it, not just that it releases the lease.
  expect(instructions).toContain("closing summary");
  expect(instructions).toContain("awareness, never a lock");
  expect(instructions).toContain("keep them out of your commits");
  // Agents otherwise narrate every peer they see back to the user, which turns
  // ambient presence into noise in reports.
  expect(instructions).toContain("only when it changed your work");
  // Both are how a stop goes stale on a "waiting on you" list: a finished task
  // stopped only to offer shipping, and a resumed stop that never spoke again.
  expect(instructions).toContain("still counts as done");
  expect(instructions).toContain("announce again first");

  // The claim-era fields are gone from the contract, and the strict schema
  // says so rather than silently dropping paths a caller thinks it shared.
  for (const legacy of [
    { scopes: [{ path: "flight-plan.txt", access: "exclusive" }] },
    { timebox: "2h" },
    { state: "planning" },
  ]) {
    const rejected = await codex.callTool({
      name: "announce",
      arguments: { summary: "Old-style call", cwd: directory, ...legacy },
    });
    expect(rejected.isError).toBeTrue();
  }

  const first = await codex.callTool({
    name: "announce",
    arguments: {
      summary: "Edit flight plan",
      emoji: "🐛",
      cwd: directory,
      paths: ["flight-plan.txt"],
    },
  });
  const second = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Review flight plan",
      // Not a single emoji, and longer than sanitizeEmoji's 32-unit cap: the
      // call must still succeed rather than fail input validation, just
      // without an emoji.
      emoji: "definitely not an emoji, and far too long to ever be one",
      cwd: directory,
      paths: ["flight-plan.txt"],
    },
  });

  const firstOutput = first.structuredContent as Record<string, unknown> | undefined;
  const secondOutput = second.structuredContent as Record<string, unknown> | undefined;
  expect(first.isError).not.toBeTrue();
  expect(firstOutput?.status).toBe("active");
  expect(firstOutput?.self).toMatchObject({ surface: "cli", emoji: "🐛", paths: ["flight-plan.txt"] });
  expect(firstOutput?.warnings).toEqual([]);
  expect(second.isError).not.toBeTrue();
  // Both agents edit the same file: the second hears about it and goes ahead.
  expect(secondOutput?.status).toBe("active");
  expect(secondOutput?.peers).toMatchObject([
    { agent_id: expect.stringMatching(/^Codex /), paths: ["flight-plan.txt"] },
  ]);
  expect(
    (secondOutput?.warnings as Array<{ code: string }>).map((warning) => warning.code),
  ).toEqual(["PATH_OVERLAP", "SAME_WORKTREE"]);
  // An unusable emoji is dropped rather than failing the call, and the
  // peer's real one still crosses the process boundary.
  expect((secondOutput?.self as Record<string, unknown> | undefined)?.emoji).toBeNull();
  expect((secondOutput?.peers as Array<Record<string, unknown>>)[0]?.emoji).toBe("🐛");
  expect(secondOutput?.traffic_scope).toBe("worktree");

  // The same repo-relative path in another worktree names different physical
  // files. It stays visible as integration context, without a warning.
  const worktreeParent = mkdtempSync(join(tmpdir(), "agent-frequency-worktree-test-"));
  temporaryDirectories.push(worktreeParent);
  const worktreeDirectory = join(worktreeParent, "sibling");
  git(directory, "worktree", "add", "-qb", "sibling", worktreeDirectory);
  const crossWorktree = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Edit flight plan independently",
      cwd: worktreeDirectory,
      paths: ["flight-plan.txt"],
    },
  });
  const crossWorktreeOutput = crossWorktree.structuredContent as Record<string, unknown>;
  expect(crossWorktree.isError).not.toBeTrue();
  // Both agents in the first worktree, including this same session's own
  // lease there, are context from a different checkout.
  expect(crossWorktreeOutput.peers).toMatchObject([
    { relation: "same_clone", paths: ["flight-plan.txt"] },
    { relation: "same_clone", paths: ["flight-plan.txt"] },
  ]);
  expect(
    (crossWorktreeOutput.warnings as Array<{ code: string }>).some(
      (warning) => warning.code === "PATH_OVERLAP",
    ),
  ).toBeFalse();

  const crossWorktreeCompletion = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Finished independent flight plan edit",
      cwd: worktreeDirectory,
      lease_id: (crossWorktreeOutput.self as Record<string, unknown>).lease_id,
      state: "done",
    },
  });
  expect(crossWorktreeCompletion.isError).not.toBeTrue();

  const unrelatedDirectory = mkdtempSync(join(tmpdir(), "agent-frequency-unrelated-test-"));
  temporaryDirectories.push(unrelatedDirectory);
  git(unrelatedDirectory, "init", "-q");
  git(unrelatedDirectory, "config", "user.name", "Agent Frequency Test");
  git(unrelatedDirectory, "config", "user.email", "agent-frequency@example.invalid");
  writeFileSync(join(unrelatedDirectory, "unrelated.txt"), "initial\n");
  git(unrelatedDirectory, "add", "unrelated.txt");
  git(unrelatedDirectory, "commit", "-qm", "initial");

  const unrelated = await codex.callTool({
    name: "announce",
    arguments: {
      summary: "Edit unrelated project",
      cwd: unrelatedDirectory,
    },
  });
  expect(unrelated.isError).not.toBeTrue();

  const secondLeaseId = (secondOutput?.self as Record<string, unknown>).lease_id;
  const narrow = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Review flight plan",
      cwd: directory,
      paths: ["flight-plan.txt"],
      lease_id: secondLeaseId,
    },
  });
  const narrowOutput = narrow.structuredContent as Record<string, unknown>;
  expect(narrow.isError).not.toBeTrue();
  expect(narrowOutput.peers).toBeArrayOfSize(1);
  expect(narrowOutput.hidden_peers).toMatchObject({ other_project: 1 });

  const expanded = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Review flight plan with machine context",
      cwd: directory,
      paths: ["flight-plan.txt"],
      lease_id: secondLeaseId,
      traffic_scope: "machine",
    },
  });
  const expandedOutput = expanded.structuredContent as Record<string, unknown>;
  expect(expanded.isError).not.toBeTrue();
  expect(expandedOutput.traffic_scope).toBe("machine");
  expect(expandedOutput.peers).toBeArrayOfSize(2);

  const completion = await codex.callTool({
    name: "announce",
    arguments: {
      summary: "Finished flight plan",
      cwd: directory,
      lease_id: (firstOutput?.self as Record<string, unknown>).lease_id,
      state: "done",
    },
  });
  const completionOutput = completion.structuredContent as Record<string, unknown> | undefined;
  expect(completion.isError).not.toBeTrue();
  expect(completionOutput?.status).toBe("completed");
  expect(completionOutput?.self).toMatchObject({ state: "done", lease_id: null });

  const afterCompletion = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Review released flight plan",
      cwd: directory,
      paths: ["flight-plan.txt"],
      lease_id: secondLeaseId,
    },
  });
  expect(afterCompletion.isError).not.toBeTrue();
  const afterCompletionOutput = afterCompletion.structuredContent as Record<string, unknown>;
  expect(afterCompletionOutput?.warnings).toEqual([]);
  // Claude's renewal is a delta since its own last announcement, so the
  // departed Codex must arrive as a recent peer across the process boundary.
  expect(
    (afterCompletionOutput?.recent_peers as Array<Record<string, unknown>>).map(
      (peer) => peer.outcome,
    ),
  ).toEqual(["completed"]);
  expect(
    (afterCompletionOutput?.recent_peers as Array<Record<string, unknown>>)[0]?.summary,
  ).toBe("Finished flight plan");

  // A stop without a reason must fail loudly instead of landing as a silent
  // completion.
  const reasonless = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Giving up on the flight plan",
      cwd: directory,
      lease_id: secondLeaseId,
      state: "stopped",
    },
  });
  expect(reasonless.isError).toBeTrue();

  // waiting_on is a closed set: a value outside it fails the schema.
  const unknownWait = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Flight plan review paused",
      cwd: directory,
      lease_id: secondLeaseId,
      state: "stopped",
      reason: "waiting on someone",
      waiting_on: "boss",
    },
  });
  expect(unknownWait.isError).toBeTrue();

  const stopped = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Flight plan review paused",
      cwd: directory,
      lease_id: secondLeaseId,
      state: "stopped",
      reason: "waiting on user: approve the new wording",
      waiting_on: "user",
    },
  });
  const stoppedOutput = stopped.structuredContent as Record<string, unknown> | undefined;
  expect(stopped.isError).not.toBeTrue();
  expect(stoppedOutput?.status).toBe("stopped");
  expect(stoppedOutput?.self).toMatchObject({ state: "stopped", lease_id: null });

  // The stop crosses the process boundary as its own outcome, with the
  // stopping agent's reason attached.
  const afterStop = await codex.callTool({
    name: "announce",
    arguments: {
      summary: "Pick the flight plan back up",
      cwd: directory,
      paths: ["flight-plan.txt"],
    },
  });
  expect(afterStop.isError).not.toBeTrue();
  const afterStopOutput = afterStop.structuredContent as Record<string, unknown>;
  expect(afterStopOutput?.recent_peers as Array<Record<string, unknown>>).toMatchObject([
    {
      outcome: "stopped",
      reason: "waiting on user: approve the new wording",
      waiting_on: "user",
      summary: "Flight plan review paused",
    },
  ]);

  const database = new Database(dbPath, { readonly: true });
  const events = database
    .query(
      "SELECT status, client_surface, agent_state, stopped, reason, waiting_on FROM activity_events ORDER BY event_id ASC",
    )
    .all() as Array<Record<string, unknown>>;
  database.close(false);
  // Stops store the v2 "done" state plus the additive flag, so an older
  // process reading these rows still parses them. The rejected calls above
  // failed validation before reaching the store, so they must not appear.
  const working = { status: "granted", client_surface: "cli", agent_state: "working", stopped: 0, reason: null, waiting_on: null };
  const done = { ...working, agent_state: "done" };
  expect(events).toEqual([
    working,
    working,
    working,
    done,
    working,
    working,
    working,
    done,
    working,
    { ...done, stopped: 1, reason: "waiting on user: approve the new wording", waiting_on: "user" },
    working,
  ]);
});

test("many MCP processes can tune in concurrently without SQLite startup failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-frequency-concurrency-test-"));
  temporaryDirectories.push(directory);
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Agent Frequency Test");
  git(directory, "config", "user.email", "agent-frequency@example.invalid");
  writeFileSync(join(directory, "tracked.txt"), "initial\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-qm", "initial");

  const dbPath = join(directory, "state", "agent-frequency.sqlite3");
  const concurrentClients = await Promise.all(
    Array.from({ length: 20 }, (_, index) => connectClient(`Agent-${index}`, dbPath)),
  );
  const results = await Promise.all(
    concurrentClients.map((client, index) => client.callTool({
      name: "announce",
      arguments: {
        summary: `Concurrent announcement ${index}`,
        cwd: directory,
      },
    })),
  );

  expect(results.every((result) => result.isError !== true)).toBeTrue();
  expect(results.map((result) => (result.structuredContent as Record<string, unknown>)?.status)).toEqual(
    Array.from({ length: 20 }, () => "active"),
  );

  const database = new Database(dbPath, { readonly: true });
  const activity = database
    .query("SELECT count(*) AS total FROM activity_events")
    .get() as { total: number };
  database.close(false);
  expect(activity.total).toBe(20);
});

async function connectClient(label: string, dbPath: string): Promise<Client> {
  const client = new Client({ name: `${label} test client`, version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: join(import.meta.dir, "../bin/agent-frequency-mcp"),
    env: {
      ...cleanEnvironment(),
      AGENT_FREQUENCY_CLIENT_NAME: label,
      AGENT_FREQUENCY_CLIENT_SURFACE: "cli",
      AGENT_FREQUENCY_DB_PATH: dbPath,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}
