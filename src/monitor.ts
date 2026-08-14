import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";

import { Database } from "bun:sqlite";

import { normalizeClientSurface, type ClientSurface } from "./client-surface";
import { sanitizeEmoji } from "./emoji";
import { defaultDatabasePath } from "./store";
import {
  agentStateFromLease,
  agentStateFromRow,
  normalizeAgentState,
  type AgentState,
} from "./types";

const DEFAULT_PORT = 7893;
const MAX_MONITOR_EVENTS = 200;
const ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const UI_VERSION_HEADER = "x-agent-frequency-ui-version";
const UI_VERSION_PLACEHOLDER = "__AGENT_FREQUENCY_UI_VERSION__";
// Loopback only, and never configurable: the monitor renders peer-authored
// summaries and absolute worktree paths that must not leave this machine
// unless Fabrizio explicitly fronts it with something like Tailscale Serve.
const HOSTNAME = "127.0.0.1";

// Optional peer aggregation: this monitor can merge read-only snapshots from
// other machines' monitors (typically their Tailscale Serve URLs) into its own
// state payload. Peers are outbound reads only — the local listener stays
// loopback-bound, and peer data never reaches announce arbitration.
const MAX_PEERS = 8;
const DEFAULT_PEER_TIMEOUT_MS = 1_500;
const MAX_PEER_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PEER_LEASES = 200;
const MAX_PEER_CLAIMS = 64;
// Matches MAX_DIRTY_PATHS in store.ts: an honest peer never sends more.
const MAX_PEER_DIRTY_PATHS = 40;
// Local leases can never expire more than the 2h timebox bucket ahead; allow
// peer clocks an extra hour of slack before clamping their expiries.
const MAX_PEER_EXPIRY_AHEAD_MS = 3 * 60 * 60 * 1_000;

// Same control/directional-formatting defense as coordinate.ts and scopes.ts:
// peer monitor payloads carry peer-authored text that never went through this
// machine's announce validation.
const UNSAFE_FORMATTING = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

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
  emoji: string | null;
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
  emoji: string | null;
  repo_name: string;
  worktree_root: string;
  branch: string | null;
  requested_scope_count: number;
  granted_scope_count: number;
  blocked_scope_count: number;
  peer_count: number;
  created_at_ms: number;
}

/** One machine's worth of presence and activity, local or peer-reported. */
export interface MonitorSnapshot {
  home_dir: string;
  database_available: boolean;
  schema_version: number | null;
  agent_count: number;
  leases: MonitorLease[];
  event_count: number;
  events_truncated: number;
  events: MonitorEvent[];
}

export type MonitorPeerError = "timeout" | "unreachable" | "http_error" | "invalid_payload";

export interface MonitorPeer {
  url: string;
  hostname: string | null;
  reachable: boolean;
  error: MonitorPeerError | null;
  snapshot: MonitorSnapshot | null;
}

export interface MonitorState extends MonitorSnapshot {
  now_ms: number;
  hostname: string;
  peers: MonitorPeer[];
}

export interface MonitorOptions {
  port?: number;
  dbPath?: string;
  /** Base URLs of peer monitors to aggregate, from resolvePeers(). */
  peers?: readonly string[];
  peerTimeoutMs?: number;
}

