import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { Database } from "bun:sqlite";

import type { ClientSurface } from "./client-surface";
import { sanitizeSummary } from "./coordinate";
import { sanitizeEmoji } from "./emoji";
import { AgentFrequencyStore, defaultDatabasePath } from "./store";
import type { AgentState, GitMetadata, Scope, StoreAnnounceRequest, Timebox } from "./types";

/**
 * Development-only traffic generator for the monitor UI.
 *
 * Real traffic on one machine is thin and slow to reproduce, so designing the
 * monitor means waiting for other agents to happen to announce. This replays a
 * fixed fixture timeline through the normal store API instead, which keeps demo
 * rows indistinguishable in shape from real ones while staying trivially
 * reversible.
 *
 * Two properties keep this safe to point at the live database:
 *
 * - Demo rows carry synthetic project, clone, and worktree IDs, so every real
 *   agent sees them as `other_project`. Arbitration skips unrelated projects,
 *   so a demo claim can never block, warn about, or otherwise interfere with
 *   real work.
 * - Every demo row is identifiable by both a marked agent ID and a worktree
 *   path under the demo root, so `clearDemoTraffic` removes exactly what was
 *   seeded. Leases also carry short timeboxes and expire on their own.
 */

// Two independent markers, and removal requires both. Either one alone could in
// principle match a real row (an unlucky client name, a real repo cloned into
// the demo root); together they cannot plausibly do so by accident.
const DEMO_ID_MARKER = " DEMO";
const DEMO_DIRNAME = "agent-frequency-demo";

export function demoRoot(home: string = homedir()): string {
  return `${home}/${DEMO_DIRNAME}`;
}

export interface DemoCounts {
  leases: number;
  events: number;
}

interface DemoWorktree {
  /** Shared by clones of the same upstream project, as a real origin URL would be. */
  project: string;
  /** Shared by linked worktrees of one clone. */
  clone: string;
  repo: string;
  /** Path relative to the demo root. */
  path: string;
  branch: string | null;
  dirty: boolean | null;
  dirtyPaths: string[];
  /** Set above dirtyPaths.length to exercise the truncated-paths rendering. */
  dirtyCount?: number;
  metadataComplete?: boolean;
}

interface DemoAgent {
  label: string;
  surface: ClientSurface;
  worktree: string;
}

interface DemoAnnouncement {
  agent: string;
  /** Minutes before the seed instant; live leases stay inside their timebox. */
  minutesAgo: number;
  summary: string;
  /** The task emoji a real agent would announce; omitted on some rows so the
   *  monitor keeps exercising the no-emoji layout. */
  emoji?: string;
  scopes?: Scope[];
  timebox?: Timebox;
  state?: AgentState;
  /** Reuse this agent's previous lease so the feed shows a renewal. */
  renew?: boolean;
}

const WORKTREES: Record<string, DemoWorktree> = {
  "acme-web": {
    project: "acme-web",
    clone: "acme-web",
    repo: "acme-web",
    path: "acme-web",
    branch: "main",
    dirty: true,
    dirtyPaths: [
      "src/app/checkout/page.tsx",
      "src/billing/invoice.ts",
      "src/components/ui/button.tsx",
    ],
    dirtyCount: 11,
  },
  "acme-web-billing": {
    project: "acme-web",
    clone: "acme-web",
    repo: "acme-web",
    path: "acme-web-worktrees/feat-billing",
    branch: "feat/billing",
    dirty: true,
    dirtyPaths: ["src/billing/pdf.ts", "tests/billing.test.ts"],
  },
  "acme-api": {
    project: "acme-api",
    clone: "acme-api",
    repo: "acme-api",
    path: "acme-api",
    branch: "main",
    dirty: false,
    dirtyPaths: [],
  },
  "acme-api-ratelimit": {
    project: "acme-api",
    clone: "acme-api",
    repo: "acme-api",
    path: "acme-api-worktrees/fix-rate-limit",
    branch: "fix/rate-limit",
    dirty: true,
    dirtyPaths: ["src/limits/buckets.ts", "src/limits/index.ts", "tests/limits.test.ts"],
  },
  "pixel-notes": {
    project: "pixel-notes",
    clone: "pixel-notes",
    repo: "pixel-notes",
    path: "pixel-notes",
    branch: "main",
    dirty: true,
    dirtyPaths: ["app/editor/toolbar.tsx"],
  },
  // A second clone of the same project: same_project without same_clone.
  "pixel-notes-fork": {
    project: "pixel-notes",
    clone: "pixel-notes-fork",
    repo: "pixel-notes",
    path: "forks/pixel-notes",
    branch: null,
    dirty: null,
    dirtyPaths: [],
    metadataComplete: false,
  },
  infra: {
    project: "infra",
    clone: "infra",
    repo: "infra-terraform",
    path: "infra-terraform",
    branch: "main",
    dirty: false,
    dirtyPaths: [],
  },
};

