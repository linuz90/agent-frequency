import type { ClientSurface } from "./client-surface";

export const TIMEBOX_SECONDS = {
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "2h": 2 * 60 * 60,
} as const;

export const AGENT_STATES = ["working", "testing", "done", "stopped"] as const;
export const TRAFFIC_SCOPES = ["worktree", "project", "machine"] as const;

export type Timebox = keyof typeof TIMEBOX_SECONDS;
export type Access = "shared" | "exclusive";
export type AgentState = (typeof AGENT_STATES)[number];
export type TrafficScope = (typeof TRAFFIC_SCOPES)[number];

export function normalizeAgentState(value: unknown): AgentState {
  if (value === "done") return "done";
  if (value === "stopped") return "stopped";
  return value === "testing" ? "testing" : "working";
}

/**
 * Storage keeps the two v2 `agent_state` values and carries "testing" and
 * "stopped" in additive flag columns, so every read has to combine them. See
 * the schema comment in store.ts for why neither became a new enum value.
 * "stopped" wins: it is terminal, so no honest row sets both flags.
 */
export function agentStateFromRow(state: unknown, testing: unknown, stopped?: unknown): AgentState {
  if (stopped) return "stopped";
  return testing ? "testing" : normalizeAgentState(state);
}

/**
 * A lease's state, cross-checked against the claims it holds. Testing releases
 * every exclusive claim, so a lease still holding one is being edited: an
 * older process renewing that lease writes real claims without knowing the
 * flag column exists, which would otherwise leave a stale "testing" behind and
 * quietly turn a genuine exclusive claim into an advisory one.
 */
export function agentStateFromLease(
  state: unknown,
  testing: unknown,
  claims: ReadonlyArray<{ access: Access }>,
): AgentState {
  const resolved = agentStateFromRow(state, testing);
  if (resolved === "testing" && claims.some((claim) => claim.access === "exclusive")) {
    return "working";
  }
  return resolved;
}

export interface Scope {
  path: string;
  access: Access;
}

export interface AnnounceInput {
  summary: string;
  emoji?: string;
  cwd: string;
  scopes?: Scope[];
  timebox?: Timebox;
  lease_id?: string;
  state?: AgentState;
  // Why a run is ending without finishing. Required with state "stopped",
  // ignored otherwise: "done" already means success and needs no explanation.
  reason?: string;
  traffic_scope?: TrafficScope;
}

export interface GitMetadata {
  projectId: string;
  localRepoId: string;
  repoName: string;
  worktreeId: string;
  worktreeRoot: string;
  gitDir: string;
  gitCommonDir: string;
  branch: string | null;
  headOid: string | null;
  ignoreCase: boolean;
  origin: string | null;
  dirty: boolean | null;
  dirtyCount: number | null;
  dirtyPaths: string[];
  metadataComplete: boolean;
}

export type PeerRelation = "same_worktree" | "same_clone" | "same_project" | "other_project";

export type HiddenPeerCounts = Record<PeerRelation, number>;

export interface Blocker {
  agent_id: string;
  relation: PeerRelation;
  path: string;
  access: Access;
  expires_at: string;
  updated_at: string;
}

export interface BlockedScope extends Scope {
  blockers: Blocker[];
}

export interface Peer {
  agent_id: string;
  label: string;
  surface: ClientSurface;
  state: AgentState;
  summary: string;
  // Null when the peer announced no emoji, or one that failed validation.
  emoji: string | null;
  relation: PeerRelation;
  repo: string;
  worktree: string;
  branch: string | null;
  dirty: boolean | null;
  dirty_paths: string[];
  expires_at: string;
  updated_at: string;
  scopes: Scope[];
}

export type WarningCode =
  | "SHARED_SCOPE_OVERLAP"
  | "TESTING_SCOPE_OVERLAP"
  | "SAME_WORKTREE"
  | "SAME_BRANCH"
  | "INCOMPLETE_GIT_METADATA"
  | "BROAD_EXCLUSIVE_SCOPE";

export interface CoordinationWarning {
  code: WarningCode;
  message: string;
}

// A recently departed agent, reconstructed from the bounded activity feed.
// Display-only context: arbitration never reads these, and unlike Peer there
// are no claims to respect — the lease behind this entry is already gone.
export interface RecentPeer {
  agent_id: string;
  label: string;
  surface: ClientSurface;
  // Null when the agent announced no emoji, or one that failed validation.
  emoji: string | null;
  summary: string;
  // "completed" when the agent's last word was a done announcement;
  // "stopped" when it deliberately ended without finishing (reason says why,
  // and its working-tree changes may be half-done); "expired" when its lease
  // lapsed without a word — a crash or an abandoned session.
  outcome: "completed" | "expired" | "stopped";
  // The stopping agent's own words on why it did not finish; null unless the
  // outcome is "stopped".
  reason: string | null;
  repo: string;
  branch: string | null;
  last_heard: string;
}

export interface AnnounceOutput {
  // "completed" and "stopped" are the two terminal statuses: both mean the
  // lease and claims were released, and they differ only in whether the work
  // actually finished.
  status: "granted" | "partial" | "blocked" | "completed" | "stopped";
  snapshot_at: string;
  traffic_scope: TrafficScope;
  self: {
    lease_id: string | null;
    renewed: boolean;
    active: boolean;
    state: AgentState;
    agent_id: string;
    surface: ClientSurface;
    // Echoes the emoji as recorded, so a caller can see its value was dropped.
    emoji: string | null;
    expires_at: string | null;
    renew_after: string | null;
    timebox: Timebox | null;
    repo: string;
    worktree: string;
    branch: string | null;
    dirty: boolean | null;
    metadata_complete: boolean;
    granted_scopes: Scope[];
    blocked_scopes: BlockedScope[];
  };
  peers: Peer[];
  // Agents recently heard on this frequency whose leases have since ended.
  // A fresh lease gets a 24h orientation window; a renewal or completion gets
  // only what changed since the caller's previous announcement, so repeated
  // calls stay cheap. Bounded, deduplicated, and empty in the common case.
  recent_peers: RecentPeer[];
  hidden_peers: HiddenPeerCounts;
  peers_truncated: number;
  warnings: CoordinationWarning[];
  // Latest blocker lease expiry when any scope is blocked, else null. The
  // worst-case wait: every current blocker has expired by this time, and
  // blockers may release sooner by announcing done.
  retry_at: string | null;
  message: string;
}

export interface StoreAnnounceRequest {
  agentId: string;
  agentLabel: string;
  clientSurface: ClientSurface;
  state: AgentState;
  trafficScope: TrafficScope;
  summary: string;
  reason?: string | null;
  emoji?: string | null;
  metadata: GitMetadata;
  scopes: Scope[];
  timebox: Timebox;
  leaseId?: string;
  nowMs?: number;
}
