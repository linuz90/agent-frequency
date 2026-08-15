import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { normalizeClientSurface, type ClientSurface } from "./client-surface";
import { MAX_EMOJI_LENGTH } from "./emoji";
import { normalizeScopes, scopesOverlap } from "./scopes";
import {
  TIMEBOX_SECONDS,
  agentStateFromLease,
  type AgentState,
  type AnnounceOutput,
  type BlockedScope,
  type Blocker,
  type CoordinationWarning,
  type HiddenPeerCounts,
  type Peer,
  type PeerRelation,
  type RecentPeer,
  type Scope,
  type StoreAnnounceRequest,
} from "./types";

const MAX_PEERS = 20;
// Dirty paths let peers attribute unexpected working-tree changes to their
// owner (e.g. a finalize pass finding foreign edits). Bounded so one huge
// repo status cannot bloat the database or every peer's tool output;
// dirty_count still carries the true total.
const MAX_DIRTY_PATHS = 40;
// The activity feed is operational context, not an audit log. Keep enough to
// understand recent coordination without turning transient agent summaries
// and local paths into an unbounded archive.
const MAX_ACTIVITY_EVENTS = 1_000;
const ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
// Recently departed agents surfaced in announce responses. The cap keeps the
// orientation cost of a fresh lease small; the window is one working day, long
// enough to explain "who changed this since I last looked" after an overnight
// gap, and far shorter than activity retention.
const MAX_RECENT_PEERS = 5;
const RECENT_PEER_WINDOW_MS = 24 * 60 * 60 * 1_000;
// Blocker identity persisted with a blocked or partial event, so the monitor
// can say who was waiting on whom — the announce response computes the full
// list but hands it only to the blocked caller. Bounded like every other
// peer-authored payload; blocked_scope_count still carries the true totals.
const MAX_EVENT_BLOCKERS = 8;
const SCHEMA_VERSION = 2;
const BUSY_RETRY_DELAYS_MS = [0, 25, 100, 250] as const;

interface StoreOptions {
  dbPath?: string;
}

interface LeaseRow {
  lease_id: string;
  agent_id: string;
  agent_label: string;
  client_surface: ClientSurface | string;
  agent_state: string;
  testing: number | null;
  summary: string;
  emoji: string | null;
  project_id: string;
  local_repo_id: string;
  repo_name: string;
  worktree_id: string;
  worktree_root: string;
  branch: string | null;
  head_oid: string | null;
  ignore_case: number;
  dirty: number | null;
  dirty_count: number | null;
  dirty_paths: string;
  metadata_complete: number;
  timebox_seconds: number;
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;
}

interface ClaimRow {
  lease_id: string;
  path: string;
  access: Scope["access"];
}

interface EvaluatedScope {
  scope: Scope;
  blockers: Blocker[];
  sharedOverlaps: Array<{ agentId: string; path: string }>;
  testingOverlaps: Array<{ agentId: string; path: string }>;
}

interface PeerCandidate extends Peer {
  ignoreCase: boolean;
  updatedAtMs: number;
}

interface VisiblePeerSnapshot {
  peers: Peer[];
  hiddenPeers: HiddenPeerCounts;
  truncated: number;
}

export function defaultDatabasePath(): string {
  const override = process.env.AGENT_FREQUENCY_DB_PATH;
  if (override) {
    return isAbsolute(override) ? override : resolve(override);
  }
  return `${homedir()}/.local/state/agent-frequency/state.sqlite3`;
}

export class AgentFrequencyStore {
  private readonly database: Database;

  constructor(options: StoreOptions = {}) {
    const dbPath = options.dbPath ?? defaultDatabasePath();
    const isMemoryDatabase = dbPath === ":memory:";
    if (!isMemoryDatabase) {
      const parentDirectory = dirname(dbPath);
      const parentExisted = existsSync(parentDirectory);
      mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
      // The default state directory is private by contract. For explicit paths,
      // only tighten a directory that Agent Frequency had to create itself.
      if (!options.dbPath && !process.env.AGENT_FREQUENCY_DB_PATH) {
        chmodSync(parentDirectory, 0o700);
      } else if (!parentExisted) {
        chmodSync(parentDirectory, 0o700);
      }
    }

    this.database = new Database(dbPath, { create: true, strict: true });
    try {
      // Multiple MCP subprocesses commonly open Agent Frequency at the same instant.
      // Configure waiting before WAL/schema initialization and retry recovery
      // locks so startup contention does not look like an empty frequency.
      this.database.exec("PRAGMA busy_timeout = 1000");
      this.database.exec("PRAGMA foreign_keys = ON");
      withBusyRetry(() => this.database.exec("PRAGMA journal_mode = WAL"));
      this.database.exec("PRAGMA synchronous = NORMAL");
      withBusyRetry(() => initializeSchema(this.database));
    } catch (error) {
      this.database.close(false);
      throw error;
    }

    if (!isMemoryDatabase) {
      chmodSync(dbPath, 0o600);
    }
  }

  close(): void {
    this.database.close(false);
  }