const AGENTS: Record<string, DemoAgent> = {
  ada: { label: "Claude", surface: "t3-code", worktree: "acme-web" },
  bo: { label: "Codex", surface: "codex-app", worktree: "acme-web" },
  cyd: { label: "Claude", surface: "claude-app", worktree: "acme-web-billing" },
  dex: { label: "Codex", surface: "cli", worktree: "acme-api" },
  eve: { label: "Claude", surface: "t3-code", worktree: "acme-api-ratelimit" },
  // Neither Claude nor Codex, so the monitor falls back to its generic icon.
  fin: { label: "Cursor", surface: "unknown", worktree: "pixel-notes" },
  gus: { label: "Gemini", surface: "cli", worktree: "infra" },
  hana: { label: "Codex", surface: "t3-code", worktree: "pixel-notes-fork" },
};

/**
 * Ordered oldest-first. Anything older than its timebox survives only as an
 * activity event, which is what makes the feed look lived-in while presence
 * stays small.
 */
const TIMELINE: DemoAnnouncement[] = [
  {
    agent: "dex",
    minutesAgo: 170,
    summary: "Extend the rate limiter with per-token buckets",
    emoji: "🚦",
    scopes: [{ path: "src/limits", access: "exclusive" }],
    timebox: "1h",
  },
  {
    agent: "eve",
    minutesAgo: 152,
    summary: "Backfill rate limit regression tests",
    emoji: "🧪",
    scopes: [{ path: "tests/limits.test.ts", access: "exclusive" }],
    timebox: "30m",
  },
  { agent: "eve", minutesAgo: 138, summary: "Rate limit tests landed", emoji: "✅", state: "done" },
  {
    agent: "gus",
    minutesAgo: 96,
    summary: "Bump the Terraform provider lockfile across every stack",
    emoji: "📦",
    scopes: [{ path: ".", access: "exclusive" }],
    timebox: "30m",
  },
  {
    agent: "fin",
    minutesAgo: 74,
    summary: "Read through the editor toolbar before touching anything",
    emoji: "👀",
    timebox: "15m",
  },
  {
    agent: "bo",
    minutesAgo: 58,
    summary: "Refactor the checkout summary rendering",
    emoji: "🧹",
    scopes: [{ path: "src/app/checkout", access: "shared" }],
    timebox: "30m",
  },
  { agent: "dex", minutesAgo: 41, summary: "Per-token buckets shipped", emoji: "🚀", state: "done" },
  {
    agent: "ada",
    minutesAgo: 25,
    summary: "Rework invoice totals and the checkout summary they feed",
    emoji: "🧾",
    scopes: [
      { path: "src/app/checkout", access: "shared" },
      { path: "src/billing", access: "exclusive" },
    ],
    timebox: "2h",
  },
  // Same worktree as ada, and asks for the same exclusive path: one scope is
  // granted and one is blocked, so the feed carries a `partial` announcement.
  // No emoji here on purpose: the monitor must stay tidy without one.
  {
    agent: "bo",
    minutesAgo: 22,
    summary: "Wire the checkout summary to the new invoice totals",
    scopes: [
      { path: "src/app/checkout", access: "shared" },
      { path: "src/billing/invoice.ts", access: "exclusive" },
    ],
    timebox: "1h",
  },
  {
    agent: "cyd",
    minutesAgo: 18,
    summary: "Add PDF export to the billing worktree",
    emoji: "📄",
    scopes: [{ path: "src/billing/pdf.ts", access: "exclusive" }],
    timebox: "1h",
  },
  {
    agent: "hana",
    minutesAgo: 14,
    summary: "Migrate note storage to SQLite in a detached checkout",
    emoji: "🗄️",
    scopes: [{ path: "app/storage", access: "exclusive" }],
    timebox: "30m",
  },
  // Deliberately awkward text: the monitor must render peer summaries as inert
  // data, never as markup or instructions.
  {
    agent: "fin",
    minutesAgo: 9,
    summary: 'Escape <script> tags & "quoted" paths in the note parser',
    emoji: "🛡️",
    scopes: [{ path: "app/editor", access: "shared" }],
    timebox: "2h",
  },
  {
    agent: "ada",
    minutesAgo: 6,
    summary: "Rework invoice totals, now including PDF export",
    emoji: "🧾",
    scopes: [
      { path: "src/app/checkout", access: "shared" },
      { path: "src/billing", access: "exclusive" },
    ],
    timebox: "2h",
    renew: true,
  },
  // The verification phase: fin keeps its lease and its paths on the board but
  // stops claiming them, so the monitor has a testing agent to render.
  {
    agent: "fin",
    minutesAgo: 4,
    summary: "Run the note parser suite before handing the editor back",
    emoji: "🧪",
    scopes: [{ path: "app/editor", access: "shared" }],
    timebox: "2h",
    state: "testing",
    renew: true,
  },
  {
    agent: "gus",
    minutesAgo: 3,
    summary: "Roll the provider bump back out one stack at a time",
    emoji: "🔁",
    scopes: [{ path: "stacks/prod", access: "exclusive" }],
    timebox: "15m",
  },
  {
    agent: "dex",
    minutesAgo: 1,
    summary: "Trace a flaky auth test before changing anything",
    emoji: "🐛",
    timebox: "1h",
  },
];