export interface MonitorHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export function startMonitor(options: MonitorOptions = {}): MonitorHandle {
  const dbPath = options.dbPath ?? defaultDatabasePath();
  const peers = options.peers ?? [];
  const peerTimeoutMs = options.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
  const server = Bun.serve({
    hostname: HOSTNAME,
    port: options.port ?? DEFAULT_PORT,
    async fetch(request) {
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
        return Response.json(await readFederatedState(dbPath, peers, Date.now(), peerTimeoutMs), {
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
  /** One "mtime:size" entry per source file, in PAGE_SOURCES order. */
  sourceSignature: string;
}

// The page is authored as three sibling files so markup, styles, and client
// code stay reviewable on their own, but it is served as one self-contained
// document: the shell's placeholders are spliced at serve time, which keeps
// the strict no-external-asset CSP and the single-response contract intact.
const PAGE_SOURCES = [
  { url: new URL("./monitor.html", import.meta.url), placeholder: null },
  { url: new URL("./monitor.css", import.meta.url), placeholder: "__AGENT_FREQUENCY_STYLE__" },
  { url: new URL("./monitor.js", import.meta.url), placeholder: "__AGENT_FREQUENCY_SCRIPT__" },
] as const;

let cachedPage: PageAsset | null = null;

function pageAsset(): PageAsset {
  const sourceSignature = PAGE_SOURCES.map(({ url }) => {
    const stats = statSync(url);
    return `${stats.mtimeMs}:${stats.size}`;
  }).join("\n");
  if (cachedPage === null || cachedPage.sourceSignature !== sourceSignature) {
    let source = "";
    for (const { url, placeholder } of PAGE_SOURCES) {
      const text = readFileSync(url, "utf8");
      // Replacement is a thunk so "$&"-style patterns in the CSS or JS cannot
      // act as replacement directives.
      if (placeholder === null) source = text;
      else source = source.replace(placeholder, () => text);
    }
    const version = createHash("sha256").update(source).digest("hex").slice(0, 16);
    cachedPage = {
      html: source.replace(UI_VERSION_PLACEHOLDER, version),
      version,
      sourceSignature,
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
    hostname: localHostname(),
    home_dir: homedir(),
    database_available: false,
    schema_version: null,
    agent_count: 0,
    leases: [],
    event_count: 0,
    events_truncated: 0,
    events: [],
    peers: [],
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

/**
 * Composes the local snapshot with read-only snapshots fetched from configured
 * peer monitors. Peer fetches run in parallel and every failure degrades to an
 * unreachable entry, so a remote machine can never break local presence.
 */
export async function readFederatedState(
  dbPath: string,
  peers: readonly string[],
  nowMs: number,
  peerTimeoutMs: number = DEFAULT_PEER_TIMEOUT_MS,
): Promise<MonitorState> {
  const peerStates = Promise.all(peers.map((peer) => fetchPeer(peer, nowMs, peerTimeoutMs)));
  return { ...readState(dbPath, nowMs), peers: await peerStates };
}

function localHostname(): string {
  // The machine label is display-only, and a system hostname is often both long
  // and unlike the short name its owner uses ("Fabrizios-MacBook-Pro" next to a
  // tailnet's "mba"), so an explicit override wins. Control characters are
  // stripped because this label renders next to peer-reported names.
  const override = (process.env.AGENT_FREQUENCY_MACHINE_LABEL ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (override) return override.slice(0, 80);
  // ".local" is macOS Bonjour noise; the bare machine name is the label both
  // the tailnet and the monitor UI use.
  return osHostname().replace(/\.local$/i, "").slice(0, 80);
}

/**
 * Parses peer monitor URLs from repeated `--peer` flags, falling back to the
 * comma-separated AGENT_FREQUENCY_MONITOR_PEERS environment variable. URLs are
 * normalized to an origin-plus-path base (no query, fragment, or trailing
 * slash) so `https://mba.tailnet.ts.net/agents` and the bare origin both work.
 */
export function resolvePeers(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string[] {
  const flagValues: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--peer") {
      const value = argv[index + 1];
      if (value !== undefined) {
        flagValues.push(value);
        index += 1;
      }
    } else if (argument?.startsWith("--peer=")) {
      flagValues.push(argument.slice("--peer=".length));
    }
  }
  const raw = flagValues.length > 0 ? flagValues : (env.AGENT_FREQUENCY_MONITOR_PEERS ?? "").split(",");

  const peers: string[] = [];
  for (const entry of raw.map((value) => value.trim()).filter((value) => value.length > 0)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`Invalid monitor peer URL: ${entry}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Monitor peer URLs must be http(s): ${entry}`);
    }
    const normalized = url.origin + url.pathname.replace(/\/+$/, "");
    if (!peers.includes(normalized)) peers.push(normalized);
  }
  if (peers.length > MAX_PEERS) {
    throw new Error(`At most ${MAX_PEERS} monitor peers are supported`);
  }
  return peers;
}

async function fetchPeer(url: string, nowMs: number, timeoutMs: number): Promise<MonitorPeer> {
  const failure = (error: MonitorPeerError): MonitorPeer => ({
    url,
    hostname: null,
    reachable: false,
    error,
    snapshot: null,
  });

  let response: Response;
  try {
    response = await fetch(`${url}/api/state`, {
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect could silently swap the audited peer for another origin.
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch (error) {
    return failure(isTimeoutError(error) ? "timeout" : "unreachable");
  }
  if (!response.ok) return failure("http_error");

  try {
    const body = await readBodyBounded(response, MAX_PEER_BODY_BYTES);
    const payload = sanitizePeerPayload(JSON.parse(body), nowMs);
    if (payload === null) return failure("invalid_payload");
    const { hostname, ...snapshot } = payload;
    return { url, hostname, reachable: true, error: null, snapshot };
  } catch {
    return failure("invalid_payload");
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function readBodyBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("peer payload too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Rebuilds a peer's payload field by field with the same normalization the
 * local database reader applies, plus bounds a trusted store would have
 * enforced. A peer's own `peers` array is deliberately dropped: aggregation is
 * one level deep, so two monitors peering at each other cannot loop.
 *
 * Peer timestamps are rebased onto this machine's clock using the payload's
 * now_ms. The skew is quantized to whole seconds so millisecond-level fetch
 * jitter cannot change every timestamp on every poll and defeat the UI's
 * re-render signature.
 */
function sanitizePeerPayload(
  payload: unknown,
  nowMs: number,
): (MonitorSnapshot & { hostname: string | null }) | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;

  const peerNowMs = toNullableInteger(raw.now_ms);
  const skewMs = peerNowMs === null ? 0 : Math.round((nowMs - peerNowMs) / 1_000) * 1_000;

  const leases = boundedArray(raw.leases, MAX_PEER_LEASES)
    .map((lease) => sanitizePeerLease(lease, skewMs, nowMs))
    .filter((lease): lease is MonitorLease => lease !== null);
  const events = boundedArray(raw.events, MAX_MONITOR_EVENTS)
    .map((event) => sanitizePeerEvent(event, skewMs, nowMs))
    .filter((event): event is MonitorEvent => event !== null);
  const eventCount = Math.max(events.length, boundedPeerCount(raw.event_count));

  return {
    hostname: boundedPeerNullableText(raw.hostname, 80),
    home_dir: boundedPeerText(raw.home_dir, 1_024),
    database_available: raw.database_available === true,
    schema_version: toNullableInteger(raw.schema_version),
    agent_count: leases.length,
    leases,
    event_count: eventCount,
    events_truncated: eventCount - events.length,
    events,
  };
}

function sanitizePeerLease(value: unknown, skewMs: number, nowMs: number): MonitorLease | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;

  const expiresAtMs = rebasedTimestamp(row.expires_at_ms, skewMs, nowMs + MAX_PEER_EXPIRY_AHEAD_MS);
  // The local reader only returns live leases; hold peers to the same rule so
  // a stale or hostile peer cannot pin permanently-expired rows in the UI.
  if (expiresAtMs === null || expiresAtMs <= nowMs) return null;

  const claims = boundedArray(row.claims, MAX_PEER_CLAIMS)
    .map(sanitizePeerClaim)
    .filter((claim): claim is MonitorClaim => claim !== null);
  const dirtyPaths = boundedArray(row.dirty_paths, MAX_PEER_DIRTY_PATHS)
    .filter((path): path is string => typeof path === "string")
    .map((path) => boundedPeerText(path, 512));
  const dirtyCount = toNullableInteger(row.dirty_count);

  return {
    agent_id: boundedPeerText(row.agent_id, 120),
    agent_label: boundedPeerText(row.agent_label, 80),
    client_surface: normalizeClientSurface(row.client_surface),
    agent_state: normalizeAgentState(row.agent_state),
    summary: boundedPeerText(row.summary, 200),
    // Stricter than bounding: a peer's emoji is only rendered when it really is
    // a single emoji, so a remote monitor cannot inject a text banner here.
    emoji: sanitizeEmoji(row.emoji),
    repo_name: boundedPeerText(row.repo_name, 160),
    worktree_root: boundedPeerText(row.worktree_root, 1_024),
    branch: boundedPeerNullableText(row.branch, 200),
    head_oid: boundedPeerNullableText(row.head_oid, 64),
    dirty: typeof row.dirty === "boolean" ? row.dirty : null,
    dirty_count: dirtyCount,
    dirty_paths: dirtyPaths,
    dirty_paths_truncated: Math.max(0, (dirtyCount ?? dirtyPaths.length) - dirtyPaths.length),
    metadata_complete: typeof row.metadata_complete === "boolean" ? row.metadata_complete : true,
    timebox_seconds: toNullableInteger(row.timebox_seconds),
    created_at_ms: rebasedTimestamp(row.created_at_ms, skewMs, nowMs),
    updated_at_ms: rebasedTimestamp(row.updated_at_ms, skewMs, nowMs),
    expires_at_ms: expiresAtMs,
    claims,
  };
}

function sanitizePeerClaim(value: unknown): MonitorClaim | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const path = boundedPeerText(row.path, 512).trim();
  if (path.length === 0) return null;
  return { path, access: toAccess(row.access) };
}

function sanitizePeerEvent(value: unknown, skewMs: number, nowMs: number): MonitorEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const createdAtMs = rebasedTimestamp(row.created_at_ms, skewMs, nowMs);
  if (createdAtMs === null) return null;

  return {
    event_id: boundedPeerCount(row.event_id),
    event_type: row.event_type === "renewed" ? "renewed" : "announced",
    status: toEventStatus(row.status),
    agent_id: boundedPeerText(row.agent_id, 120),
    agent_label: boundedPeerText(row.agent_label, 80),
    client_surface: normalizeClientSurface(row.client_surface),
    agent_state: normalizeAgentState(row.agent_state),
    summary: boundedPeerText(row.summary, 200),
    // Stricter than bounding: a peer's emoji is only rendered when it really is
    // a single emoji, so a remote monitor cannot inject a text banner here.
    emoji: sanitizeEmoji(row.emoji),
    repo_name: boundedPeerText(row.repo_name, 160),
    worktree_root: boundedPeerText(row.worktree_root, 1_024),
    branch: boundedPeerNullableText(row.branch, 200),
    requested_scope_count: boundedPeerCount(row.requested_scope_count),
    granted_scope_count: boundedPeerCount(row.granted_scope_count),
    blocked_scope_count: boundedPeerCount(row.blocked_scope_count),
    peer_count: boundedPeerCount(row.peer_count),
    created_at_ms: createdAtMs,
  };
}

function boundedArray(value: unknown, maxItems: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, maxItems) : [];
}

function boundedPeerText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(UNSAFE_FORMATTING, " ").slice(0, maxLength);
}

function boundedPeerNullableText(value: unknown, maxLength: number): string | null {
  const text = boundedPeerText(value, maxLength);
  return text.length > 0 ? text : null;
}

function boundedPeerCount(value: unknown): number {
  const count = toNullableInteger(value);
  return count === null ? 0 : Math.max(0, Math.min(1_000_000, count));
}

/** Rebases a peer timestamp onto the local clock, clamped to [0, maxMs]. */
function rebasedTimestamp(value: unknown, skewMs: number, maxMs: number): number | null {
  const timestamp = toNullableInteger(value);
  if (timestamp === null) return null;
  return Math.max(0, Math.min(maxMs, timestamp + skewMs));
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
    const testingColumn = hasColumn(database, "activity_events", "testing")
      ? "testing"
      : "0 AS testing";
    const emojiColumn = hasColumn(database, "activity_events", "emoji")
      ? "emoji"
      : "NULL AS emoji";
    const rows = database
      .query(
        `SELECT event_id, event_type, status, agent_id, agent_label, ${surfaceColumn}, ${stateColumn}, ${testingColumn}, summary, ${emojiColumn},
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
    agent_state: agentStateFromRow(row.agent_state, row.testing),
    summary: toText(row.summary),
    emoji: sanitizeEmoji(row.emoji),
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
  const claims = claimsByLease.get(toText(row.lease_id)) ?? [];
  return {
    // lease_id is deliberately absent from the payload: it is the renewal
    // handle for a lease, and the MCP surface already withholds it from peers.
    agent_id: toText(row.agent_id),
    agent_label: toText(row.agent_label),
    client_surface: normalizeClientSurface(row.client_surface),
    agent_state: agentStateFromLease(row.agent_state, row.testing, claims),
    summary: toText(row.summary),
    // Older MCP processes predate the column, so the row may not carry it.
    emoji: sanitizeEmoji(row.emoji),
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
    claims,
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
  const argv = Bun.argv.slice(2);
  const peers = resolvePeers(argv, Bun.env);
  const monitor = startMonitor({ port: resolvePort(argv, Bun.env), peers });
  console.log(`Agent Frequency monitor on ${monitor.url}`);
  if (peers.length > 0) {
    console.log(`Aggregating ${peers.length} peer monitor${peers.length === 1 ? "" : "s"}: ${peers.join(", ")}`);
  }
}