  announce(request: StoreAnnounceRequest): AnnounceOutput {
    const nowMs = request.nowMs ?? Date.now();
    // "done" and "stopped" are both lifecycle signals, not claim requests:
    // either way the run is over and nothing will edit further, so the lease
    // and claims release identically — the two differ only in what the record
    // says about the work. Ignoring stale caller scopes also lets an agent
    // release its lease after moving or deleting paths that were valid when
    // the work started.
    const terminal = request.state === "done" || request.state === "stopped";
    const scopes = terminal ? [] : asAdvisoryScopes(normalizeScopes(request.scopes), request.state);
    const timeboxSeconds = TIMEBOX_SECONDS[request.timebox];
    const expiresAtMs = nowMs + timeboxSeconds * 1_000;
    let leaseId = request.leaseId ?? randomBytes(16).toString("hex");
    let renewed = false;
    // When this call renews a lease, recent traffic is reported as a delta
    // since the caller last listened; a fresh lease gets the full window.
    let priorUpdatedAtMs: number | null = null;

    let transactionOpen = false;
    try {
      withBusyRetry(() => this.database.exec("BEGIN IMMEDIATE"));
      transactionOpen = true;
      this.database.query("DELETE FROM leases WHERE expires_at_ms <= ?").run(nowMs);

      if (terminal) {
        const output = this.completeAnnouncement(request, nowMs);
        this.recordActivity(request, output, 0, this.getPeerRows("").length, nowMs);
        this.database.exec("COMMIT");
        transactionOpen = false;
        return output;
      }

      if (request.leaseId) {
        const existing = this.getLeaseRow(request.leaseId);
        if (!existing) {
          // Expiry should require no cleanup ceremony from the caller. A stale
          // handle transparently starts a new lease in this same one-tool call.
          leaseId = randomBytes(16).toString("hex");
        } else if (
          existing.worktree_id !== request.metadata.worktreeId
          && existing.local_repo_id !== request.metadata.localRepoId
          && existing.project_id !== request.metadata.projectId
        ) {
          throw new Error("lease_id cannot be renewed in a different project");
        } else {
          renewed = true;
          priorUpdatedAtMs = existing.updated_at_ms;
        }
      }

      // One agent process holds one lease per worktree. When a caller loses
      // track of its lease_id and announces fresh, the orphaned lease would
      // otherwise show up as a peer and can even block the agent's own
      // exclusive scopes until expiry. Scoping by worktree is essential: one
      // MCP process can serve announcements across several repositories, and
      // an unscoped delete would silently drop the agent's live claims
      // elsewhere. Agent IDs carry per-process random suffixes, so a same-ID
      // same-worktree row is almost certainly this process's stale lease.
      this.database
        .query("DELETE FROM leases WHERE agent_id = ? AND worktree_id = ? AND lease_id != ?")
        .run(request.agentId, request.metadata.worktreeId, leaseId);

      const peerRows = this.getPeerRows(leaseId);
      const claimsByLease = this.getClaimsByLease(peerRows.map((peer) => peer.lease_id));
      const evaluations = scopes.map((scope) =>
        this.evaluateScope(scope, request, peerRows, claimsByLease),
      );
      const grantedScopes = evaluations
        .filter((evaluation) => evaluation.blockers.length === 0)
        .map((evaluation) => evaluation.scope);
      const blockedScopes: BlockedScope[] = evaluations
        .filter((evaluation) => evaluation.blockers.length > 0)
        .map((evaluation) => ({
          ...evaluation.scope,
          blockers: evaluation.blockers,
        }));

      this.upsertLease(request, leaseId, timeboxSeconds, nowMs, expiresAtMs);
      this.database.query("DELETE FROM claims WHERE lease_id = ?").run(leaseId);
      const insertClaim = this.database.query(
        "INSERT INTO claims (lease_id, path, access) VALUES (?, ?, ?)",
      );
      for (const scope of grantedScopes) {
        insertClaim.run(leaseId, scope.path, scope.access);
      }

      const peerCandidates = this.buildPeerCandidates(peerRows, claimsByLease, request);
      const peers = peerCandidates.map(stripPeerCandidate);
      const warnings = this.buildWarnings(request, scopes, evaluations, peers);
      const visible = this.selectVisiblePeers(peerCandidates, request, scopes);
      const recentPeers = this.getRecentPeers(
        request,
        priorUpdatedAtMs ?? nowMs - RECENT_PEER_WINDOW_MS,
      );
      const status =
        blockedScopes.length === 0
          ? "granted"
          : grantedScopes.length === 0
            ? "blocked"
            : "partial";

      const retryAtMs = latestBlockerExpiryMs(blockedScopes);
      const output: AnnounceOutput = {
        status,
        snapshot_at: toIso(nowMs),
        traffic_scope: request.trafficScope,
        self: {
          lease_id: leaseId,
          renewed,
          active: true,
          state: request.state,
          agent_id: request.agentId,
          surface: request.clientSurface,
          emoji: request.emoji ?? null,
          expires_at: toIso(expiresAtMs),
          renew_after: toIso(nowMs + Math.floor((timeboxSeconds * 1_000 * 2) / 3)),
          timebox: request.timebox,
          repo: request.metadata.repoName,
          worktree: request.metadata.worktreeRoot,
          branch: request.metadata.branch,
          dirty: request.metadata.dirty,
          metadata_complete: request.metadata.metadataComplete,
          granted_scopes: grantedScopes,
          blocked_scopes: blockedScopes,
        },
        peers: visible.peers,
        recent_peers: recentPeers,
        hidden_peers: visible.hiddenPeers,
        peers_truncated: visible.truncated,
        warnings,
        retry_at: retryAtMs === null ? null : toIso(retryAtMs),
        message: statusMessage(
          status,
          request.state,
          grantedScopes.length,
          blockedScopes.length,
          retryAtMs,
          nowMs,
        ),
      };

      this.recordActivity(request, output, scopes.length, peers.length, nowMs);
      this.database.exec("COMMIT");
      transactionOpen = false;
      return output;
    } catch (error) {
      if (transactionOpen) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private getLeaseRow(leaseId: string): LeaseRow | null {
    return this.database.query("SELECT * FROM leases WHERE lease_id = ?").get(leaseId) as
      | LeaseRow
      | null;
  }

  private completeAnnouncement(request: StoreAnnounceRequest, nowMs: number): AnnounceOutput {
    // Captured before deletion: the completing call reports recent traffic as
    // a delta since the caller last listened. Without a live lease there is no
    // "since", and a closing call is the wrong moment for a 24h orientation
    // dump, so an unknown lease_id gets no recent peers at all.
    let priorUpdatedAtMs: number | null = null;
    if (request.leaseId) {
      const existing = this.getLeaseRow(request.leaseId);
      if (
        existing
        && existing.worktree_id !== request.metadata.worktreeId
        && existing.local_repo_id !== request.metadata.localRepoId
        && existing.project_id !== request.metadata.projectId
      ) {
        throw new Error("lease_id cannot be completed in a different project");
      }
      if (existing) {
        priorUpdatedAtMs = existing.updated_at_ms;
        // Claims cascade with the lease, so completion releases every granted
        // path atomically before the returned peer snapshot is built.
        this.database.query("DELETE FROM leases WHERE lease_id = ?").run(request.leaseId);
      }
    }

    // A caller may lose its handle after a client restart. The stable
    // per-process agent ID still gives us a safe same-worktree fallback without
    // touching that process's work in another repository.
    this.database
      .query("DELETE FROM leases WHERE agent_id = ? AND worktree_id = ?")
      .run(request.agentId, request.metadata.worktreeId);

    const peerRows = this.getPeerRows("");
    const claimsByLease = this.getClaimsByLease(peerRows.map((peer) => peer.lease_id));
    const peerCandidates = this.buildPeerCandidates(peerRows, claimsByLease, request);
    const peers = peerCandidates.map(stripPeerCandidate);
    const visible = this.selectVisiblePeers(peerCandidates, request, []);

    const stopped = request.state === "stopped";
    return {
      status: stopped ? "stopped" : "completed",
      snapshot_at: toIso(nowMs),
      traffic_scope: request.trafficScope,
      self: {
        lease_id: null,
        renewed: false,
        active: false,
        state: request.state,
        agent_id: request.agentId,
        surface: request.clientSurface,
        emoji: request.emoji ?? null,
        expires_at: null,
        renew_after: null,
        timebox: null,
        repo: request.metadata.repoName,
        worktree: request.metadata.worktreeRoot,
        branch: request.metadata.branch,
        dirty: request.metadata.dirty,
        metadata_complete: request.metadata.metadataComplete,
        granted_scopes: [],
        blocked_scopes: [],
      },
      peers: visible.peers,
      recent_peers:
        priorUpdatedAtMs === null ? [] : this.getRecentPeers(request, priorUpdatedAtMs),
      hidden_peers: visible.hiddenPeers,
      peers_truncated: visible.truncated,
      warnings: this.buildWarnings(request, [], [], peers),
      retry_at: null,
      message: stopped
        ? "Stop announced; active lease and claims released, and the reason is recorded for peers"
        : "Completion announced; active lease and claims released",
    };
  }

  private getPeerRows(excludedLeaseId: string): LeaseRow[] {
    return this.database
      .query(
        `SELECT * FROM leases
         WHERE lease_id != ?
         ORDER BY updated_at_ms DESC, agent_id ASC, lease_id ASC`,
      )
      .all(excludedLeaseId) as LeaseRow[];
  }

  /**
   * Recently departed agents, reconstructed from the activity feed: the latest
   * event per agent-and-worktree newer than sinceMs, for agents that no longer
   * hold an active lease there. Answers "who was here, and did they finish?"
   * — the question an agent faces when it finds working-tree changes that no
   * active peer claims. Display-only by design: arbitration never reads
   * events, and entries carry no scopes to respect.
   *
   * Traffic scoping mirrors peer visibility, with one honest weakening: events
   * retain no origin identity, so `project` matches by repo_name rather than
   * by the normalized origin used for live peers. Fine for orientation
   * context; never used for safety decisions.
   */
  private getRecentPeers(request: StoreAnnounceRequest, sinceMs: number): RecentPeer[] {
    const scopeCondition =
      request.trafficScope === "worktree"
        ? "AND events.worktree_root = $worktree"
        : request.trafficScope === "project"
          ? "AND events.repo_name = $repo"
          : "";
    const rows = this.database
      .query(
        // The latest-event subquery is deliberately unwindowed: in-window rows
        // are newer than any pre-window row, so if the pair's true latest event
        // is outside the window the pair simply drops out, never misattributed
        // to an older row. Expired leases are already deleted at announce
        // start, so a bare NOT EXISTS excludes exactly the still-active agents
        // the peers array reports.
        `SELECT * FROM activity_events AS events
         WHERE events.created_at_ms > $since
           AND events.agent_id != $agentId
           ${scopeCondition}
           AND events.event_id = (
             SELECT max(latest.event_id) FROM activity_events AS latest
             WHERE latest.agent_id = events.agent_id
               AND latest.worktree_root = events.worktree_root
           )
           AND NOT EXISTS (
             SELECT 1 FROM leases
             WHERE leases.agent_id = events.agent_id
               AND leases.worktree_root = events.worktree_root
           )
         ORDER BY events.created_at_ms DESC, events.event_id DESC
         LIMIT ${MAX_RECENT_PEERS}`,
      )
      .all({
        since: sinceMs,
        agentId: request.agentId,
        ...(request.trafficScope === "worktree"
          ? { worktree: request.metadata.worktreeRoot }
          : request.trafficScope === "project"
            ? { repo: request.metadata.repoName }
            : {}),
      }) as Array<{
        agent_id: string;
        agent_label: string;
        client_surface: string;
        agent_state: string;
        stopped: number | null;
        reason: string | null;
        emoji: string | null;
        summary: string;
        repo_name: string;
        branch: string | null;
        created_at_ms: number;
      }>;

    return rows.map((row) => ({
      agent_id: row.agent_id,
      label: row.agent_label,
      surface: normalizeClientSurface(row.client_surface),
      emoji: row.emoji,
      summary: row.summary,
      // A stop stores agent_state "done" plus the additive flag, so the flag
      // has to be read first or every stop reads back as completed work.
      outcome: row.stopped ? "stopped" : row.agent_state === "done" ? "completed" : "expired",
      reason: row.stopped ? (row.reason ?? null) : null,
      repo: row.repo_name,
      branch: row.branch,
      last_heard: toIso(row.created_at_ms),
    }));
  }

  private getClaimsByLease(leaseIds: string[]): Map<string, Scope[]> {
    const claims = new Map<string, Scope[]>();
    if (leaseIds.length === 0) {
      return claims;
    }

    const placeholders = leaseIds.map(() => "?").join(", ");
    const rows = this.database
      .query(
        `SELECT lease_id, path, access FROM claims
         WHERE lease_id IN (${placeholders})
         ORDER BY path ASC, access ASC`,
      )
      .all(...leaseIds) as ClaimRow[];

    for (const row of rows) {
      const leaseClaims = claims.get(row.lease_id) ?? [];
      leaseClaims.push({ path: row.path, access: row.access });
      claims.set(row.lease_id, leaseClaims);
    }
    return claims;
  }

  private evaluateScope(
    incoming: Scope,
    request: StoreAnnounceRequest,
    peers: LeaseRow[],
    claimsByLease: Map<string, Scope[]>,
  ): EvaluatedScope {
    const blockers: Blocker[] = [];
    const sharedOverlaps: EvaluatedScope["sharedOverlaps"] = [];
    const testingOverlaps: EvaluatedScope["testingOverlaps"] = [];

    for (const peer of peers) {
      const relation = relationTo(peer, request);
      // Unrelated projects belong in the traffic snapshot, but their paths
      // describe a different namespace and must never block this project.
      if (relation === "other_project") {
        continue;
      }
      // A testing peer has stopped editing, so its paths are advertisement
      // rather than a claim: they still surface as a warning, because edits
      // underneath a running verification can invalidate it, but they never
      // block. That is the point of the state — hand the files back early.
      const peerClaims = claimsByLease.get(peer.lease_id) ?? [];
      const peerTesting =
        agentStateFromLease(peer.agent_state, peer.testing, peerClaims) === "testing";
      for (const existing of peerClaims) {
        if (!scopesOverlap(incoming, existing, request.metadata.ignoreCase || Boolean(peer.ignore_case))) {
          continue;
        }
        if (peerTesting) {
          testingOverlaps.push({ agentId: peer.agent_id, path: existing.path });
        } else if (incoming.access === "exclusive" || existing.access === "exclusive") {
          blockers.push({
            agent_id: peer.agent_id,
            relation,
            path: existing.path,
            access: existing.access,
            expires_at: toIso(peer.expires_at_ms),
            updated_at: toIso(peer.updated_at_ms),
          });
        } else {
          sharedOverlaps.push({ agentId: peer.agent_id, path: existing.path });
        }
      }
    }

    blockers.sort(compareBlockers);
    sharedOverlaps.sort(compareOverlaps);
    testingOverlaps.sort(compareOverlaps);
    return { scope: incoming, blockers, sharedOverlaps, testingOverlaps };
  }

  private upsertLease(
    request: StoreAnnounceRequest,
    leaseId: string,
    timeboxSeconds: number,
    nowMs: number,
    expiresAtMs: number,
  ): void {
    const metadata = request.metadata;
    this.database
      .query(
        `INSERT INTO leases (
           lease_id, agent_id, agent_label, client_surface, agent_state, testing, summary, emoji, project_id, local_repo_id, repo_name,
           worktree_id, worktree_root, branch, head_oid, ignore_case, dirty, dirty_count,
           dirty_paths, metadata_complete, timebox_seconds, created_at_ms, updated_at_ms, expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lease_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           agent_label = excluded.agent_label,
           client_surface = excluded.client_surface,
           agent_state = excluded.agent_state,
           testing = excluded.testing,
           summary = excluded.summary,
           emoji = excluded.emoji,
           project_id = excluded.project_id,
           local_repo_id = excluded.local_repo_id,
           repo_name = excluded.repo_name,
           worktree_id = excluded.worktree_id,
           worktree_root = excluded.worktree_root,
           branch = excluded.branch,
           head_oid = excluded.head_oid,
           ignore_case = excluded.ignore_case,
           dirty = excluded.dirty,
           dirty_count = excluded.dirty_count,
           dirty_paths = excluded.dirty_paths,
           metadata_complete = excluded.metadata_complete,
           timebox_seconds = excluded.timebox_seconds,
           updated_at_ms = excluded.updated_at_ms,
           expires_at_ms = excluded.expires_at_ms`,
      )
      .run(
        leaseId,
        request.agentId,
        request.agentLabel,
        request.clientSurface,
        storedAgentState(request.state),
        request.state === "testing" ? 1 : 0,
        request.summary,
        request.emoji ?? null,
        metadata.projectId,
        metadata.localRepoId,
        metadata.repoName,
        metadata.worktreeId,
        metadata.worktreeRoot,
        metadata.branch,
        metadata.headOid,
        metadata.ignoreCase ? 1 : 0,
        metadata.dirty === null ? null : metadata.dirty ? 1 : 0,
        metadata.dirtyCount,
        JSON.stringify(metadata.dirtyPaths.slice(0, MAX_DIRTY_PATHS)),
        metadata.metadataComplete ? 1 : 0,
        timeboxSeconds,
        nowMs,
        nowMs,
        expiresAtMs,
      );
  }

  private buildPeerCandidates(
    rows: LeaseRow[],
    claimsByLease: Map<string, Scope[]>,
    request: StoreAnnounceRequest,
  ): PeerCandidate[] {
    return rows
      .map((row) => ({
        agent_id: row.agent_id,
        label: row.agent_label,
        surface: normalizeClientSurface(row.client_surface),
        state: agentStateFromLease(
          row.agent_state,
          row.testing,
          claimsByLease.get(row.lease_id) ?? [],
        ),
        summary: row.summary,
        // Older processes never write the column, so treat missing as none.
        emoji: row.emoji ?? null,
        relation: relationTo(row, request),
        repo: row.repo_name,
        worktree: row.worktree_root,
        branch: row.branch,
        dirty: fromNullableBoolean(row.dirty),
        dirty_paths: parseDirtyPaths(row.dirty_paths),
        expires_at: toIso(row.expires_at_ms),
        updated_at: toIso(row.updated_at_ms),
        scopes: claimsByLease.get(row.lease_id) ?? [],
        ignoreCase: Boolean(row.ignore_case),
        updatedAtMs: row.updated_at_ms,
      }))
      .sort(
        (left, right) =>
          relationRank(left.relation) - relationRank(right.relation) ||
          right.updatedAtMs - left.updatedAtMs ||
          left.agent_id.localeCompare(right.agent_id),
      );
  }

  private selectVisiblePeers(
    candidates: PeerCandidate[],
    request: StoreAnnounceRequest,
    requestedScopes: Scope[],
  ): VisiblePeerSnapshot {
    const hiddenPeers = emptyHiddenPeerCounts();
    const visible = candidates.filter((candidate) => {
      if (isPeerVisible(candidate, request, requestedScopes)) return true;
      hiddenPeers[candidate.relation] += 1;
      return false;
    });

    // Filtering is deliberately the final response-shaping step: every peer
    // above already participated in arbitration and warnings. Within the hard
    // output cap, actionable overlaps and same-branch risks outrank ambient
    // traffic so narrowing the view cannot bury the reason coordination fired.
    visible.sort(
      (left, right) =>
        peerActionRank(left, request, requestedScopes)
          - peerActionRank(right, request, requestedScopes)
        || relationRank(left.relation) - relationRank(right.relation)
        || right.updatedAtMs - left.updatedAtMs
        || left.agent_id.localeCompare(right.agent_id),
    );
    const selected = visible.slice(0, MAX_PEERS);

    return {
      peers: selected.map(stripPeerCandidate),
      hiddenPeers,
      truncated: visible.length - selected.length,
    };
  }

  private buildWarnings(
    request: StoreAnnounceRequest,
    requestedScopes: Scope[],
    evaluations: EvaluatedScope[],
    peers: Peer[],
  ): CoordinationWarning[] {
    const warnings: CoordinationWarning[] = [];
    const sharedOverlaps = evaluations.flatMap((evaluation) =>
      evaluation.sharedOverlaps.map((overlap) => ({ incoming: evaluation.scope.path, ...overlap })),
    );
    if (sharedOverlaps.length > 0) {
      const descriptions = [
        ...new Set(
          sharedOverlaps.map(
            (overlap) => `${overlap.incoming} with ${overlap.agentId}:${overlap.path}`,
          ),
        ),
      ];
      warnings.push({
        code: "SHARED_SCOPE_OVERLAP",
        message: `Shared scopes overlap: ${descriptions.join(", ")}`,
      });
    }

    const testingOverlaps = evaluations.flatMap((evaluation) =>
      evaluation.testingOverlaps.map((overlap) => ({ incoming: evaluation.scope.path, ...overlap })),
    );
    if (testingOverlaps.length > 0) {
      const descriptions = [
        ...new Set(
          testingOverlaps.map(
            (overlap) => `${overlap.incoming} with ${overlap.agentId}:${overlap.path}`,
          ),
        ),
      ];
      warnings.push({
        code: "TESTING_SCOPE_OVERLAP",
        message: `Agents are testing overlapping paths, so your edits can invalidate their run: ${descriptions.join(", ")}`,
      });
    }

    const sameWorktreeAgents = uniqueAgentIds(
      peers.filter((peer) => peer.relation === "same_worktree"),
    );
    if (sameWorktreeAgents.length > 0) {
      warnings.push({
        code: "SAME_WORKTREE",
        message: `Agents in this worktree: ${sameWorktreeAgents.join(", ")}`,
      });
    }

    const sameBranchAgents = uniqueAgentIds(
      peers.filter(
        (peer) =>
          peer.relation !== "same_worktree" &&
          peer.relation !== "other_project" &&
          request.metadata.branch !== null &&
          peer.branch === request.metadata.branch,
      ),
    );
    if (sameBranchAgents.length > 0) {
      warnings.push({
        code: "SAME_BRANCH",
        message: `Agents on branch ${request.metadata.branch}: ${sameBranchAgents.join(", ")}`,
      });
    }

    if (!request.metadata.metadataComplete) {
      warnings.push({
        code: "INCOMPLETE_GIT_METADATA",
        message: "Git metadata is incomplete; collision detection may miss related worktrees or clones",
      });
    }

    if (requestedScopes.some((scope) => scope.path === "." && scope.access === "exclusive")) {
      warnings.push({
        code: "BROAD_EXCLUSIVE_SCOPE",
        message: "An exclusive repository-wide scope can unnecessarily block unrelated work",
      });
    }

    return warnings;
  }

  private recordActivity(
    request: StoreAnnounceRequest,
    output: AnnounceOutput,
    requestedScopeCount: number,
    peerCount: number,
    nowMs: number,
  ): void {
    this.database
      .query(
        `INSERT INTO activity_events (
           event_type, status, agent_id, agent_label, client_surface, agent_state, testing, stopped, reason, summary, emoji, repo_name,
           worktree_root, branch, requested_scope_count, granted_scope_count,
           blocked_scope_count, blockers, peer_count, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        output.self.renewed ? "renewed" : "announced",
        output.status === "completed" || output.status === "stopped" ? "granted" : output.status,
        request.agentId,
        request.agentLabel,
        request.clientSurface,
        storedAgentState(request.state),
        request.state === "testing" ? 1 : 0,
        request.state === "stopped" ? 1 : 0,
        request.state === "stopped" ? (request.reason ?? null) : null,
        request.summary,
        request.emoji ?? null,
        request.metadata.repoName,
        request.metadata.worktreeRoot,
        request.metadata.branch,
        requestedScopeCount,
        output.self.granted_scopes.length,
        output.self.blocked_scopes.length,
        JSON.stringify(eventBlockers(output.self.blocked_scopes)),
        peerCount,
        nowMs,
      );

    this.database
      .query("DELETE FROM activity_events WHERE created_at_ms < ?")
      .run(nowMs - ACTIVITY_RETENTION_MS);
    this.database
      .query(
        `DELETE FROM activity_events
         WHERE event_id NOT IN (
           SELECT event_id FROM activity_events
           ORDER BY created_at_ms DESC, event_id DESC
           LIMIT ?
         )`,
      )
      .run(MAX_ACTIVITY_EVENTS);
  }
}

// A testing agent is verifying what it already wrote, so it holds no locks:
// its paths are recorded as shared advertisements that peers can see and edit
// through. Requested access is downgraded rather than rejected so an agent can
// hand the same scope list back with one changed field.
function asAdvisoryScopes(scopes: Scope[], state: AgentState): Scope[] {
  if (state !== "testing") return scopes;
  return scopes.map((scope) =>
    scope.access === "shared" ? scope : { path: scope.path, access: "shared" },
  );
}

// Only "working" and "done" are storable agent_state values; see the testing
// column comment in initializeSchema. A stop is stored as "done" plus the
// additive stopped flag: both are terminal, and rows written by processes
// that predate the flag keep reading back unchanged.
function storedAgentState(state: AgentState): "working" | "done" {
  return state === "done" || state === "stopped" ? "done" : "working";
}

// What the event feed keeps of a blocked or partial response: who was in the
// way and on which claimed path. Deduplicated and bounded — the response's
// full Blocker list stays per-call, and blocked_scope_count keeps the totals.
function eventBlockers(blockedScopes: BlockedScope[]): Array<{ agent_id: string; path: string }> {
  const seen = new Set<string>();
  const blockers: Array<{ agent_id: string; path: string }> = [];
  for (const scope of blockedScopes) {
    for (const blocker of scope.blockers) {
      const key = JSON.stringify([blocker.agent_id, blocker.path]);
      if (seen.has(key)) continue;
      seen.add(key);
      blockers.push({ agent_id: blocker.agent_id, path: blocker.path });
      if (blockers.length >= MAX_EVENT_BLOCKERS) return blockers;
    }
  }
  return blockers;
}

function compareOverlaps(
  left: { agentId: string; path: string },
  right: { agentId: string; path: string },
): number {
  return left.agentId.localeCompare(right.agentId) || left.path.localeCompare(right.path);
}

function relationTo(peer: LeaseRow, request: StoreAnnounceRequest): PeerRelation {
  if (peer.worktree_id === request.metadata.worktreeId) {
    return "same_worktree";
  }
  if (peer.local_repo_id === request.metadata.localRepoId) {
    return "same_clone";
  }
  return peer.project_id === request.metadata.projectId ? "same_project" : "other_project";
}

function relationRank(relation: PeerRelation): number {
  if (relation === "same_worktree") return 0;
  if (relation === "same_clone") return 1;
  if (relation === "same_project") return 2;
  return 3;
}

function isPeerVisible(
  peer: PeerCandidate,
  request: StoreAnnounceRequest,
  requestedScopes: Scope[],
): boolean {
  if (request.trafficScope === "machine") return true;
  if (peer.relation === "other_project") return false;
  if (request.trafficScope === "project") return true;

  return peer.relation === "same_worktree"
    || isSameBranchPeer(peer, request)
    || peerOverlapsRequestedScopes(peer, request, requestedScopes);
}

function peerActionRank(
  peer: PeerCandidate,
  request: StoreAnnounceRequest,
  requestedScopes: Scope[],
): number {
  if (peerOverlapsRequestedScopes(peer, request, requestedScopes)) return 0;
  if (isSameBranchPeer(peer, request)) return 1;
  if (peer.relation === "same_worktree") return 2;
  if (peer.relation !== "other_project") return 3;
  return 4;
}

function peerOverlapsRequestedScopes(
  peer: PeerCandidate,
  request: StoreAnnounceRequest,
  requestedScopes: Scope[],
): boolean {
  if (peer.relation === "other_project") return false;
  const ignoreCase = request.metadata.ignoreCase || peer.ignoreCase;
  return requestedScopes.some((incoming) =>
    peer.scopes.some((existing) => scopesOverlap(incoming, existing, ignoreCase)),
  );
}

function isSameBranchPeer(peer: PeerCandidate, request: StoreAnnounceRequest): boolean {
  return peer.relation !== "same_worktree"
    && peer.relation !== "other_project"
    && request.metadata.branch !== null
    && peer.branch === request.metadata.branch;
}

function stripPeerCandidate(candidate: PeerCandidate): Peer {
  const { ignoreCase: _, updatedAtMs: __, ...peer } = candidate;
  return peer;
}

function emptyHiddenPeerCounts(): HiddenPeerCounts {
  return {
    same_worktree: 0,
    same_clone: 0,
    same_project: 0,
    other_project: 0,
  };
}

function compareBlockers(left: Blocker, right: Blocker): number {
  return (
    relationRank(left.relation) - relationRank(right.relation) ||
    left.agent_id.localeCompare(right.agent_id) ||
    left.path.localeCompare(right.path) ||
    left.access.localeCompare(right.access)
  );
}

function uniqueAgentIds(peers: Peer[]): string[] {
  return [...new Set(peers.map((peer) => peer.agent_id))].sort((a, b) => a.localeCompare(b));
}

function fromNullableBoolean(value: number | null): boolean | null {
  return value === null ? null : Boolean(value);
}

function parseDirtyPaths(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

// The latest blocker expiry, not the earliest: retry_at answers "how long
// could I possibly have to wait?", and only the upper bound lets a caller
// decide between waiting and escalating. Retrying earlier is always allowed.
function latestBlockerExpiryMs(blockedScopes: BlockedScope[]): number | null {
  let latest: number | null = null;
  for (const scope of blockedScopes) {
    for (const blocker of scope.blockers) {
      const expiresMs = Date.parse(blocker.expires_at);
      if (latest === null || expiresMs > latest) {
        latest = expiresMs;
      }
    }
  }
  return latest;
}

function formatWaitMinutes(waitMs: number): string {
  return `~${Math.max(1, Math.round(waitMs / 60_000))}m`;
}

// Blocked callers tend to escalate to their human when the response gives no
// decision rule. retry_at bounds the worst-case wait, so tell the caller
// directly when waiting beats interrupting the user.
function retryAdvice(retryAtMs: number | null, nowMs: number): string {
  if (retryAtMs === null) return "";
  return ` Every blocker lease expires within ${formatWaitMinutes(retryAtMs - nowMs)} (retry_at) and may release sooner via done; if you can wait, re-announce these scopes to retry instead of interrupting the user`;
}

function statusMessage(
  status: Exclude<AnnounceOutput["status"], "completed" | "stopped">,
  state: AgentState,
  grantedCount: number,
  blockedCount: number,
  retryAtMs: number | null,
  nowMs: number,
): string {
  if (status === "granted" && state === "testing") {
    return grantedCount === 0
      ? "Testing announced; no paths advertised and no claims held"
      : `Testing announced; ${grantedCount} path${grantedCount === 1 ? " is" : "s are"} advertised but no longer claimed, so peers can edit them`;
  }
  if (status === "granted") {
    return grantedCount === 0
      ? "Traffic received; no scopes claimed and no known conflict"
      : `No known conflict for ${grantedCount} announced scope${grantedCount === 1 ? "" : "s"}`;
  }
  if (status === "partial") {
    return `No known conflict on ${grantedCount} scope${grantedCount === 1 ? "" : "s"}; coordinate before ${blockedCount}.${retryAdvice(retryAtMs, nowMs)}`;
  }
  return `Coordinate before editing; ${blockedCount} requested scope${blockedCount === 1 ? " is" : "s are"} blocked.${retryAdvice(retryAtMs, nowMs)}`;
}

function withBusyRetry<T>(operation: () => T): T {
  let lastError: unknown;
  for (const delayMs of BUSY_RETRY_DELAYS_MS) {
    if (delayMs > 0) Bun.sleepSync(delayMs);
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code.startsWith("SQLITE_BUSY") || /database (?:is )?(?:busy|locked)/i.test(error.message);
}

function initializeSchema(database: Database): void {
  // The whole check-drop-create-stamp sequence runs under one write lock and
  // re-reads the version inside it. Otherwise two processes upgrading the same
  // old database can interleave: the second DROP would silently destroy leases
  // the first process already re-created.
  let transactionOpen = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const row = database.query("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > SCHEMA_VERSION) {
      // A newer checkout owns this database; an older binary must not clobber it.
      throw new Error(
        `Unsupported Agent Frequency state schema ${row.user_version}; remove the ephemeral database to reset`,
      );
    }
    if (row.user_version !== 0 && row.user_version < SCHEMA_VERSION) {
      // Leases live at most two hours, so the state is ephemeral by contract.
      // Recreating on upgrade beats maintaining migrations for throwaway rows.
      database.exec(
        "DROP TABLE IF EXISTS claims; DROP TABLE IF EXISTS leases; DROP TABLE IF EXISTS activity_events;",
      );
    }
    database.exec(SCHEMA);
    // Surface metadata is additive within schema v2 so already-running MCP
    // processes can keep writing; their rows receive the unknown default.
    addColumnIfMissing(
      database,
      "leases",
      "client_surface",
      "TEXT NOT NULL DEFAULT 'unknown' CHECK (client_surface IN ('t3-code', 'codex-app', 'claude-app', 'cli', 'unknown'))",
    );
    addColumnIfMissing(
      database,
      "activity_events",
      "client_surface",
      "TEXT NOT NULL DEFAULT 'unknown' CHECK (client_surface IN ('t3-code', 'codex-app', 'claude-app', 'cli', 'unknown'))",
    );
    addColumnIfMissing(
      database,
      "leases",
      "agent_state",
      "TEXT NOT NULL DEFAULT 'working' CHECK (agent_state IN ('working', 'done'))",
    );
    addColumnIfMissing(
      database,
      "activity_events",
      "agent_state",
      "TEXT NOT NULL DEFAULT 'working' CHECK (agent_state IN ('working', 'done'))",
    );
    // "testing" is a third agent state, but widening the agent_state CHECK
    // means recreating both tables, which drops every live lease and the whole
    // seven-day activity feed and makes already-running v2 processes fail on
    // their next announce. An additive flag keeps all of that alive: older
    // processes simply never set it, and their rows read back as "working".
    addColumnIfMissing(
      database,
      "leases",
      "testing",
      "INTEGER NOT NULL DEFAULT 0 CHECK (testing IN (0, 1))",
    );
    addColumnIfMissing(
      database,
      "activity_events",
      "testing",
      "INTEGER NOT NULL DEFAULT 0 CHECK (testing IN (0, 1))",
    );
    // "stopped" follows the testing precedent exactly: a terminal state
    // carried as an additive flag beside agent_state "done" rather than a
    // widened CHECK. It only ever describes events (a stopped lease is
    // deleted), so the leases table never carries it. The reason and the
    // blocker identities ride along the same way — display and orientation
    // data, nullable or defaulted so older processes' rows stay valid.
    addColumnIfMissing(
      database,
      "activity_events",
      "stopped",
      "INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1))",
    );
    addColumnIfMissing(
      database,
      "activity_events",
      "reason",
      "TEXT CHECK (reason IS NULL OR length(reason) <= 200)",
    );
    addColumnIfMissing(
      database,
      "activity_events",
      "blockers",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    // The task emoji is display-only, so it stays additive and nullable for the
    // same reason: rolling it out must not drop a live lease or the feed, and
    // rows written by an older process simply carry no emoji.
    addColumnIfMissing(
      database,
      "leases",
      "emoji",
      `TEXT CHECK (emoji IS NULL OR length(emoji) <= ${MAX_EMOJI_LENGTH})`,
    );
    addColumnIfMissing(
      database,
      "activity_events",
      "emoji",
      `TEXT CHECK (emoji IS NULL OR length(emoji) <= ${MAX_EMOJI_LENGTH})`,
    );
    if (row.user_version !== SCHEMA_VERSION) {
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function addColumnIfMissing(
  database: Database,
  table: "leases" | "activity_events",
  column: string,
  definition: string,
): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existing) => existing.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_label TEXT NOT NULL,
  client_surface TEXT NOT NULL DEFAULT 'unknown'
    CHECK (client_surface IN ('t3-code', 'codex-app', 'claude-app', 'cli', 'unknown')),
  agent_state TEXT NOT NULL DEFAULT 'working'
    CHECK (agent_state IN ('working', 'done')),
  testing INTEGER NOT NULL DEFAULT 0 CHECK (testing IN (0, 1)),
  summary TEXT NOT NULL,
  emoji TEXT CHECK (emoji IS NULL OR length(emoji) <= ${MAX_EMOJI_LENGTH}),
  project_id TEXT NOT NULL,
  local_repo_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  worktree_root TEXT NOT NULL,
  branch TEXT,
  head_oid TEXT,
  ignore_case INTEGER NOT NULL CHECK (ignore_case IN (0, 1)),
  dirty INTEGER CHECK (dirty IS NULL OR dirty IN (0, 1)),
  dirty_count INTEGER,
  dirty_paths TEXT NOT NULL DEFAULT '[]',
  metadata_complete INTEGER NOT NULL CHECK (metadata_complete IN (0, 1)),
  timebox_seconds INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  lease_id TEXT NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('shared', 'exclusive')),
  PRIMARY KEY (lease_id, path)
);

CREATE INDEX IF NOT EXISTS leases_project_expiry
ON leases(project_id, expires_at_ms);

CREATE INDEX IF NOT EXISTS claims_path
ON claims(path);

-- Additive defaults let already-running v2 MCP processes keep announcing
-- during rollout while newer sessions attach surface and lifecycle metadata.
CREATE TABLE IF NOT EXISTS activity_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('announced', 'renewed')),
  status TEXT NOT NULL CHECK (status IN ('granted', 'partial', 'blocked')),
  agent_id TEXT NOT NULL,
  agent_label TEXT NOT NULL,
  client_surface TEXT NOT NULL DEFAULT 'unknown'
    CHECK (client_surface IN ('t3-code', 'codex-app', 'claude-app', 'cli', 'unknown')),
  agent_state TEXT NOT NULL DEFAULT 'working'
    CHECK (agent_state IN ('working', 'done')),
  testing INTEGER NOT NULL DEFAULT 0 CHECK (testing IN (0, 1)),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  summary TEXT NOT NULL,
  emoji TEXT CHECK (emoji IS NULL OR length(emoji) <= ${MAX_EMOJI_LENGTH}),
  repo_name TEXT NOT NULL,
  worktree_root TEXT NOT NULL,
  branch TEXT,
  requested_scope_count INTEGER NOT NULL,
  granted_scope_count INTEGER NOT NULL,
  blocked_scope_count INTEGER NOT NULL,
  blockers TEXT NOT NULL DEFAULT '[]',
  peer_count INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_events_created
ON activity_events(created_at_ms DESC, event_id DESC);
`;