export interface SeedOptions {
  nowMs?: number;
  home?: string;
}

export interface SeedResult {
  announcements: number;
  agents: number;
  liveLeases: number;
}

/** Replays the fixture timeline through the normal announce path. */
export function seedDemoTraffic(store: AgentFrequencyStore, options: SeedOptions = {}): SeedResult {
  const nowMs = options.nowMs ?? Date.now();
  const home = options.home ?? homedir();
  const leaseIds = new Map<string, string>();
  // Each fixture agent stays in one worktree, so its latest announcement
  // supersedes its previous lease; only the last expiry per agent can be live.
  const expiries = new Map<string, number>();

  for (const entry of TIMELINE) {
    const agent = AGENTS[entry.agent];
    if (!agent) throw new Error(`Unknown demo agent: ${entry.agent}`);
    const worktree = WORKTREES[agent.worktree];
    if (!worktree) throw new Error(`Unknown demo worktree: ${agent.worktree}`);

    const result = store.announce({
      agentId: demoAgentId(entry.agent, agent.label),
      agentLabel: agent.label,
      clientSurface: agent.surface,
      state: entry.state ?? "working",
      trafficScope: "worktree",
      // Demo summaries go through the same validation as real ones so the
      // fixtures can never render something a real announcement could not.
      summary: sanitizeSummary(entry.summary),
      emoji: sanitizeEmoji(entry.emoji),
      metadata: demoMetadata(worktree, home),
      scopes: entry.scopes ?? [],
      timebox: entry.timebox ?? "1h",
      leaseId: entry.renew ? leaseIds.get(entry.agent) : undefined,
      nowMs: nowMs - entry.minutesAgo * 60_000,
    });

    if (result.self.lease_id && result.self.expires_at !== null) {
      leaseIds.set(entry.agent, result.self.lease_id);
      expiries.set(entry.agent, Date.parse(result.self.expires_at));
    } else {
      leaseIds.delete(entry.agent);
      expiries.delete(entry.agent);
    }
  }

  return {
    announcements: TIMELINE.length,
    agents: new Set(TIMELINE.map((entry) => entry.agent)).size,
    liveLeases: [...expiries.values()].filter((expiresAtMs) => expiresAtMs > nowMs).length,
  };
}

/** Removes every demo lease, claim, and activity event. Real rows are untouched. */
export function clearDemoTraffic(dbPath: string, home: string = homedir()): DemoCounts {
  return withDemoDatabase(dbPath, (database, predicate, parameters) => {
    database
      .query(`DELETE FROM claims WHERE lease_id IN (SELECT lease_id FROM leases WHERE ${predicate})`)
      .run(...parameters);
    const leases = database.query(`DELETE FROM leases WHERE ${predicate}`).run(...parameters).changes;
    const events = countable(() =>
      database.query(`DELETE FROM activity_events WHERE ${predicate}`).run(...parameters).changes,
    );
    return { leases, events };
  }, home) ?? { leases: 0, events: 0 };
}

/** Counts demo rows currently in the database, including expired leases. */
export function readDemoCounts(dbPath: string, home: string = homedir()): DemoCounts {
  return withDemoDatabase(dbPath, (database, predicate, parameters) => {
    const leases = countRows(database, `SELECT count(*) AS total FROM leases WHERE ${predicate}`, parameters);
    const events = countable(() =>
      countRows(database, `SELECT count(*) AS total FROM activity_events WHERE ${predicate}`, parameters),
    );
    return { leases, events };
  }, home) ?? { leases: 0, events: 0 };
}

