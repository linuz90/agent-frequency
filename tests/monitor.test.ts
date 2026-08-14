import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { startMonitor, type MonitorHandle, type MonitorState } from "../src/monitor";

const monitors: MonitorHandle[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const monitor of monitors.splice(0)) await monitor.stop();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-frequency-monitor-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite3");
}

function startTestMonitor(dbPath: string): MonitorHandle {
  // Port 0 lets the kernel pick a free port so concurrent test files cannot collide.
  const monitor = startMonitor({ port: 0, dbPath });
  monitors.push(monitor);
  return monitor;
}

async function fetchState(monitor: MonitorHandle): Promise<MonitorState> {
  const response = await fetch(`${monitor.url}api/state`);
  expect(response.status).toBe(200);
  return (await response.json()) as MonitorState;
}

/**
 * The monitor must read whatever the MCP server wrote, so the fixture writes
 * the v2-compatible schema directly instead of importing the store's private DDL.
 */
function seedDatabase(dbPath: string, nowMs: number): void {
  const database = new Database(dbPath, { create: true, strict: true });
  database.exec(`
    CREATE TABLE leases (
      lease_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_label TEXT NOT NULL,
      client_surface TEXT NOT NULL DEFAULT 'unknown',
      agent_state TEXT NOT NULL DEFAULT 'working',
      summary TEXT NOT NULL,
      project_id TEXT NOT NULL,
      local_repo_id TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      worktree_root TEXT NOT NULL,
      branch TEXT,
      head_oid TEXT,
      ignore_case INTEGER NOT NULL,
      dirty INTEGER,
      dirty_count INTEGER,
      dirty_paths TEXT NOT NULL DEFAULT '[]',
      metadata_complete INTEGER NOT NULL,
      timebox_seconds INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE claims (
      lease_id TEXT NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      access TEXT NOT NULL CHECK (access IN ('shared', 'exclusive')),
      PRIMARY KEY (lease_id, path)
    );
    CREATE TABLE activity_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_label TEXT NOT NULL,
      client_surface TEXT NOT NULL DEFAULT 'unknown',
      agent_state TEXT NOT NULL DEFAULT 'working',
      summary TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      worktree_root TEXT NOT NULL,
      branch TEXT,
      requested_scope_count INTEGER NOT NULL,
      granted_scope_count INTEGER NOT NULL,
      blocked_scope_count INTEGER NOT NULL,
      peer_count INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    PRAGMA user_version = 2;
  `);

  const insertLease = database.query(
    `INSERT INTO leases (
       lease_id, agent_id, agent_label, client_surface, agent_state, summary, project_id, local_repo_id, repo_name,
       worktree_id, worktree_root, branch, head_oid, ignore_case, dirty, dirty_count, dirty_paths,
       metadata_complete, timebox_seconds, created_at_ms, updated_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertLease.run(
    "lease-active",
    "alpha",
    "Codex",
    "t3-code",
    "working",
    "Refactor token refresh handling",
    "project-1",
    "clone-1",
    "example",
    "worktree-1",
    "/code/example",
    "feature/tokens",
    "abc123",
    0,
    1,
    2,
    JSON.stringify(["src/auth/token.ts", "tests/auth/token.test.ts"]),
    1,
    3_600,
    nowMs - 1_000,
    nowMs - 1_000,
    nowMs + 600_000,
  );
  insertLease.run(
    "lease-expired",
    "bravo",
    "Claude",
    "claude-app",
    "working",
    "Stale work that already expired",
    "project-1",
    "clone-1",
    "example",
    "worktree-2",
    "/code/example-two",
    "main",
    null,
    0,
    null,
    null,
    "[]",
    1,
    900,
    nowMs - 10_000,
    nowMs - 10_000,
    nowMs - 1,
  );

  const insertClaim = database.query("INSERT INTO claims (lease_id, path, access) VALUES (?, ?, ?)");
  insertClaim.run("lease-active", "src/auth/token.ts", "exclusive");
  insertClaim.run("lease-active", "tests/auth", "shared");
  insertClaim.run("lease-expired", "docs", "exclusive");

  const insertEvent = database.query(
    `INSERT INTO activity_events (
       event_type, status, agent_id, agent_label, client_surface, agent_state, summary, repo_name, worktree_root,
       branch, requested_scope_count, granted_scope_count, blocked_scope_count,
       peer_count, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    "announced",
    "granted",
    "alpha",
    "Codex",
    "t3-code",
    "working",
    "Refactor token refresh handling",
    "example",
    "/code/example",
    "feature/tokens",
    2,
    2,
    0,
    1,
    nowMs - 1_000,
  );
  insertEvent.run(
    "renewed",
    "blocked",
    "bravo",
    "Claude",
    "claude-app",
    "working",
    "Review token refresh handling",
    "example",
    "/code/example-two",
    "main",
    1,
    0,
    1,
    2,
    nowMs - 2_000,
  );
  insertEvent.run(
    "announced",
    "granted",
    "charlie",
    "Codex",
    "codex-app",
    "done",
    "Finished lifecycle support",
    "example",
    "/code/example-three",
    "feature/lifecycle",
    0,
    0,
    0,
    2,
    nowMs - 500,
  );
  // Monitor filtering keeps the seven-day window honest even before the next
  // announcing agent gets a chance to prune physical rows.
  insertEvent.run(
    "announced",
    "granted",
    "old",
    "Agent",
    "unknown",
    "working",
    "Old event",
    "example",
    "/code/example",
    "main",
    0,
    0,
    0,
    0,
    nowMs - 8 * 24 * 60 * 60 * 1_000,
  );
  database.close(false);
}

describe("monitor", () => {
  test("serves a valid empty payload when the database does not exist yet", async () => {
    const monitor = startTestMonitor(temporaryDatabasePath());
    const state = await fetchState(monitor);

    expect(state.database_available).toBeFalse();
    expect(state.schema_version).toBeNull();
    expect(state.agent_count).toBe(0);
    expect(state.leases).toEqual([]);
    expect(state.event_count).toBe(0);
    expect(state.events_truncated).toBe(0);
    expect(state.events).toEqual([]);
    expect(typeof state.now_ms).toBe("number");
  });

  test("returns active leases with parsed dirty paths and joined claims", async () => {
    const dbPath = temporaryDatabasePath();
    seedDatabase(dbPath, Date.now());
    const monitor = startTestMonitor(dbPath);

    const state = await fetchState(monitor);

    expect(state.database_available).toBeTrue();
    expect(state.schema_version).toBe(2);
    expect(state.agent_count).toBe(1);
    expect(state.leases.map((lease) => lease.agent_id)).toEqual(["alpha"]);

    const lease = state.leases[0];
    expect(lease?.agent_label).toBe("Codex");
    expect(lease?.client_surface).toBe("t3-code");
    expect(lease?.agent_state).toBe("working");
    expect(lease?.summary).toBe("Refactor token refresh handling");
    expect(lease?.repo_name).toBe("example");
    expect(lease?.branch).toBe("feature/tokens");
    expect(lease?.dirty).toBeTrue();
    expect(lease?.dirty_count).toBe(2);
    expect(lease?.dirty_paths).toEqual(["src/auth/token.ts", "tests/auth/token.test.ts"]);
    // Exclusive claims sort first so the strongest signal leads each card.
    expect(lease?.claims).toEqual([
      { path: "src/auth/token.ts", access: "exclusive" },
      { path: "tests/auth", access: "shared" },
    ]);
    // The renewal handle stays server-side even on a local read-only surface.
    expect(JSON.stringify(state)).not.toContain("lease-active");

    expect(state.event_count).toBe(3);
    expect(state.events_truncated).toBe(0);
    expect(state.events.map((event) => [event.event_type, event.status, event.agent_id])).toEqual([
      ["announced", "granted", "charlie"],
      ["announced", "granted", "alpha"],
      ["renewed", "blocked", "bravo"],
    ]);
    expect(state.events[0]).toMatchObject({
      agent_state: "done",
      summary: "Finished lifecycle support",
      client_surface: "codex-app",
      requested_scope_count: 0,
      granted_scope_count: 0,
      blocked_scope_count: 0,
      peer_count: 2,
    });
    expect(state.events[1]).toMatchObject({
      agent_state: "working",
      summary: "Refactor token refresh handling",
      client_surface: "t3-code",
      repo_name: "example",
      requested_scope_count: 2,
      granted_scope_count: 2,
      blocked_scope_count: 0,
      peer_count: 1,
    });
  });

  test("never writes to the database it reads", async () => {
    const dbPath = temporaryDatabasePath();
    const nowMs = Date.now();
    seedDatabase(dbPath, nowMs);
    const monitor = startTestMonitor(dbPath);

    await fetchState(monitor);

    const database = new Database(dbPath, { readonly: true });
    const rows = database.query("SELECT count(*) AS total FROM leases").get() as { total: number };
    expect(rows.total).toBe(2);
    const events = database.query("SELECT count(*) AS total FROM activity_events").get() as {
      total: number;
    };
    expect(events.total).toBe(4);
    database.close(false);
  });

  test("keeps presence available when an older v2 process has no activity table", async () => {
    const dbPath = temporaryDatabasePath();
    seedDatabase(dbPath, Date.now());
    const database = new Database(dbPath, { strict: true });
    database.exec("DROP TABLE activity_events");
    database.close(false);
    const monitor = startTestMonitor(dbPath);

    const state = await fetchState(monitor);
    expect(state.agent_count).toBe(1);
    expect(state.leases[0]?.agent_id).toBe("alpha");
    expect(state.event_count).toBe(0);
    expect(state.events).toEqual([]);
  });

  test("normalizes metadata-less v2 rows without hiding activity", async () => {
    const dbPath = temporaryDatabasePath();
    seedDatabase(dbPath, Date.now());
    const database = new Database(dbPath, { strict: true });
    database.exec("ALTER TABLE leases DROP COLUMN client_surface");
    database.exec("ALTER TABLE activity_events DROP COLUMN client_surface");
    database.exec("ALTER TABLE leases DROP COLUMN agent_state");
    database.exec("ALTER TABLE activity_events DROP COLUMN agent_state");
    database.close(false);
    const monitor = startTestMonitor(dbPath);

    const state = await fetchState(monitor);
    expect(state.leases[0]?.client_surface).toBe("unknown");
    expect(state.leases[0]?.agent_state).toBe("working");
    expect(state.event_count).toBe(3);
    expect(state.events.map((event) => event.client_surface)).toEqual(["unknown", "unknown", "unknown"]);
    expect(state.events.map((event) => event.agent_state)).toEqual(["working", "working", "working"]);
  });

  test("bounds the activity payload and reports older retained events", async () => {
    const dbPath = temporaryDatabasePath();
    const nowMs = Date.now();
    seedDatabase(dbPath, nowMs);
    const database = new Database(dbPath, { strict: true });
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 205
      )
      INSERT INTO activity_events (
        event_type, status, agent_id, agent_label, client_surface, agent_state, summary, repo_name, worktree_root,
        branch, requested_scope_count, granted_scope_count, blocked_scope_count,
        peer_count, created_at_ms
      )
      SELECT 'announced', 'granted', 'seed-' || value, 'Agent', 'unknown', 'working', 'work', 'example',
             '/code/example', 'main', 0, 0, 0, 0, ${nowMs} - 10000 - value
      FROM sequence;
    `);
    database.close(false);
    const monitor = startTestMonitor(dbPath);

    const state = await fetchState(monitor);
    expect(state.event_count).toBe(208);
    expect(state.events).toHaveLength(200);
    expect(state.events_truncated).toBe(8);
    expect(state.events[0]?.agent_id).toBe("charlie");
  });

  test("degrades to an empty payload when the database is unreadable", async () => {
    const dbPath = temporaryDatabasePath();
    await Bun.write(dbPath, "this is not a sqlite database");
    const monitor = startTestMonitor(dbPath);

    const state = await fetchState(monitor);
    expect(state.database_available).toBeFalse();
    expect(state.leases).toEqual([]);
  });

  test("serves the page and 404s everything else", async () => {
    const monitor = startTestMonitor(temporaryDatabasePath());

    const page = await fetch(monitor.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const uiVersion = page.headers.get("x-agent-frequency-ui-version");
    expect(uiVersion).toMatch(/^[a-f0-9]{16}$/);
    const html = await page.text();
    expect(html).toContain("<title>Agent Frequency</title>");
    expect(html).toContain(`var UI_VERSION = "${uiVersion}"`);
    expect(html).not.toContain("__AGENT_FREQUENCY_UI_VERSION__");
    expect(html).toContain('fetch(basePath + "api/state"');
    expect(html).not.toContain('fetch("/api/state"');
    expect(html).toContain("serverUiVersion !== UI_VERSION");
    expect(html).toContain("window.location.reload()");
    expect(html).toContain('var call = el("article", "activity-call")');
    expect(html).toContain('var bubble = el("div", "speech-bubble activity-bubble")');
    expect(html).toContain('var bubble = el("div", "speech-bubble agent-bubble")');
    expect(html).toContain('var details = el("details", "agent-details")');
    expect(html).toContain("focusedDetailsKey");
    expect(html).toContain("function surfaceLabel(surface)");
    expect(html).toContain("lease.client_surface");
    expect(html).toContain("surfaceLabel(event.client_surface)");
    expect(html).toContain("function completionIcon()");
    expect(html).toContain('event.agent_state === "done" ? completionIcon()');
    expect(html).toContain('call.setAttribute("data-state", event.agent_state === "done" ? "done" : "working")');
    expect(html).toContain('if (event.agent_state === "done") return "claims released"');
    expect(html).toContain('? "completed work"');
    expect(html).toContain('id="project-filter-select" aria-label="Filter agents by project"');
    expect(html).toContain('new URLSearchParams(window.location.search).get("repo")');
    expect(html).toContain("function visibleLeases(state)");
    expect(html).toContain('url.searchParams.set("repo", selectedRepo)');
    expect(html).not.toContain(".activity-bubble::before");
    // Repository names are untrusted, so grouping must not use a plain Object
    // where names such as "__proto__" resolve inherited properties.
    expect(html).toContain("var groups = new Map();");

    const stateResponse = await fetch(`${monitor.url}api/state`);
    expect(stateResponse.headers.get("x-agent-frequency-ui-version")).toBe(uiVersion);

    const missing = await fetch(`${monitor.url}nope`);
    expect(missing.status).toBe(404);
  });

  test("serves both root and /agents path forms", async () => {
    const monitor = startTestMonitor(temporaryDatabasePath());

    const mountedPage = await fetch(`${monitor.url}agents`);
    expect(mountedPage.status).toBe(200);
    expect(await mountedPage.text()).toContain("<title>Agent Frequency</title>");

    const mountedState = await fetch(`${monitor.url}agents/api/state`);
    expect(mountedState.status).toBe(200);
    expect((await mountedState.json()) as MonitorState).toMatchObject({
      database_available: false,
      leases: [],
      events: [],
    });
  });

  test("rejects non-loopback Host headers to block DNS rebinding", async () => {
    const monitor = startTestMonitor(temporaryDatabasePath());

    const rebound = await fetch(`${monitor.url}api/state`, {
      headers: { host: "evil.example.com" },
    });
    expect(rebound.status).toBe(403);

    // Tailscale Serve forwards the original tailnet Host when the monitor is
    // deliberately shared, so those must keep working.
    const tailnet = await fetch(`${monitor.url}api/state`, {
      headers: { host: "monitor.example.ts.net" },
    });
    expect(tailnet.status).toBe(200);
  });
});
