import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { AgentFrequencyStore } from "../src/store";
import type { GitMetadata, Scope, StoreAnnounceRequest, Timebox } from "../src/types";

const stores: AgentFrequencyStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): AgentFrequencyStore {
  return createStoreWithPath().store;
}

function createStoreWithPath(): { store: AgentFrequencyStore; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-frequency-store-test-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "state.sqlite3");
  const store = new AgentFrequencyStore({ dbPath });
  stores.push(store);
  return { store, dbPath };
}

function metadata(overrides: Partial<GitMetadata> = {}): GitMetadata {
  return {
    projectId: "project-1",
    localRepoId: "clone-1",
    repoName: "example",
    worktreeId: "worktree-1",
    worktreeRoot: "/code/example",
    gitDir: "/code/example/.git",
    gitCommonDir: "/code/example/.git",
    branch: "main",
    headOid: "abc123",
    ignoreCase: false,
    origin: "git@example.com:team/example.git",
    dirty: false,
    dirtyCount: 0,
    dirtyPaths: [],
    metadataComplete: true,
    ...overrides,
  };
}

function request(
  agentId: string,
  scopes: Scope[],
  overrides: Partial<StoreAnnounceRequest> = {},
): StoreAnnounceRequest {
  return {
    agentId,
    agentLabel: agentId,
    summary: `${agentId} work`,
    metadata: metadata(),
    scopes,
    timebox: "15m",
    nowMs: 1_800_000_000_000,
    ...overrides,
    clientSurface: overrides.clientSurface ?? "cli",
    state: overrides.state ?? "working",
    trafficScope: overrides.trafficScope ?? "worktree",
  };
}