function withDemoDatabase<T>(
  dbPath: string,
  operation: (database: Database, predicate: string, parameters: Array<string | number>) => T,
  home: string,
): T | null {
  let database: Database;
  try {
    database = new Database(dbPath, { create: false, strict: true });
    // An absent file or an unwritten schema both mean "no demo rows", which is
    // a valid answer for clearing and counting alike.
    const hasLeases = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leases'")
      .get();
    if (!hasLeases) {
      database.close(false);
      return null;
    }
  } catch {
    return null;
  }

  const prefix = `${demoRoot(home)}/`;
  const predicate = "instr(agent_id, ?) > 0 AND substr(worktree_root, 1, ?) = ?";
  const parameters = [DEMO_ID_MARKER, prefix.length, prefix];

  try {
    database.exec("PRAGMA busy_timeout = 1000");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database, predicate, parameters);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close(false);
  }
}

/** Activity events are an additive table; an older database may not have it. */
function countable(operation: () => number): number {
  try {
    return operation();
  } catch {
    return 0;
  }
}

function countRows(database: Database, sql: string, parameters: Array<string | number>): number {
  const row = database.query(sql).get(...parameters) as { total?: number } | null;
  return row?.total ?? 0;
}

function demoMetadata(worktree: DemoWorktree, home: string): GitMetadata {
  const worktreeRoot = `${demoRoot(home)}/${worktree.path}`;
  return {
    projectId: `demo-project-${worktree.project}`,
    localRepoId: `demo-clone-${worktree.clone}`,
    repoName: worktree.repo,
    worktreeId: `demo-worktree-${worktree.path}`,
    worktreeRoot,
    gitDir: `${worktreeRoot}/.git`,
    gitCommonDir: `${worktreeRoot}/.git`,
    branch: worktree.branch,
    headOid: digest(`oid:${worktree.path}`, 40),
    ignoreCase: true,
    origin: `git@example.invalid:demo/${worktree.repo}.git`,
    dirty: worktree.dirty,
    dirtyCount: worktree.dirty === null ? null : worktree.dirtyCount ?? worktree.dirtyPaths.length,
    dirtyPaths: worktree.dirtyPaths,
    metadataComplete: worktree.metadataComplete ?? true,
  };
}

/**
 * Mirrors the real `<label> <session>` shape so the monitor renders demo agents
 * normally, while the DEMO session prefix stays visible and greppable.
 */
function demoAgentId(key: string, label: string): string {
  return `${label}${DEMO_ID_MARKER}${digest(`agent:${key}`, 8).toUpperCase()}`;
}

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function resolveDbPath(argv: readonly string[]): string {
  const index = argv.findIndex((argument) => argument === "--db" || argument.startsWith("--db="));
  if (index === -1) return defaultDatabasePath();
  const value = argv[index]?.startsWith("--db=") ? argv[index]?.slice("--db=".length) : argv[index + 1];
  if (!value) throw new Error("--db requires a path");
  return value;
}

const USAGE = `Usage: agent-frequency-demo <seed|clear|status> [--db <path>]

  seed    replace any existing demo traffic with the fixture timeline
  clear   remove every demo lease, claim, and activity event
  status  count the demo rows currently in the database`;

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const command = argv.find((argument) => !argument.startsWith("--")) ?? "seed";
  const dbPath = resolveDbPath(argv);

  if (command === "status") {
    const counts = readDemoCounts(dbPath);
    console.log(`${counts.leases} demo lease(s), ${counts.events} demo event(s) in ${dbPath}`);
  } else if (command === "clear") {
    const counts = clearDemoTraffic(dbPath);
    console.log(`Cleared ${counts.leases} demo lease(s) and ${counts.events} demo event(s) from ${dbPath}`);
  } else if (command === "seed") {
    // Reseeding is meant to be repeatable, and events would otherwise stack up.
    clearDemoTraffic(dbPath);
    const store = new AgentFrequencyStore({ dbPath });
    try {
      const result = seedDemoTraffic(store);
      console.log(
        `Seeded ${result.announcements} demo announcement(s) from ${result.agents} agent(s), `
          + `${result.liveLeases} still active, into ${dbPath}`,
      );
      console.log("Remove them with: bin/agent-frequency-demo clear");
    } finally {
      store.close();
    }
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
