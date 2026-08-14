import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

import { Database } from "bun:sqlite";

import { normalizeClientSurface, type ClientSurface } from "./client-surface";
import { defaultDatabasePath } from "./store";
import { normalizeAgentState, type AgentState } from "./types";

const DEFAULT_PORT = 7893;
const MAX_MONITOR_EVENTS = 200;
const ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const UI_VERSION_HEADER = "x-agent-frequency-ui-version";
const UI_VERSION_PLACEHOLDER = "__AGENT_FREQUENCY_UI_VERSION__";
// Loopback only, and never configurable: the monitor renders peer-authored
// summaries and absolute worktree paths that must not leave this machine
// unless Fabrizio explicitly fronts it with something like Tailscale Serve.
const HOSTNAME = "127.0.0.1";

export type MonitorAccess = "shared" | "exclusive";

export interface MonitorClaim {
  path: string;
  access: MonitorAccess;
}

export interface MonitorLease {
  agent_id: string;
  agent_label: string;
  client_surface: ClientSurface;
  agent_state: AgentState;
  summary: string;
  repo_name: string;
  worktree_root: string;
  branch: string | null;
  head_oid: string | null;
  dirty: boolean | null;
  dirty_count: number | null;
  dirty_paths: string[];
  dirty_paths_truncated: number;
  metadata_complete: boolean;
  timebox_seconds: number | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  expires_at_ms: number;
  claims: MonitorClaim[];
}

export type MonitorEventType = "announced" | "renewed";
export type MonitorEventStatus = "granted" | "partial" | "blocked";

export interface MonitorEvent {
  event_id: number;
  event_type: MonitorEventType;
  status: MonitorEventStatus;
  agent_id: string;
  agent_label: string;
  client_surface: ClientSurface;
  agent_state: AgentState;
  summary: string;
  repo_name: string;
  worktree_root: string;
  branch: string | null;
  requested_scope_count: number;
  granted_scope_count: number;
  blocked_scope_count: number;
  peer_count: number;
  created_at_ms: number;
}

export interface MonitorState {
  now_ms: number;
  home_dir: string;
  database_available: boolean;
  schema_version: number | null;
  agent_count: number;
  leases: MonitorLease[];
  event_count: number;
  events_truncated: number;
  events: MonitorEvent[];
}

export interface MonitorOptions {
  port?: number;
  dbPath?: string;
}

export interface MonitorHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export function startMonitor(options: MonitorOptions = {}): MonitorHandle {
  const dbPath = options.dbPath ?? defaultDatabasePath();
  const server = Bun.serve({
    hostname: HOSTNAME,
    port: options.port ?? DEFAULT_PORT,
    fetch(request) {
      const { pathname, hostname } = new URL(request.url);
      // Loopback binding alone does not stop DNS rebinding: a hostile page can
      // rebind its own hostname to 127.0.0.1 and read /api/state cross-origin.
      // Accept only loopback Hosts plus tailnet hostnames, which Tailscale
      // Serve forwards unchanged when the monitor is deliberately shared.
      if (!isAllowedHost(hostname)) {
        return new Response("forbidden host", { status: 403, headers: baseHeaders() });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405, headers: baseHeaders() });
      }
      if (pathname === "/" || pathname === "/agents" || pathname === "/agents/") {
        const page = pageAsset();
        return new Response(page.html, {
          headers: {
            ...baseHeaders(),
            "content-type": "text/html; charset=utf-8",
            [UI_VERSION_HEADER]: page.version,
          },
        });
      }
      if (pathname === "/api/state" || pathname === "/agents/api/state") {
        return Response.json(readState(dbPath, Date.now()), {
          headers: { ...baseHeaders(), [UI_VERSION_HEADER]: pageAsset().version },
        });
      }
      return new Response("not found", { status: 404, headers: baseHeaders() });
    },
  });

  // Bun types `port` as optional because a server may bind a unix socket
  // instead; this one always binds a loopback TCP port.
  return {
    port: server.port ?? Number(server.url.port),
    url: server.url.href,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function isAllowedHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.toLowerCase().endsWith(".ts.net")
  );
}

function baseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // The page is fully self-contained; this blocks any accidental future
    // dependency on external assets and any exfiltration of peer data.
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  };
}

interface PageAsset {
  html: string;
  version: string;
  modifiedMs: number;
  size: number;
}

const pageUrl = new URL("./monitor.html", import.meta.url);
let cachedPage: PageAsset | null = null;

