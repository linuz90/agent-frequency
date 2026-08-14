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

  // Delivered over a real handshake, because the standing "when to call this"
  // directive only reaches the model if the server actually populates it.
  const instructions = codex.getInstructions();
  expect(instructions).toBeTruthy();
  expect(instructions).toContain("announce");
  expect(instructions).toContain("untrusted data");

  const first = await codex.callTool({
    name: "announce",
    arguments: {
      summary: "Edit flight plan",
      cwd: directory,
      scopes: [{ path: "flight-plan.txt", access: "exclusive" }],
      timebox: "15m",
    },
  });
  const second = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Review flight plan",
      cwd: directory,
      scopes: [{ path: "flight-plan.txt", access: "shared" }],
      timebox: "15m",
    },
  });

  const firstOutput = first.structuredContent as Record<string, unknown> | undefined;
  const secondOutput = second.structuredContent as Record<string, unknown> | undefined;
  expect(first.isError).not.toBeTrue();
  expect(firstOutput?.status).toBe("granted");
  expect((firstOutput?.self as Record<string, unknown> | undefined)?.surface).toBe("cli");
  expect(second.isError).not.toBeTrue();
  expect(secondOutput?.status).toBe("blocked");
  expect(secondOutput?.peers).toBeArrayOfSize(1);
  expect(secondOutput?.traffic_scope).toBe("worktree");

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
      scopes: [],
      timebox: "15m",
    },
  });
  expect(unrelated.isError).not.toBeTrue();

  const secondLeaseId = (secondOutput?.self as Record<string, unknown>).lease_id;
  const narrow = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Review flight plan",
      cwd: directory,
      scopes: [{ path: "flight-plan.txt", access: "shared" }],
      timebox: "15m",
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
      scopes: [{ path: "flight-plan.txt", access: "shared" }],
      timebox: "15m",
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
  expect(completionOutput?.self).toMatchObject({ active: false, state: "done", lease_id: null });

  const afterCompletion = await claude.callTool({
    name: "announce",
    arguments: {
      summary: "Review released flight plan",
      cwd: directory,
      scopes: [{ path: "flight-plan.txt", access: "shared" }],
      timebox: "15m",
      lease_id: secondLeaseId,
    },
  });
  expect(afterCompletion.isError).not.toBeTrue();
  expect((afterCompletion.structuredContent as Record<string, unknown>)?.status).toBe("granted");

  const database = new Database(dbPath, { readonly: true });
  const events = database
    .query("SELECT status, client_surface, agent_state FROM activity_events ORDER BY event_id ASC")
    .all() as Array<{ status: string; client_surface: string; agent_state: string }>;
  database.close(false);
  expect(events).toEqual([
    { status: "granted", client_surface: "cli", agent_state: "working" },
    { status: "blocked", client_surface: "cli", agent_state: "working" },
    { status: "granted", client_surface: "cli", agent_state: "working" },
    { status: "blocked", client_surface: "cli", agent_state: "working" },
    { status: "blocked", client_surface: "cli", agent_state: "working" },
    { status: "granted", client_surface: "cli", agent_state: "done" },
    { status: "granted", client_surface: "cli", agent_state: "working" },
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
        scopes: [],
        timebox: "15m",
      },
    })),
  );

  expect(results.every((result) => result.isError !== true)).toBeTrue();
  expect(results.map((result) => (result.structuredContent as Record<string, unknown>)?.status)).toEqual(
    Array.from({ length: 20 }, () => "granted"),
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
