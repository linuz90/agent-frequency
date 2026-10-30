import type { ClientSurface } from "./client-surface";

// How long an announcement keeps an agent on the frequency without another
// word. Presence, not a lock: nothing waits on a lease, so the window only
// trades how long a crashed session lingers against how often a live one has
// to check in. Agents re-announce as their work changes anyway, so the window
// is a backstop sized well past one ordinary chunk of work.
export const LEASE_SECONDS = 30 * 60;

export const AGENT_STATES = ["working", "done", "stopped"] as const;
export const TRAFFIC_SCOPES = ["worktree", "project", "machine"] as const;
// Who a stopped run is waiting on. A bare stop conflates three different
// endings, and only one of them is a question for the user: "user" needs the
// user's decision or action before the work can continue, "external" waits on
// something outside the conversation (a release, CI, a service, another team),
// and "none" parked or gave up with nobody expected to act. Null means the
// stopping agent did not say, which is every stop from an older process.
export const WAITING_ON = ["user", "external", "none"] as const;

export type AgentState = (typeof AGENT_STATES)[number];
export type TrafficScope = (typeof TRAFFIC_SCOPES)[number];
export type WaitingOn = (typeof WAITING_ON)[number];

export function normalizeWaitingOn(value: unknown): WaitingOn | null {
  return WAITING_ON.includes(value as WaitingOn) ? (value as WaitingOn) : null;
}

/**
 * Storage keeps the two v2 `agent_state` values and carries "stopped" in an
 * additive flag column, so every read combines them. Rows from processes that
 * predate this version may also carry the retired `planning` and `testing`
 * flags; both described a live agent, so they read back as working.
 */
export function agentStateFromRow(state: unknown, stopped: unknown): AgentState {
  if (stopped) return "stopped";
  return state === "done" ? "done" : "working";
}

export interface AnnounceInput {
  summary: string;
  emoji?: string;
  cwd: string;
  paths?: string[];
  lease_id?: string;
  state?: AgentState;
  // Why a run is ending without finishing. Required with state "stopped",
  // ignored otherwise: "done" already means success and needs no explanation.
  reason?: string;
  // Who the stopped run is waiting on. Optional and ignored unless state is
  // "stopped", so callers that predate it keep working and record null.
  waiting_on?: WaitingOn;
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

export interface Peer {
  agent_id: string;
  label: string;
  surface: ClientSurface;
  summary: string;
  // Null when the peer announced no emoji, or one that failed validation.
  emoji: string | null;
  relation: PeerRelation;
  repo: string;
  worktree: string;
  branch: string | null;
  dirty: boolean | null;
  dirty_paths: string[];
  updated_at: string;
  // What the peer said it is editing. Awareness only: nothing here is a lock.
  paths: string[];
}

export type WarningCode =
  | "PATH_OVERLAP"
  | "SAME_WORKTREE"
  | "SAME_BRANCH"
  | "INCOMPLETE_GIT_METADATA";

export interface CoordinationWarning {
  code: WarningCode;
  message: string;
}

// A recently departed agent, reconstructed from the bounded activity feed.
// Display-only context: the lease behind this entry is already gone.
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
  // Who the stop is waiting on; null unless the outcome is "stopped" and the
  // stopping agent said.
  waiting_on: WaitingOn | null;
  repo: string;
  branch: string | null;
  last_heard: string;
}

export interface AnnounceOutput {
  // "active" while the agent is on the frequency. "completed" and "stopped"
  // both mean the lease was released, and differ only in whether the work
  // actually finished.
  status: "active" | "completed" | "stopped";
  snapshot_at: string;
  traffic_scope: TrafficScope;
  self: {
    lease_id: string | null;
    renewed: boolean;
    state: AgentState;
    agent_id: string;
    surface: ClientSurface;
    // Echoes the emoji as recorded, so a caller can see its value was dropped.
    emoji: string | null;
    expires_at: string | null;
    renew_after: string | null;
    repo: string;
    worktree: string;
    branch: string | null;
    dirty: boolean | null;
    metadata_complete: boolean;
    paths: string[];
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
  waitingOn?: WaitingOn | null;
  emoji?: string | null;
  metadata: GitMetadata;
  paths: string[];
  leaseId?: string;
  nowMs?: number;
}
