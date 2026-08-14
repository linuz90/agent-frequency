import type { ClientSurface } from "./client-surface";

export const TIMEBOX_SECONDS = {
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "2h": 2 * 60 * 60,
} as const;

export const AGENT_STATES = ["working", "done"] as const;
export const TRAFFIC_SCOPES = ["worktree", "project", "machine"] as const;

export type Timebox = keyof typeof TIMEBOX_SECONDS;
export type Access = "shared" | "exclusive";
export type AgentState = (typeof AGENT_STATES)[number];
export type TrafficScope = (typeof TRAFFIC_SCOPES)[number];

export function normalizeAgentState(value: unknown): AgentState {
  return value === "done" ? "done" : "working";
}

export interface Scope {
  path: string;
  access: Access;
}

export interface AnnounceInput {
  summary: string;
  cwd: string;
  scopes?: Scope[];
  timebox?: Timebox;
  lease_id?: string;
  state?: AgentState;
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
  relation: PeerRelation;
  repo: string;
  worktree: string;
  branch: string | null;
  dirty: boolean | null;
  dirty_paths: string[];
  expires_at: string;
  scopes: Scope[];
}

export type WarningCode =
  | "SHARED_SCOPE_OVERLAP"
  | "SAME_WORKTREE"
  | "SAME_BRANCH"
  | "INCOMPLETE_GIT_METADATA"
  | "BROAD_EXCLUSIVE_SCOPE";

export interface CoordinationWarning {
  code: WarningCode;
  message: string;
}

export interface AnnounceOutput {
  status: "granted" | "partial" | "blocked" | "completed";
  snapshot_at: string;
  traffic_scope: TrafficScope;
  self: {
    lease_id: string | null;
    renewed: boolean;
    active: boolean;
    state: AgentState;
    agent_id: string;
    surface: ClientSurface;
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
  metadata: GitMetadata;
  scopes: Scope[];
  timebox: Timebox;
  leaseId?: string;
  nowMs?: number;
}