describe("AgentFrequencyStore.announce", () => {
  test("grants shared overlaps and returns a deterministic warning", () => {
    const store = createStore();
    store.announce(request("alpha", [{ path: "src/auth", access: "shared" }]));

    const result = store.announce(
      request(
        "bravo",
        [{ path: "src/auth/token.ts", access: "shared" }],
        { metadata: metadata({ worktreeId: "worktree-2", worktreeRoot: "/code/example-bravo" }) },
      ),
    );

    expect(result.status).toBe("granted");
    expect(result.self.granted_scopes).toEqual([
      { path: "src/auth/token.ts", access: "shared" },
    ]);
    expect(result.warnings.find((warning) => warning.code === "SHARED_SCOPE_OVERLAP")).toEqual({
      code: "SHARED_SCOPE_OVERLAP",
      message: "Shared scopes overlap: src/auth/token.ts with alpha:src/auth",
    });
  });

  test("blocks every overlapping claim involving exclusive access", () => {
    const store = createStore();
    const first = store.announce(
      request("alpha", [{ path: "src/auth", access: "exclusive" }]),
    );
    const second = store.announce(
      request("bravo", [{ path: "src/auth/token.ts", access: "shared" }]),
    );

    expect(first.status).toBe("granted");
    expect(second.status).toBe("blocked");
    expect(second.self.granted_scopes).toEqual([]);
    expect(second.self.blocked_scopes).toEqual([
      {
        path: "src/auth/token.ts",
        access: "shared",
        blockers: [
          {
            agent_id: "alpha",
            relation: "same_worktree",
            path: "src/auth",
            access: "exclusive",
            expires_at: first.self.expires_at!,
          },
        ],
      },
    ]);
    expect(JSON.stringify(second)).not.toContain(first.self.lease_id);
  });

  test("persists only granted claims after a partial result", () => {
    const store = createStore();
    store.announce(request("alpha", [{ path: "src/auth", access: "exclusive" }]));
    const partial = store.announce(
      request("bravo", [
        { path: "src/auth/token.ts", access: "shared" },
        { path: "docs", access: "exclusive" },
      ]),
    );

    expect(partial.status).toBe("partial");
    expect(partial.self.granted_scopes).toEqual([{ path: "docs", access: "exclusive" }]);

    const observer = store.announce(request("charlie", []));
    const bravo = observer.peers.find((peer) => peer.agent_id === "bravo");
    expect(bravo?.scopes).toEqual([{ path: "docs", access: "exclusive" }]);
  });

  test("renews an opaque lease with an exact new TTL and replaces its claims", () => {
    const store = createStore();
    const first = store.announce(request("alpha", [{ path: "src", access: "shared" }]));
    const renewalTime = 1_800_000_100_000;
    const renewed = store.announce(
      request("alpha", [{ path: "docs", access: "exclusive" }], {
        leaseId: first.self.lease_id!,
        timebox: "1h",
        nowMs: renewalTime,
      }),
    );

    expect(renewed.self.renewed).toBeTrue();
    expect(renewed.self.lease_id).toBe(first.self.lease_id);
    expect(renewed.self.expires_at).toBe(new Date(renewalTime + 60 * 60 * 1_000).toISOString());

    const observer = store.announce(request("bravo", [], { nowMs: renewalTime }));
    expect(observer.peers.find((peer) => peer.agent_id === "alpha")?.scopes).toEqual([
      { path: "docs", access: "exclusive" },
    ]);
  });

  test("uses physical identity across process and origin changes but rejects another repository", () => {
    const store = createStore();
    const first = store.announce(request("alpha-process-one", []));
    const renewed = store.announce(
      request("alpha-process-two", [], { leaseId: first.self.lease_id! }),
    );

    expect(renewed.self.renewed).toBeTrue();
    expect(renewed.self.agent_id).toBe("alpha-process-two");
    const originChanged = store.announce(
      request("alpha-process-two", [], {
        leaseId: first.self.lease_id!,
        metadata: metadata({ projectId: "origin-probe-changed" }),
      }),
    );
    expect(originChanged.self.renewed).toBeTrue();
    expect(() =>
      store.announce(
        request("alpha-process-two", [], {
          leaseId: first.self.lease_id!,
          metadata: metadata({
            projectId: "another-project",
            localRepoId: "another-clone",
            worktreeId: "another-worktree",
          }),
        }),
      ),
    ).toThrow("different project");
  });

  test("physical worktree identity wins if remote-derived project identity changes", () => {
    const store = createStore();
    store.announce(request("alpha", [{ path: "src", access: "exclusive" }]));

    const result = store.announce(
      request("bravo", [{ path: "src/file.ts", access: "shared" }], {
        metadata: metadata({ projectId: "origin-temporarily-unavailable" }),
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.peers[0]?.relation).toBe("same_worktree");
  });

  test("expires old leases before checking a new claim", () => {
    const store = createStore();
    const start = 1_800_000_000_000;
    store.announce(
      request("alpha", [{ path: ".", access: "exclusive" }], {
        nowMs: start,
        timebox: "15m",
      }),
    );

    const next = store.announce(
      request("bravo", [{ path: "src", access: "exclusive" }], {
        nowMs: start + 15 * 60 * 1_000,
      }),
    );
    expect(next.status).toBe("granted");
    expect(next.peers).toEqual([]);
  });

  test("classifies clone and project peers and warns about matching branches", () => {
    const store = createStore();
    store.announce(
      request("clone-peer", [], {
        metadata: metadata({ worktreeId: "worktree-2", worktreeRoot: "/code/example-two" }),
      }),
    );
    store.announce(
      request("project-peer", [], {
        metadata: metadata({
          localRepoId: "clone-2",
          worktreeId: "worktree-3",
          worktreeRoot: "/other/example",
        }),
      }),
    );

    const result = store.announce(request("self", []));
    expect(result.peers.map((peer) => [peer.agent_id, peer.relation])).toEqual([
      ["clone-peer", "same_clone"],
      ["project-peer", "same_project"],
    ]);
    expect(result.warnings.find((warning) => warning.code === "SAME_BRANCH")?.message).toBe(
      "Agents on branch main: clone-peer, project-peer",
    );
  });

  test("defaults to actionable traffic and widens explicitly", () => {
    const store = createStore();
    store.announce(
      request("worktree-peer", [], {
        metadata: metadata({ branch: "worktree-topic" }),
      }),
    );
    store.announce(
      request("overlap-peer", [{ path: "Src/Auth", access: "shared" }], {
        metadata: metadata({
          worktreeId: "worktree-2",
          worktreeRoot: "/code/example-two",
          branch: "overlap-topic",
          ignoreCase: true,
        }),
      }),
    );
    store.announce(
      request("same-branch-peer", [], {
        metadata: metadata({
          localRepoId: "clone-2",
          worktreeId: "worktree-3",
          worktreeRoot: "/other/example",
        }),
      }),
    );
    store.announce(
      request("idle-project-peer", [], {
        metadata: metadata({
          localRepoId: "clone-3",
          worktreeId: "worktree-4",
          worktreeRoot: "/elsewhere/example",
          branch: "idle-topic",
        }),
      }),
    );
    store.announce(
      request("other-project-peer", [], {
        metadata: metadata({
          projectId: "project-2",
          localRepoId: "clone-4",
          worktreeId: "worktree-5",
          repoName: "unrelated",
          worktreeRoot: "/code/unrelated",
        }),
      }),
    );

    const narrow = store.announce(
      request("self", [{ path: "src/auth/token.ts", access: "shared" }]),
    );

    expect(narrow.traffic_scope).toBe("worktree");
    expect(narrow.peers.map((peer) => peer.agent_id)).toEqual([
      "overlap-peer",
      "same-branch-peer",
      "worktree-peer",
    ]);
    expect(narrow.hidden_peers).toEqual({
      same_worktree: 0,
      same_clone: 0,
      same_project: 1,
      other_project: 1,
    });
    expect(narrow.peers_truncated).toBe(0);
    expect(narrow.warnings.some((warning) => warning.code === "SHARED_SCOPE_OVERLAP")).toBeTrue();
    expect(narrow.warnings.some((warning) => warning.code === "SAME_BRANCH")).toBeTrue();

    const project = store.announce(
      request("self", [{ path: "src/auth/token.ts", access: "shared" }], {
        leaseId: narrow.self.lease_id!,
        trafficScope: "project",
        nowMs: 1_800_000_001_000,
      }),
    );
    expect(project.peers.map((peer) => peer.agent_id)).toEqual([
      "overlap-peer",
      "same-branch-peer",
      "worktree-peer",
      "idle-project-peer",
    ]);
    expect(project.hidden_peers.other_project).toBe(1);

    const machine = store.announce(
      request("self", [{ path: "src/auth/token.ts", access: "shared" }], {
        leaseId: project.self.lease_id!,
        trafficScope: "machine",
        nowMs: 1_800_000_002_000,
      }),
    );
    expect(machine.peers.map((peer) => peer.agent_id)).toEqual([
      "overlap-peer",
      "same-branch-peer",
      "worktree-peer",
      "idle-project-peer",
      "other-project-peer",
    ]);
    expect(machine.hidden_peers).toEqual({
      same_worktree: 0,
      same_clone: 0,
      same_project: 0,
      other_project: 0,
    });
  });

  test("hides other projects by default without cross-project blocking", () => {
    const store = createStore();
    store.announce(
      request("other", [{ path: ".", access: "exclusive" }], {
        metadata: metadata({
          projectId: "project-2",
          localRepoId: "clone-2",
          worktreeId: "worktree-2",
          repoName: "another-project",
          worktreeRoot: "/code/another-project",
        }),
      }),
    );
    store.announce(request("related", [], { metadata: metadata({ worktreeId: "worktree-3" }) }));

    const result = store.announce(request("self", [{ path: "src", access: "exclusive" }]));
    expect(result.status).toBe("granted");
    expect(result.peers.map((peer) => [peer.agent_id, peer.relation])).toEqual([
      ["related", "same_clone"],
    ]);
    expect(result.hidden_peers.other_project).toBe(1);
    expect(result.warnings.some((warning) => warning.code === "SAME_BRANCH")).toBeTrue();
    expect(
      result.self.blocked_scopes.flatMap((scope) => scope.blockers).some(
        (blocker) => blocker.agent_id === "other",
      ),
    ).toBeFalse();

    const expanded = store.announce(
      request("self", [{ path: "src", access: "exclusive" }], {
        leaseId: result.self.lease_id!,
        trafficScope: "machine",
        nowMs: 1_800_000_001_000,
      }),
    );
    expect(expanded.peers.map((peer) => [peer.agent_id, peer.relation])).toEqual([
      ["related", "same_clone"],
      ["other", "other_project"],
    ]);
  });

  test("filters hidden traffic before applying the peer cap", () => {
    const store = createStore();
    for (let index = 0; index < 21; index += 1) {
      store.announce(
        request(`other-${index}`, [], {
          metadata: metadata({
            projectId: `project-${index + 2}`,
            localRepoId: `clone-${index + 2}`,
            worktreeId: `worktree-${index + 2}`,
            repoName: `other-${index}`,
            worktreeRoot: `/code/other-${index}`,
          }),
        }),
      );
    }
    store.announce(request("worktree-peer", []));

    const narrow = store.announce(request("self", []));
    expect(narrow.peers.map((peer) => peer.agent_id)).toEqual(["worktree-peer"]);
    expect(narrow.hidden_peers.other_project).toBe(21);
    expect(narrow.peers_truncated).toBe(0);

    const machine = store.announce(
      request("self", [], {
        leaseId: narrow.self.lease_id!,
        trafficScope: "machine",
        nowMs: 1_800_000_001_000,
      }),
    );
    expect(machine.peers).toHaveLength(20);
    expect(machine.peers_truncated).toBe(2);
  });

  test("replaces an unknown or expired lease ID without a second call", () => {
    const store = createStore();
    const result = store.announce(
      request("alpha", [], { leaseId: "00000000000000000000000000000000" }),
    );
    expect(result.self.renewed).toBeFalse();
    expect(result.self.lease_id).toMatch(/^[a-f0-9]{32}$/);
    expect(result.self.lease_id).not.toBe("00000000000000000000000000000000");
  });

  test.each(["15m", "30m", "1h", "2h"] satisfies Timebox[])(
    "uses the exact %s timebox",
    (timebox) => {
      const store = createStore();
      const nowMs = 1_800_000_000_000;
      const seconds = { "15m": 900, "30m": 1_800, "1h": 3_600, "2h": 7_200 }[timebox];
      const result = store.announce(request("alpha", [], { nowMs, timebox }));
      expect(result.self.expires_at).toBe(new Date(nowMs + seconds * 1_000).toISOString());
    },
  );

  test("supersedes its own stale lease instead of self-blocking when the lease ID is lost", () => {
    const store = createStore();
    store.announce(request("alpha", [{ path: "src/auth", access: "exclusive" }]));

    const fresh = store.announce(request("alpha", [{ path: "src/auth", access: "exclusive" }]));
    expect(fresh.status).toBe("granted");
    expect(fresh.self.renewed).toBeFalse();
    expect(fresh.peers).toEqual([]);

    const observer = store.announce(request("bravo", []));
    expect(observer.peers.filter((peer) => peer.agent_id === "alpha")).toHaveLength(1);
  });

  test("announces completion, releases claims, and retains a done activity event", () => {
    const { store, dbPath } = createStoreWithPath();
    const first = store.announce(
      request("alpha", [{ path: "src/auth", access: "exclusive" }]),
    );
    const blocked = store.announce(
      request("bravo", [{ path: "src/auth/token.ts", access: "shared" }], {
        nowMs: 1_800_000_001_000,
      }),
    );
    expect(blocked.status).toBe("blocked");

    const completed = store.announce(
      request("alpha", [{ path: "stale/claim", access: "exclusive" }], {
        state: "done",
        summary: "Finished authentication work",
        leaseId: first.self.lease_id!,
        nowMs: 1_800_000_002_000,
      }),
    );

    expect(completed.status).toBe("completed");
    expect(completed.self).toMatchObject({
      lease_id: null,
      active: false,
      state: "done",
      expires_at: null,
      renew_after: null,
      timebox: null,
      granted_scopes: [],
      blocked_scopes: [],
    });
    expect(completed.peers.find((peer) => peer.agent_id === "alpha")).toBeUndefined();
    expect(completed.peers.find((peer) => peer.agent_id === "bravo")?.state).toBe("working");

    const next = store.announce(
      request("charlie", [{ path: "src/auth", access: "exclusive" }], {
        nowMs: 1_800_000_003_000,
      }),
    );
    expect(next.status).toBe("granted");

    const database = new Database(dbPath, { readonly: true });
    const active = database
      .query("SELECT count(*) AS total FROM leases WHERE agent_id = 'alpha'")
      .get() as { total: number };
    const event = database
      .query(
        `SELECT agent_state, status, requested_scope_count, granted_scope_count, blocked_scope_count
         FROM activity_events WHERE agent_id = 'alpha' ORDER BY event_id DESC LIMIT 1`,
      )
      .get() as Record<string, unknown>;
    database.close(false);

    expect(active.total).toBe(0);
    expect(event).toEqual({
      agent_state: "done",
      status: "granted",
      requested_scope_count: 0,
      granted_scope_count: 0,
      blocked_scope_count: 0,
    });
  });

  test("keeps the same agent's leases in other worktrees when it announces fresh", () => {
    const store = createStore();
    store.announce(request("alpha", [{ path: "src/auth", access: "exclusive" }]));
    store.announce(
      request("alpha", [{ path: "docs", access: "shared" }], {
        metadata: metadata({ worktreeId: "worktree-2", worktreeRoot: "/code/example-two" }),
      }),
    );

    const observer = store.announce(request("bravo", []));
    expect(observer.peers.filter((peer) => peer.agent_id === "alpha")).toHaveLength(2);

    const blocked = store.announce(
      request("charlie", [{ path: "src/auth/token.ts", access: "shared" }]),
    );
    expect(blocked.status).toBe("blocked");
  });

  test("shares dirty paths with peers, bounded to the storage cap", () => {
    const store = createStore();
    const dirtyPaths = Array.from({ length: 45 }, (_, index) => `src/file-${index}.ts`);
    store.announce(
      request("alpha", [], {
        metadata: metadata({ dirty: true, dirtyCount: 45, dirtyPaths }),
      }),
    );

    const observer = store.announce(request("bravo", []));
    const alpha = observer.peers.find((peer) => peer.agent_id === "alpha");
    expect(alpha?.dirty).toBeTrue();
    expect(alpha?.dirty_paths).toHaveLength(40);
    expect(alpha?.dirty_paths.slice(0, 2)).toEqual(["src/file-0.ts", "src/file-1.ts"]);
  });

  test("records granted, blocked, and renewed announcements without lease handles", () => {
    const { store, dbPath } = createStoreWithPath();
    const first = store.announce(
      request("alpha", [{ path: "src", access: "exclusive" }]),
    );
    store.announce(
      request("bravo", [{ path: "src/file.ts", access: "shared" }], {
        nowMs: 1_800_000_001_000,
      }),
    );
    store.announce(
      request("alpha", [{ path: "docs", access: "shared" }], {
        leaseId: first.self.lease_id!,
        nowMs: 1_800_000_002_000,
      }),
    );

    const database = new Database(dbPath, { readonly: true });
    const events = database
      .query(
        `SELECT event_type, status, agent_id, client_surface, requested_scope_count,
                granted_scope_count, blocked_scope_count
         FROM activity_events ORDER BY event_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    const rawEvents = JSON.stringify(events);
    database.close(false);

    expect(events).toEqual([
      {
        event_type: "announced",
        status: "granted",
        agent_id: "alpha",
        client_surface: "cli",
        requested_scope_count: 1,
        granted_scope_count: 1,
        blocked_scope_count: 0,
      },
      {
        event_type: "announced",
        status: "blocked",
        agent_id: "bravo",
        client_surface: "cli",
        requested_scope_count: 1,
        granted_scope_count: 0,
        blocked_scope_count: 1,
      },
      {
        event_type: "renewed",
        status: "granted",
        agent_id: "alpha",
        client_surface: "cli",
        requested_scope_count: 1,
        granted_scope_count: 1,
        blocked_scope_count: 0,
      },
    ]);
    expect(rawEvents).not.toContain(first.self.lease_id);
  });

  test("prunes activity older than seven days on the next announcement", () => {
    const { store, dbPath } = createStoreWithPath();
    const nowMs = 1_800_000_000_000;
    store.announce(request("old", [], { nowMs: nowMs - 8 * 24 * 60 * 60 * 1_000 }));
    store.announce(request("current", [], { nowMs }));

    const database = new Database(dbPath, { readonly: true });
    const events = database
      .query("SELECT agent_id FROM activity_events ORDER BY event_id ASC")
      .all() as Array<{ agent_id: string }>;
    database.close(false);

    expect(events).toEqual([{ agent_id: "current" }]);
  });

  test("caps retained activity at one thousand rows", () => {
    const { store, dbPath } = createStoreWithPath();
    const nowMs = 1_800_000_000_000;
    const database = new Database(dbPath, { strict: true });
    const insert = database.query(
      `INSERT INTO activity_events (
         event_type, status, agent_id, agent_label, summary, repo_name, worktree_root,
         branch, requested_scope_count, granted_scope_count, blocked_scope_count,
         peer_count, created_at_ms
       ) VALUES ('announced', 'granted', ?, 'Agent', 'work', 'example', '/code/example',
                 'main', 0, 0, 0, 0, ?)`,
    );
    database.exec("BEGIN");
    for (let index = 0; index < 1_001; index += 1) {
      insert.run(`seed-${index}`, nowMs - 2_000 + index);
    }
    database.exec("COMMIT");
    database.close(false);

    store.announce(request("current", [], { nowMs }));

    const readOnly = new Database(dbPath, { readonly: true });
    const count = readOnly
      .query("SELECT count(*) AS total FROM activity_events")
      .get() as { total: number };
    const newest = readOnly
      .query("SELECT agent_id FROM activity_events ORDER BY created_at_ms DESC, event_id DESC LIMIT 1")
      .get() as { agent_id: string };
    readOnly.close(false);

    expect(count.total).toBe(1_000);
    expect(newest.agent_id).toBe("current");
  });
});

describe("AgentFrequencyStore schema versioning", () => {
  test("adds client surface and lifecycle metadata to an existing v2 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-frequency-store-test-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "state.sqlite3");

    const original = new AgentFrequencyStore({ dbPath });
    original.close();
    const oldV2 = new Database(dbPath, { strict: true });
    oldV2.exec("ALTER TABLE leases DROP COLUMN client_surface");
    oldV2.exec("ALTER TABLE activity_events DROP COLUMN client_surface");
    oldV2.exec("ALTER TABLE leases DROP COLUMN agent_state");
    oldV2.exec("ALTER TABLE activity_events DROP COLUMN agent_state");
    oldV2.close(false);

    const upgraded = new AgentFrequencyStore({ dbPath });
    stores.push(upgraded);
    const result = upgraded.announce(request("alpha", [], { clientSurface: "t3-code" }));

    const database = new Database(dbPath, { readonly: true });
    const event = database
      .query("SELECT client_surface, agent_state FROM activity_events LIMIT 1")
      .get() as { client_surface: string; agent_state: string };
    database.close(false);
    expect(result.self.surface).toBe("t3-code");
    expect(result.self.state).toBe("working");
    expect(event.client_surface).toBe("t3-code");
    expect(event.agent_state).toBe("working");
  });

  test("recreates ephemeral state written by an older schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-frequency-store-test-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "state.sqlite3");

    const old = new Database(dbPath, { create: true, strict: true });
    old.exec("CREATE TABLE leases (lease_id TEXT PRIMARY KEY)");
    old.exec("PRAGMA user_version = 1");
    old.close(false);

    const store = new AgentFrequencyStore({ dbPath });
    stores.push(store);
    expect(store.announce(request("alpha", [])).status).toBe("granted");
  });

  test("refuses state owned by a newer schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-frequency-store-test-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "state.sqlite3");

    const future = new Database(dbPath, { create: true, strict: true });
    future.exec("PRAGMA user_version = 99");
    future.close(false);

    expect(() => new AgentFrequencyStore({ dbPath })).toThrow("Unsupported Agent Frequency state schema");
  });
});