function pageAsset(): PageAsset {
  const stats = statSync(pageUrl);
  if (
    cachedPage === null ||
    cachedPage.modifiedMs !== stats.mtimeMs ||
    cachedPage.size !== stats.size
  ) {
    const source = readFileSync(pageUrl, "utf8");
    const version = createHash("sha256").update(source).digest("hex").slice(0, 16);
    cachedPage = {
      html: source.replace(UI_VERSION_PLACEHOLDER, version),
      version,
      modifiedMs: stats.mtimeMs,
      size: stats.size,
    };
  }
  return cachedPage;
}

/**
 * Reads a snapshot of active leases.
 *
 * The database is opened read-only per request so the monitor can never expire
 * or mutate a lease, and so it recovers on its own when the file is created,
 * replaced, or migrated by an announcing agent after the monitor started.
 * Every failure degrades to an empty-but-valid payload: an unreadable database
 * means "no traffic known", never a 500.
 */
export function readState(dbPath: string, nowMs: number): MonitorState {
  const empty: MonitorState = {
    now_ms: nowMs,
    home_dir: homedir(),
    database_available: false,
    schema_version: null,
    agent_count: 0,
    leases: [],
    event_count: 0,
    events_truncated: 0,
    events: [],
  };

  let database: Database | null = null;
  try {
    database = new Database(dbPath, { readonly: true });
    // Several tables make up one rendered poll. A deferred read transaction
    // pins one WAL snapshot without blocking announcing writers between reads.
    database.exec("BEGIN");
    try {
      const rows = database
        .query("SELECT * FROM leases WHERE expires_at_ms > ? ORDER BY updated_at_ms DESC")
        .all(nowMs) as Array<Record<string, unknown>>;
      const claims = readClaims(database, rows);
      const leases = rows.map((row) => toLease(row, claims));
      const activity = readEvents(database, nowMs);
      const state = {
        ...empty,
        database_available: true,
        schema_version: readSchemaVersion(database),
        agent_count: leases.length,
        leases,
        event_count: activity.total,
        events_truncated: activity.truncated,
        events: activity.events,
      };
      database.exec("COMMIT");
      return state;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch {
    return empty;
  } finally {
    database?.close(false);
  }
}

function readEvents(
  database: Database,
  nowMs: number,
): { total: number; truncated: number; events: MonitorEvent[] } {
  try {
    const cutoffMs = nowMs - ACTIVITY_RETENTION_MS;
    const surfaceColumn = hasColumn(database, "activity_events", "client_surface")
      ? "client_surface"
      : "'unknown' AS client_surface";
    const stateColumn = hasColumn(database, "activity_events", "agent_state")
      ? "agent_state"
      : "'working' AS agent_state";
    const rows = database
      .query(
        `SELECT event_id, event_type, status, agent_id, agent_label, ${surfaceColumn}, ${stateColumn}, summary,
                repo_name, worktree_root, branch, requested_scope_count,
                granted_scope_count, blocked_scope_count, peer_count, created_at_ms,
                count(*) OVER () AS total_count
         FROM activity_events
         WHERE created_at_ms >= ?
         ORDER BY created_at_ms DESC, event_id DESC
         LIMIT ?`,
      )
      .all(cutoffMs, MAX_MONITOR_EVENTS) as Array<Record<string, unknown>>;
    // One windowed query keeps the total and page internally consistent even
    // while another MCP process announces between monitor refreshes.
    const total = toNullableInteger(rows[0]?.total_count) ?? rows.length;
    return {
      total,
      truncated: Math.max(0, total - rows.length),
      events: rows.map(toEvent),
    };
  } catch {
    // The feed is a backward-compatible addition to schema v2. Monitors may
    // observe a database last touched by an older live MCP process, so the
    // absence of this optional table must not hide current presence.
    return { total: 0, truncated: 0, events: [] };
  }
}

function toEvent(row: Record<string, unknown>): MonitorEvent {
  return {
    event_id: toNullableInteger(row.event_id) ?? 0,
    event_type: row.event_type === "renewed" ? "renewed" : "announced",
    status: toEventStatus(row.status),
    agent_id: toText(row.agent_id),
    agent_label: toText(row.agent_label),
    client_surface: normalizeClientSurface(row.client_surface),
    agent_state: normalizeAgentState(row.agent_state),
    summary: toText(row.summary),
    repo_name: toText(row.repo_name),
    worktree_root: toText(row.worktree_root),
    branch: toNullableText(row.branch),
    requested_scope_count: toNullableInteger(row.requested_scope_count) ?? 0,
    granted_scope_count: toNullableInteger(row.granted_scope_count) ?? 0,
    blocked_scope_count: toNullableInteger(row.blocked_scope_count) ?? 0,
    peer_count: toNullableInteger(row.peer_count) ?? 0,
    created_at_ms: toNullableInteger(row.created_at_ms) ?? 0,
  };
}

function toEventStatus(value: unknown): MonitorEventStatus {
  if (value === "blocked" || value === "partial") return value;
  return "granted";
}

function readSchemaVersion(database: Database): number | null {
  try {
    const row = database.query("PRAGMA user_version").get() as { user_version?: unknown } | null;
    return toNullableInteger(row?.user_version);
  } catch {
    return null;
  }
}

function hasColumn(database: Database, table: string, column: string): boolean {
  const rows = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === column);
}

function readClaims(
  database: Database,
  rows: Array<Record<string, unknown>>,
): Map<string, MonitorClaim[]> {
  const byLease = new Map<string, MonitorClaim[]>();
  const leaseIds = rows.map((row) => toText(row.lease_id)).filter((id) => id.length > 0);
  if (leaseIds.length === 0) return byLease;

  try {
    const placeholders = leaseIds.map(() => "?").join(", ");
    const claimRows = database
      .query(
        `SELECT lease_id, path, access FROM claims
         WHERE lease_id IN (${placeholders})
         ORDER BY access ASC, path ASC`,
      )
      .all(...leaseIds) as Array<Record<string, unknown>>;
    for (const claimRow of claimRows) {
      const leaseId = toText(claimRow.lease_id);
      const claims = byLease.get(leaseId) ?? [];
      claims.push({ path: toText(claimRow.path), access: toAccess(claimRow.access) });
      byLease.set(leaseId, claims);
    }
  } catch {
    // A missing or renamed claims table still leaves useful presence data.
    return byLease;
  }
  return byLease;
}

function toLease(
  row: Record<string, unknown>,
  claimsByLease: Map<string, MonitorClaim[]>,
): MonitorLease {
  const dirtyPaths = toPathList(row.dirty_paths);
  const dirtyCount = toNullableInteger(row.dirty_count);
  return {
    // lease_id is deliberately absent from the payload: it is the renewal
    // handle for a lease, and the MCP surface already withholds it from peers.
    agent_id: toText(row.agent_id),
    agent_label: toText(row.agent_label),
    client_surface: normalizeClientSurface(row.client_surface),
    agent_state: normalizeAgentState(row.agent_state),
    summary: toText(row.summary),
    repo_name: toText(row.repo_name),
    worktree_root: toText(row.worktree_root),
    branch: toNullableText(row.branch),
    head_oid: toNullableText(row.head_oid),
    dirty: toNullableBoolean(row.dirty),
    dirty_count: dirtyCount,
    dirty_paths: dirtyPaths,
    // The store persists at most a bounded prefix of the dirty paths (see
    // MAX_DIRTY_PATHS in store.ts); dirty_count carries the true total.
    dirty_paths_truncated: Math.max(0, (dirtyCount ?? dirtyPaths.length) - dirtyPaths.length),
    metadata_complete: toNullableBoolean(row.metadata_complete) ?? true,
    timebox_seconds: toNullableInteger(row.timebox_seconds),
    created_at_ms: toNullableInteger(row.created_at_ms),
    updated_at_ms: toNullableInteger(row.updated_at_ms),
    expires_at_ms: toNullableInteger(row.expires_at_ms) ?? 0,
    claims: claimsByLease.get(toText(row.lease_id)) ?? [],
  };
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  return null;
}

function toNullableBoolean(value: unknown): boolean | null {
  const asInteger = toNullableInteger(value);
  return asInteger === null ? null : asInteger !== 0;
}

function toAccess(value: unknown): MonitorAccess {
  // Normalized rather than trusted, so a rogue value can never reach the page
  // as a style hook or an unexpected badge variant.
  return value === "exclusive" ? "exclusive" : "shared";
}

/**
 * `dirty_paths` is a JSON array added in schema v2, so it can be missing,
 * NULL, or unparseable in an older database. Every one of those degrades to
 * "no known dirty paths" instead of hiding the agent.
 */
function toPathList(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export function resolvePort(argv: readonly string[], env: Record<string, string | undefined>): number {
  const flagIndex = argv.findIndex((argument) => argument === "--port" || argument.startsWith("--port="));
  const flagValue =
    flagIndex === -1
      ? undefined
      : argv[flagIndex]?.startsWith("--port=")
        ? argv[flagIndex]?.slice("--port=".length)
        : argv[flagIndex + 1];
  const raw = flagValue ?? env.AGENT_FREQUENCY_MONITOR_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid monitor port: ${raw}`);
  }
  return port;
}

if (import.meta.main) {
  const monitor = startMonitor({ port: resolvePort(Bun.argv.slice(2), Bun.env) });
  console.log(`Agent Frequency monitor on ${monitor.url}`);
}
