import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  resolvePeers,
  startMonitor,
  type MonitorHandle,
  type MonitorOptions,
  type MonitorState,
} from "../src/monitor";

const monitors: MonitorHandle[] = [];
const temporaryDirectories: string[] = [];
const fakePeerServers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const monitor of monitors.splice(0)) await monitor.stop();
  for (const server of fakePeerServers.splice(0)) await server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-frequency-monitor-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite3");
}

function startTestMonitor(dbPath: string, options: Partial<MonitorOptions> = {}): MonitorHandle {
  // Port 0 lets the kernel pick a free port so concurrent test files cannot collide.
  const monitor = startMonitor({ port: 0, dbPath, ...options });
  monitors.push(monitor);
  return monitor;
}

/** Serves a fixed payload as if it were a peer monitor's /api/state. */
function startFakePeer(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  fakePeerServers.push(server);
  return server.url.href.replace(/\/$/, "");
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
    expect(typeof state.hostname).toBe("string");
    expect(state.hostname.length).toBeGreaterThan(0);
    expect(state.peers).toEqual([]);
  });

  test("prefers an explicit machine label over the system hostname", async () => {
    const previous = process.env.AGENT_FREQUENCY_MACHINE_LABEL;
    process.env.AGENT_FREQUENCY_MACHINE_LABEL = " mbp ";
    try {
      const monitor = startTestMonitor(temporaryDatabasePath());
      const state = await fetchState(monitor);
      // Trimmed and stripped of control characters: the label renders in the
      // monitor beside peer-reported names.
      expect(state.hostname).toBe("mbp");
    } finally {
      if (previous === undefined) delete process.env.AGENT_FREQUENCY_MACHINE_LABEL;
      else process.env.AGENT_FREQUENCY_MACHINE_LABEL = previous;
    }
  });

  test("falls back to the system hostname when the label override is blank", async () => {
    const previous = process.env.AGENT_FREQUENCY_MACHINE_LABEL;
    process.env.AGENT_FREQUENCY_MACHINE_LABEL = "   ";
    try {
      const monitor = startTestMonitor(temporaryDatabasePath());
      const state = await fetchState(monitor);
      expect(state.hostname.length).toBeGreaterThan(0);
      expect(state.hostname).not.toBe("   ");
    } finally {
      if (previous === undefined) delete process.env.AGENT_FREQUENCY_MACHINE_LABEL;
      else process.env.AGENT_FREQUENCY_MACHINE_LABEL = previous;
    }
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

  test("surfaces the additive task emoji on leases and activity", async () => {
    const dbPath = temporaryDatabasePath();
    seedDatabase(dbPath, Date.now());
    const database = new Database(dbPath, { strict: true });
    // seedDatabase writes the pre-emoji schema on purpose, so this mirrors the
    // store's additive upgrade arriving under a running monitor.
    database.exec("ALTER TABLE leases ADD COLUMN emoji TEXT");
    database.exec("ALTER TABLE activity_events ADD COLUMN emoji TEXT");
    database.exec("UPDATE leases SET emoji = '🐛' WHERE agent_id = 'alpha'");
    database.exec("UPDATE activity_events SET emoji = '🐛' WHERE agent_id = 'alpha'");
    database.close(false);
    const monitor = startTestMonitor(dbPath);

    const state = await fetchState(monitor);
    expect(state.leases[0]?.emoji).toBe("🐛");
    expect(state.events.some((event) => event.emoji === "🐛")).toBeTrue();
  });

  test("reports no emoji when the column predates this schema", async () => {
    const dbPath = temporaryDatabasePath();
    seedDatabase(dbPath, Date.now());
    const monitor = startTestMonitor(dbPath);

    const state = await fetchState(monitor);
    // An older MCP process never wrote the column; presence and the feed must
    // still render, simply without an emoji.
    expect(state.leases[0]?.emoji).toBeNull();
    expect(state.event_count).toBe(3);
    expect(state.events.every((event) => event.emoji === null)).toBeTrue();
  });

  test("reports the additive testing flag as a testing agent state", async () => {
    const dbPath = temporaryDatabasePath();
    seedDatabase(dbPath, Date.now());
    const database = new Database(dbPath, { strict: true });
    // Matches the store's additive upgrade: the v2 agent_state column stays as
    // it is and "testing" arrives as a flag alongside it.
    database.exec("ALTER TABLE leases ADD COLUMN testing INTEGER NOT NULL DEFAULT 0");
    database.exec("ALTER TABLE activity_events ADD COLUMN testing INTEGER NOT NULL DEFAULT 0");
    database.exec("UPDATE leases SET testing = 1 WHERE agent_id = 'alpha'");
    database.exec("UPDATE activity_events SET testing = 1 WHERE agent_id = 'alpha'");
    // Testing releases every exclusive claim, so a real testing lease holds
    // shared paths only.
    database.exec("UPDATE claims SET access = 'shared' WHERE lease_id = 'lease-active'");
    database.close(false);
    const monitor = startTestMonitor(dbPath);

    const state = await fetchState(monitor);
    expect(state.leases[0]?.agent_state).toBe("testing");
    expect(state.events.map((event) => event.agent_state)).toEqual(["done", "testing", "working"]);

    // An older process renewing that lease writes real claims without touching
    // the flag, and the claims are what count.
    const stale = new Database(dbPath, { strict: true });
    stale.exec(
      "UPDATE claims SET access = 'exclusive' WHERE lease_id = 'lease-active' AND path = 'src/auth/token.ts'",
    );
    stale.close(false);
    expect((await fetchState(monitor)).leases[0]?.agent_state).toBe("working");
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
    // The page is authored as monitor.html + monitor.css + monitor.js but must
    // ship as one self-contained document: both splice placeholders resolved,
    // stylesheet and client script inline.
    expect(html).not.toContain("__AGENT_FREQUENCY_STYLE__");
    expect(html).not.toContain("__AGENT_FREQUENCY_SCRIPT__");
    expect(html).toContain(".speech-bubble {");
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
    // The host app and the machine render as one chip, and every feed builds it
    // through the same helper so identity reads the same way everywhere.
    expect(html).toContain("function originChip(clientSurface, machine)");
    expect(html).toContain("originChip(event.client_surface, entry.machine)");
    expect(html).toContain("originChip(newest.client_surface, newest.machine)");
    expect(html).toContain('el("span", "origin-machine", machine)');
    // Session id and lease countdown read as chips beside the origin chip, so
    // the byline is one row of uniform, quiet facts.
    expect(html).toContain("function sessionChip(agentId, agentLabel)");
    expect(html).toContain('el("span", "chip session-chip mono", shortAgentId(agentId, agentLabel))');
    expect(html).toContain('var expiry = el("span", "chip expiry-chip")');
    expect(html).toContain("expiry.title = expiryTitle(lease)");
    // A lease outlives a crashed agent, so a long check-in gap is marked rather
    // than left for the reader to compute, and it is recomputed on the clock.
    expect(html).toContain("function staleAfterMs(lease)");
    expect(html).toContain('trackTime(updated, "age", lease.updated_at_ms, staleAfterMs(lease))');
    expect(html).toContain('entry.node.classList.toggle("stale", stale)');
    expect(html).toContain("timeNodes.forEach(applyTime)");
    // Traffic from this machine carries its own label once peers make the
    // machine a real distinction, so an absent label never means "local".
    expect(html).toContain("function localMachineName(state)");
    expect(html).toContain("entries.push({ lease: lease, machine: local, homeDir: state.home_dir })");
    expect(html).toContain("function completionIcon(className)");
    expect(html).toContain('event.agent_state === "done" ? completionIcon()');
    expect(html).toContain('call.setAttribute("data-state", event.agent_state === "done" ? "done" : "working")');
    expect(html).toContain('if (event.agent_state === "done") return "claims released"');
    expect(html).toContain('? "completed work"');
    // A testing agent is live but holds nothing, so its card must say so
    // instead of reading like an ordinary set of claims.
    expect(html).toContain('var testing = lease.agent_state === "testing"');
    expect(html).toContain('meta.appendChild(el("span", "agent-state", "testing"))');
    expect(html).toContain('el("span", null, "not blocking")');
    expect(html).toContain('testing ? "Scopes under test" : "Claimed scopes"');
    expect(html).toContain('if (event.agent_state === "testing") return "verifying, claims released"');
    expect(html).toContain('? "started testing"');
    expect(html).toContain(
      'id="project-filter-select" aria-label="Filter agents by project or machine"',
    );
    expect(html).toContain('new URLSearchParams(window.location.search).get("machine")');
    expect(html).toContain("function matchesFilter(state, repo, machine)");
    expect(html).toContain('machineGroup.label = "Machines"');
    // Re-renders must not let the browser clamp the scroll position while the
    // page is momentarily empty.
    expect(html).toContain("window.scrollTo(scrollX, scrollY)");
    expect(html).toContain('new URLSearchParams(window.location.search).get("repo")');
    expect(html).toContain("function visibleLeases(state)");
    expect(html).toContain('url.searchParams.set("repo", selectedRepo)');
    expect(html).not.toContain(".activity-bubble::before");
    // Repository names are untrusted, so grouping must not use a plain Object
    // where names such as "__proto__" resolve inherited properties.
    expect(html).toContain("var groups = new Map();");
    // Past work is rolled up from the activity feed in the page, so the monitor
    // keeps serving exactly one bounded read-only payload.
    expect(html).toContain("function recentTasks(state)");
    // Finished tasks render inside their project's section instead of a
    // separate feed, bounded per project and by a recency window.
    expect(html).toContain("function renderRecentTasks(section, tasks)");
    expect(html).toContain("function groupTasksByRepo(tasks)");
    expect(html).toContain('el("p", "recent-label", "Recent")');
    expect(html).toContain("list.length < MAX_PROJECT_RECENT_TASKS");
    expect(html).toContain("task.ended_at_ms >= cutoff");
    expect(html).not.toContain("renderRecentWork");
    // One session's finished tasks share a head, so the summaries stay scannable.
    expect(html).toContain("function groupTasksBySession(tasks)");
    // A finished run closes on its "done" call; a session that is still live
    // stays out of past work because its own card already shows it.
    expect(html).toContain('if (event.agent_state === "done") {');
    expect(html).toContain("if (!active.has(key)) tasks.push(task);");

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

  test("parses peer URLs from flags and environment", () => {
    expect(resolvePeers([], {})).toEqual([]);
    expect(resolvePeers([], { AGENT_FREQUENCY_MONITOR_PEERS: "" })).toEqual([]);
    expect(
      resolvePeers([], {
        AGENT_FREQUENCY_MONITOR_PEERS:
          " https://mba.tailnet.ts.net/agents/ , http://127.0.0.1:7894, https://mba.tailnet.ts.net/agents",
      }),
    ).toEqual(["https://mba.tailnet.ts.net/agents", "http://127.0.0.1:7894"]);
    // Flags take precedence over the environment, mirroring resolvePort.
    expect(
      resolvePeers(["--peer", "http://127.0.0.1:1234", "--peer=http://127.0.0.1:5678/"], {
        AGENT_FREQUENCY_MONITOR_PEERS: "http://127.0.0.1:9999",
      }),
    ).toEqual(["http://127.0.0.1:1234", "http://127.0.0.1:5678"]);
    expect(() => resolvePeers(["--peer", "not a url"], {})).toThrow("Invalid monitor peer URL");
    expect(() => resolvePeers(["--peer", "file:///etc/passwd"], {})).toThrow("http(s)");
  });

  test("aggregates a reachable peer monitor into the state payload", async () => {
    const peerDbPath = temporaryDatabasePath();
    seedDatabase(peerDbPath, Date.now());
    const peerMonitor = startTestMonitor(peerDbPath);

    const localMonitor = startTestMonitor(temporaryDatabasePath(), {
      peers: [peerMonitor.url.replace(/\/$/, "")],
    });
    const state = await fetchState(localMonitor);

    expect(state.leases).toEqual([]);
    expect(state.peers).toHaveLength(1);
    const peer = state.peers[0];
    expect(peer?.reachable).toBeTrue();
    expect(peer?.error).toBeNull();
    expect(typeof peer?.hostname).toBe("string");
    expect(peer?.snapshot?.database_available).toBeTrue();
    expect(peer?.snapshot?.agent_count).toBe(1);
    expect(peer?.snapshot?.leases[0]?.agent_id).toBe("alpha");
    expect(peer?.snapshot?.leases[0]?.claims).toEqual([
      { path: "src/auth/token.ts", access: "exclusive" },
      { path: "tests/auth", access: "shared" },
    ]);
    expect(peer?.snapshot?.leases[0]?.expires_at_ms).toBeGreaterThan(Date.now());
    expect(peer?.snapshot?.events).toHaveLength(3);
    expect(typeof peer?.snapshot?.home_dir).toBe("string");
    // Aggregation is one level deep: the peer's own peers array must not nest.
    expect(peer?.snapshot && "peers" in peer.snapshot).toBeFalse();
    // Lease renewal handles must not leak through federation either.
    expect(JSON.stringify(state)).not.toContain("lease-active");
  });

  test("carries a testing agent on another machine through federation", async () => {
    const peerDbPath = temporaryDatabasePath();
    seedDatabase(peerDbPath, Date.now());
    const peerDatabase = new Database(peerDbPath, { strict: true });
    peerDatabase.exec("ALTER TABLE leases ADD COLUMN testing INTEGER NOT NULL DEFAULT 0");
    peerDatabase.exec("UPDATE leases SET testing = 1 WHERE agent_id = 'alpha'");
    peerDatabase.exec("UPDATE claims SET access = 'shared' WHERE lease_id = 'lease-active'");
    peerDatabase.close(false);
    const peerMonitor = startTestMonitor(peerDbPath);

    const localMonitor = startTestMonitor(temporaryDatabasePath(), {
      peers: [peerMonitor.url.replace(/\/$/, "")],
    });
    const state = await fetchState(localMonitor);

    // The peer resolves the flag before sending, so the receiving side only has
    // to accept "testing" as a state it already knows.
    expect(state.peers[0]?.snapshot?.leases[0]?.agent_state).toBe("testing");
  });

  test("degrades an unreachable peer to a marked entry without breaking local state", async () => {
    const dbPath = temporaryDatabasePath();
    seedDatabase(dbPath, Date.now());
    // Nothing listens on the peer port; startFakePeer picks a real port and
    // stops it immediately so the address is guaranteed dead.
    const deadUrl = startFakePeer(() => new Response("never"));
    await fakePeerServers.pop()?.stop(true);

    const monitor = startTestMonitor(dbPath, { peers: [deadUrl] });
    const state = await fetchState(monitor);

    expect(state.agent_count).toBe(1);
    expect(state.peers[0]).toMatchObject({
      url: deadUrl,
      hostname: null,
      reachable: false,
      error: "unreachable",
      snapshot: null,
    });
  });

  test("classifies peer HTTP errors, invalid payloads, and timeouts", async () => {
    const errorUrl = startFakePeer(() => new Response("boom", { status: 500 }));
    const garbageUrl = startFakePeer(() => new Response("not json"));
    const slowUrl = startFakePeer(async () => {
      await Bun.sleep(2_000);
      return Response.json({});
    });

    const monitor = startTestMonitor(temporaryDatabasePath(), {
      peers: [errorUrl, garbageUrl, slowUrl],
      peerTimeoutMs: 150,
    });
    const state = await fetchState(monitor);

    expect(state.peers.map((peer) => peer.error)).toEqual([
      "http_error",
      "invalid_payload",
      "timeout",
    ]);
    expect(state.peers.every((peer) => peer.snapshot === null)).toBeTrue();
  });

  test("bounds and sanitizes hostile peer payloads", async () => {
    const nowMs = Date.now();
    const hostileLease = (index: number, overrides: Record<string, unknown> = {}) => ({
      agent_id: "agent-" + index,
      agent_label: "Agent",
      client_surface: "made-up-surface",
      agent_state: "working",
      // Long but under the total-body cap even times 252 leases; the per-field
      // bound must still truncate it.
      summary: "s".repeat(1_000),
      // A peer monitor can claim anything is an "emoji"; only a real single
      // emoji may reach the page.
      emoji: "NOT AN EMOJI, JUST A BANNER",
      repo_name: "repo-\u202edoc.txt",
      worktree_root: "/peer/code",
      branch: null,
      head_oid: null,
      dirty: "yes",
      dirty_count: 3,
      dirty_paths: Array.from({ length: 100 }, (_, i) => "path-" + i),
      metadata_complete: true,
      timebox_seconds: 900,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
      expires_at_ms: nowMs + 60_000,
      claims: [
        { path: "ok", access: "root" },
        { path: "", access: "exclusive" },
      ],
      ...overrides,
    });
    const hostileUrl = startFakePeer(() =>
      Response.json({
        now_ms: nowMs,
        hostname: "evil\u202ehost",
        home_dir: "/home/peer",
        database_available: true,
        schema_version: 2,
        agent_count: 999,
        leases: [
          // Special rows first: the 200-item cap slices before sanitizing.
          hostileLease(999, { expires_at_ms: nowMs - 1 }),
          hostileLease(1000, { expires_at_ms: nowMs + 365 * 24 * 60 * 60 * 1_000 }),
          ...Array.from({ length: 250 }, (_, index) => hostileLease(index)),
        ],
        event_count: 10_000,
        events_truncated: 0,
        events: [
          { created_at_ms: nowMs, summary: "e", emoji: "‮🐛", status: "weird", event_type: "renewed" },
        ],
        peers: [{ url: "http://should-not-nest" }],
      }),
    );

    const monitor = startTestMonitor(temporaryDatabasePath(), { peers: [hostileUrl] });
    const state = await fetchState(monitor);
    const snapshot = state.peers[0]?.snapshot;

    expect(state.peers[0]?.reachable).toBeTrue();
    // Directional-formatting characters are stripped from every text field.
    expect(state.peers[0]?.hostname).toBe("evil host");
    // 200 rows survive the cap; the already-expired one is then dropped.
    expect(snapshot?.leases.length).toBe(199);
    expect(snapshot?.agent_count).toBe(199);
    expect(snapshot?.leases.some((entry) => entry.agent_id === "agent-999")).toBeFalse();
    const lease = snapshot?.leases[0];
    expect(lease?.summary.length).toBe(200);
    expect(lease?.emoji).toBeNull();
    expect(lease?.repo_name).toBe("repo- doc.txt");
    expect(lease?.client_surface).toBe("unknown");
    expect(lease?.dirty).toBeNull();
    expect(lease?.dirty_paths.length).toBe(40);
    expect(lease?.claims).toEqual([{ path: "ok", access: "shared" }]);
    // A far-future expiry is clamped instead of pinning the card for a year.
    const clampedLease = snapshot?.leases.find((entry) => entry.agent_id === "agent-1000");
    expect(clampedLease?.expires_at_ms).toBeLessThanOrEqual(Date.now() + 3 * 60 * 60 * 1_000);
    expect(snapshot?.events[0]?.status).toBe("granted");
    expect(snapshot?.events[0]?.emoji).toBeNull();
    expect(snapshot?.event_count).toBe(10_000);
    expect(snapshot?.events_truncated).toBe(9_999);
    expect(JSON.stringify(state)).not.toContain("should-not-nest");
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
