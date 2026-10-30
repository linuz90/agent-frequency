import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { AgentFrequencyStore } from "../src/store";
import type { GitMetadata, StoreAnnounceRequest } from "../src/types";

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
  paths: string[],
  overrides: Partial<StoreAnnounceRequest> = {},
): StoreAnnounceRequest {
  return {
    agentId,
    agentLabel: agentId,
    summary: `${agentId} work`,
    metadata: metadata(),
    paths,
    nowMs: 1_800_000_000_000,
    ...overrides,
    clientSurface: overrides.clientSurface ?? "cli",
    state: overrides.state ?? "working",
    trafficScope: overrides.trafficScope ?? "worktree",
  };
}

describe("AgentFrequencyStore.announce", () => {
  test("warns both agents about overlapping paths in one worktree and never blocks", () => {
    const store = createStore();
    const first = store.announce(request("alpha", ["src/auth"]));
    const second = store.announce(request("bravo", ["src/auth/token.ts"]));

    expect(first.status).toBe("active");
    expect(second.status).toBe("active");
    expect(second.self.paths).toEqual(["src/auth/token.ts"]);
    expect(second.warnings.find((warning) => warning.code === "PATH_OVERLAP")).toEqual({
      code: "PATH_OVERLAP",
      message: "Agents in this worktree are editing overlapping paths: src/auth/token.ts with alpha:src/auth",
    });
    expect(second.message).toContain("nothing is locked");
    expect(second.peers).toMatchObject([{ agent_id: "alpha", paths: ["src/auth"] }]);
    expect(JSON.stringify(second)).not.toContain(first.self.lease_id);

    // The agent that announced first hears about the overlap on its next call.
    const renewed = store.announce(
      request("alpha", ["src/auth"], { leaseId: first.self.lease_id!, nowMs: 1_800_000_001_000 }),
    );
    expect(renewed.warnings.find((warning) => warning.code === "PATH_OVERLAP")?.message).toBe(
      "Agents in this worktree are editing overlapping paths: src/auth with bravo:src/auth/token.ts",
    );
  });

  test("shows overlapping paths in other worktrees as context, without a warning", () => {
    for (const [relation, trafficScope, peerMetadata] of [
      [
        "same_clone",
        "worktree",
        metadata({ worktreeId: "worktree-2", worktreeRoot: "/code/example-two" }),
      ],
      [
        "same_project",
        "project",
        metadata({
          localRepoId: "clone-2",
          worktreeId: "worktree-3",
          worktreeRoot: "/other/example",
        }),
      ],
      [
        "same_project",
        "machine",
        metadata({
          localRepoId: "clone-3",
          worktreeId: "worktree-4",
          worktreeRoot: "/elsewhere/example",
        }),
      ],
    ] as const) {
      const store = createStore();
      store.announce(request("alpha", ["src/auth"]));

      const result = store.announce(
        request("bravo", ["src/auth/token.ts"], {
          metadata: peerMetadata,
          trafficScope,
        }),
      );

      expect(result.status).toBe("active");
      expect(result.peers).toMatchObject([
        {
          agent_id: "alpha",
          relation,
          paths: ["src/auth"],
        },
      ]);
      expect(result.warnings.some((warning) => warning.code === "PATH_OVERLAP")).toBeFalse();
    }
  });

  test("reports missing dirty-file context without undermining worktree identity", () => {
    const store = createStore();
    const result = store.announce(
      request("alpha", [], {
        metadata: metadata({
          dirty: null,
          dirtyCount: null,
          dirtyPaths: [],
          metadataComplete: false,
        }),
      }),
    );

    expect(result.warnings.find((warning) => warning.code === "INCOMPLETE_GIT_METADATA"))
      .toEqual({
        code: "INCOMPLETE_GIT_METADATA",
        message: "Git status is unavailable; dirty-file context may be incomplete",
      });
  });

  test("renews an opaque lease with a fresh 30-minute window and replaces its paths", () => {
    const store = createStore();
    const first = store.announce(request("alpha", ["src"]));
    const renewalTime = 1_800_000_100_000;
    const renewed = store.announce(
      request("alpha", ["docs"], {
        leaseId: first.self.lease_id!,
        nowMs: renewalTime,
      }),
    );

    expect(renewed.self.renewed).toBeTrue();
    expect(renewed.self.lease_id).toBe(first.self.lease_id);
    expect(renewed.self.expires_at).toBe(new Date(renewalTime + 30 * 60 * 1_000).toISOString());
    expect(renewed.self.renew_after).toBe(new Date(renewalTime + 20 * 60 * 1_000).toISOString());

    const observer = store.announce(request("bravo", [], { nowMs: renewalTime }));
    expect(observer.peers.find((peer) => peer.agent_id === "alpha")?.paths).toEqual(["docs"]);
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
    store.announce(request("alpha", ["src"]));

    const result = store.announce(
      request("bravo", ["src/file.ts"], {
        metadata: metadata({ projectId: "origin-temporarily-unavailable" }),
      }),
    );

    expect(result.warnings.some((warning) => warning.code === "PATH_OVERLAP")).toBeTrue();
    expect(result.peers[0]?.relation).toBe("same_worktree");
  });

  test("expires old leases before listing peers", () => {
    const store = createStore();
    const start = 1_800_000_000_000;
    store.announce(request("alpha", ["."], { nowMs: start }));

    const next = store.announce(
      request("bravo", ["src"], {
        nowMs: start + 30 * 60 * 1_000,
      }),
    );
    expect(next.peers).toEqual([]);
    expect(next.warnings).toEqual([]);
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

  test("defaults to relevant traffic and widens explicitly", () => {
    const store = createStore();
    store.announce(
      request("worktree-peer", [], {
        metadata: metadata({ branch: "worktree-topic" }),
      }),
    );
    store.announce(
      request("overlap-peer", ["Src/Auth"], {
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
      request("self", ["src/auth/token.ts"]),
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
    expect(narrow.warnings.some((warning) => warning.code === "PATH_OVERLAP")).toBeFalse();
    expect(narrow.warnings.some((warning) => warning.code === "SAME_BRANCH")).toBeTrue();

    const project = store.announce(
      request("self", ["src/auth/token.ts"], {
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
      request("self", ["src/auth/token.ts"], {
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

  test("hides other projects by default", () => {
    const store = createStore();
    store.announce(
      request("other", ["."], {
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

    const result = store.announce(request("self", ["src"]));
    expect(result.peers.map((peer) => [peer.agent_id, peer.relation])).toEqual([
      ["related", "same_clone"],
    ]);
    expect(result.hidden_peers.other_project).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["SAME_BRANCH"]);

    const expanded = store.announce(
      request("self", ["src"], {
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

  test("supersedes its own stale lease instead of hearing itself when the lease ID is lost", () => {
    const store = createStore();
    store.announce(request("alpha", ["src/auth"]));

    const fresh = store.announce(request("alpha", ["src/auth"]));
    expect(fresh.self.renewed).toBeFalse();
    expect(fresh.peers).toEqual([]);
    expect(fresh.warnings).toEqual([]);

    const observer = store.announce(request("bravo", []));
    expect(observer.peers.filter((peer) => peer.agent_id === "alpha")).toHaveLength(1);
  });

  test("announces completion, releases the lease, and retains a done activity event", () => {
    const { store, dbPath } = createStoreWithPath();
    const first = store.announce(
      request("alpha", ["src/auth"]),
    );
    store.announce(
      request("bravo", ["src/auth/token.ts"], {
        nowMs: 1_800_000_001_000,
      }),
    );

    const completed = store.announce(
      request("alpha", ["stale/claim"], {
        state: "done",
        summary: "Finished authentication work",
        leaseId: first.self.lease_id!,
        nowMs: 1_800_000_002_000,
      }),
    );

    expect(completed.status).toBe("completed");
    expect(completed.self).toMatchObject({
      lease_id: null,
      state: "done",
      expires_at: null,
      renew_after: null,
      paths: [],
    });
    expect(completed.peers.find((peer) => peer.agent_id === "alpha")).toBeUndefined();
    expect(completed.peers.find((peer) => peer.agent_id === "bravo")?.paths).toEqual([
      "src/auth/token.ts",
    ]);

    const next = store.announce(
      request("charlie", ["src/auth"], {
        nowMs: 1_800_000_003_000,
      }),
    );
    expect(next.peers.map((peer) => peer.agent_id)).toEqual(["bravo"]);

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

  test("reads exclusive claims from older processes as plain paths that never block", () => {
    const { store, dbPath } = createStoreWithPath();
    const legacy = store.announce(request("legacy", ["src/auth"]));
    // An MCP process started before this version still writes exclusive
    // claims and the retired planning flag into the shared database.
    const database = new Database(dbPath, { strict: true });
    database
      .query("UPDATE claims SET access = 'exclusive' WHERE lease_id = ?")
      .run(legacy.self.lease_id!);
    database.query("UPDATE leases SET planning = 1 WHERE lease_id = ?").run(legacy.self.lease_id!);
    database.close(false);

    const result = store.announce(request("bravo", ["src/auth/token.ts"]));
    expect(result.status).toBe("active");
    expect(result.self.paths).toEqual(["src/auth/token.ts"]);
    expect(result.peers).toMatchObject([{ agent_id: "legacy", paths: ["src/auth"] }]);
    expect(result.warnings.some((warning) => warning.code === "PATH_OVERLAP")).toBeTrue();
  });

  test("writes leases that older processes read as advisory, on announce and on renewal", () => {
    // Processes started before awareness-only leases block whenever either
    // side of an overlap is exclusive, unless the peer lease is testing with
    // shared paths only. Every lease this version writes must look like that.
    const { store, dbPath } = createStoreWithPath();
    const first = store.announce(request("alpha", ["src/auth", "docs"]));
    store.announce(
      request("alpha", ["src"], { leaseId: first.self.lease_id!, nowMs: 1_800_000_001_000 }),
    );
    store.announce(request("bravo", ["tests"]));

    const database = new Database(dbPath, { readonly: true });
    const leases = database
      .query("SELECT agent_id, agent_state, testing FROM leases ORDER BY agent_id")
      .all();
    const accesses = database.query("SELECT DISTINCT access FROM claims").all();
    database.close(false);
    expect(leases).toEqual([
      { agent_id: "alpha", agent_state: "working", testing: 1 },
      { agent_id: "bravo", agent_state: "working", testing: 1 },
    ]);
    expect(accesses).toEqual([{ access: "shared" }]);
  });

  test("keeps the same agent's leases in other worktrees when it announces fresh", () => {
    const store = createStore();
    store.announce(request("alpha", ["src/auth"]));
    store.announce(
      request("alpha", ["docs"], {
        metadata: metadata({ worktreeId: "worktree-2", worktreeRoot: "/code/example-two" }),
      }),
    );

    const observer = store.announce(request("bravo", []));
    expect(observer.peers.filter((peer) => peer.agent_id === "alpha")).toHaveLength(2);

    const overlapping = store.announce(
      request("charlie", ["src/auth/token.ts"]),
    );
    expect(overlapping.warnings.find((warning) => warning.code === "PATH_OVERLAP")?.message).toBe(
      "Agents in this worktree are editing overlapping paths: src/auth/token.ts with alpha:src/auth",
    );
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

  test("records announcements and renewals without lease handles, never as blocked", () => {
    const { store, dbPath } = createStoreWithPath();
    const first = store.announce(
      request("alpha", ["src"]),
    );
    store.announce(
      request("bravo", ["src/file.ts"], {
        nowMs: 1_800_000_001_000,
      }),
    );
    store.announce(
      request("alpha", ["docs"], {
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
        status: "granted",
        agent_id: "bravo",
        client_surface: "cli",
        requested_scope_count: 1,
        granted_scope_count: 1,
        blocked_scope_count: 0,
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

describe("AgentFrequencyStore task emoji", () => {
  test("returns the announced emoji to the caller and to peers", () => {
    const store = createStore();
    store.announce(request("alpha", ["src/auth"], { emoji: "🐛" }));

    const result = store.announce(
      request("beta", ["src/billing"], { emoji: "🧾" }),
    );

    expect(result.self.emoji).toBe("🧾");
    expect(result.peers.map((peer) => peer.emoji)).toEqual(["🐛"]);
  });

  test("reports no emoji when none was announced", () => {
    const store = createStore();
    store.announce(request("alpha", []));

    const result = store.announce(request("beta", []));

    expect(result.self.emoji).toBeNull();
    expect(result.peers.map((peer) => peer.emoji)).toEqual([null]);
  });

  test("replaces the emoji when a renewal announces a different one", () => {
    const store = createStore();
    const first = store.announce(request("alpha", [], { emoji: "🐛" }));

    const renewed = store.announce(
      request("alpha", [], { emoji: "🧪", leaseId: first.self.lease_id ?? undefined }),
    );

    expect(renewed.self.renewed).toBe(true);
    expect(renewed.self.emoji).toBe("🧪");
    expect(store.announce(request("beta", [])).peers[0]?.emoji).toBe("🧪");
  });

  test("records the emoji on the activity event", () => {
    const { store, dbPath } = createStoreWithPath();
    store.announce(request("alpha", [], { emoji: "🚀" }));

    const database = new Database(dbPath, { readonly: true });
    const event = database
      .query("SELECT emoji FROM activity_events LIMIT 1")
      .get() as { emoji: string | null };
    database.close(false);
    expect(event.emoji).toBe("🚀");
  });
});

describe("AgentFrequencyStore schema versioning", () => {
  test("adds the emoji column to an existing v2 database without dropping leases", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-frequency-store-test-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "state.sqlite3");

    const original = new AgentFrequencyStore({ dbPath });
    original.announce(request("alpha", ["src/auth"]));
    original.close();
    const oldV2 = new Database(dbPath, { strict: true });
    oldV2.exec("ALTER TABLE leases DROP COLUMN emoji");
    oldV2.exec("ALTER TABLE activity_events DROP COLUMN emoji");
    oldV2.close(false);

    const upgraded = new AgentFrequencyStore({ dbPath });
    stores.push(upgraded);
    const result = upgraded.announce(request("beta", [], { emoji: "🐛" }));

    expect(result.self.emoji).toBe("🐛");
    // The lease written before the column existed survives, carrying no emoji.
    expect(result.peers.map((peer) => [peer.agent_id, peer.emoji])).toEqual([["alpha", null]]);
  });

  test("adds waiting_on to an existing v2 database without losing its stops", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-frequency-store-test-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "state.sqlite3");

    const original = new AgentFrequencyStore({ dbPath });
    const alpha = original.announce(request("alpha", ["src/auth"]));
    original.announce(
      request("alpha", [], {
        state: "stopped",
        reason: "out of ideas",
        leaseId: alpha.self.lease_id!,
        nowMs: 1_800_000_001_000,
      }),
    );
    original.close();
    const oldV2 = new Database(dbPath, { strict: true });
    oldV2.exec("ALTER TABLE activity_events DROP COLUMN waiting_on");
    oldV2.close(false);

    const upgraded = new AgentFrequencyStore({ dbPath });
    stores.push(upgraded);
    const bravo = upgraded.announce(request("bravo", [], { nowMs: 1_800_000_002_000 }));
    upgraded.announce(
      request("bravo", [], {
        state: "stopped",
        reason: "approve the token change?",
        waitingOn: "user",
        leaseId: bravo.self.lease_id!,
        nowMs: 1_800_000_003_000,
      }),
    );
    const observer = upgraded.announce(request("charlie", [], { nowMs: 1_800_000_004_000 }));

    // The stop written before the column existed reads back as unsaid.
    expect(
      observer.recent_peers.map((peer) => [peer.agent_id, peer.outcome, peer.waiting_on]),
    ).toEqual([
      ["bravo", "stopped", "user"],
      ["alpha", "stopped", null],
    ]);
  });

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
    expect(store.announce(request("alpha", [])).status).toBe("active");
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

describe("stopped announcements", () => {
  test("stopped releases the lease exactly like done", () => {
    const { store, dbPath } = createStoreWithPath();
    const alpha = store.announce(request("alpha", ["src/auth"]));
    const overlapping = store.announce(
      request("bravo", ["src/auth/token.ts"], {
        nowMs: 1_800_000_001_000,
      }),
    );
    expect(overlapping.warnings.some((warning) => warning.code === "PATH_OVERLAP")).toBeTrue();

    const stop = store.announce(
      request("alpha", [], {
        state: "stopped",
        reason: "waiting on user: keep or revert the token change",
        waitingOn: "user",
        leaseId: alpha.self.lease_id!,
        summary: "Auth refactor paused",
        nowMs: 1_800_000_002_000,
      }),
    );
    expect(stop.status).toBe("stopped");
    expect(stop.self).toMatchObject({ lease_id: null, state: "stopped" });
    expect(stop.message).toContain("Stop announced");

    const after = store.announce(
      request("bravo", ["src/auth/token.ts"], {
        leaseId: overlapping.self.lease_id!,
        nowMs: 1_800_000_003_000,
      }),
    );
    expect(after.peers).toEqual([]);
    expect(after.warnings.some((warning) => warning.code === "PATH_OVERLAP")).toBeFalse();

    // Storage keeps the v2 agent_state values and carries the stop additively,
    // beside the reason the caller gave.
    const database = new Database(dbPath, { readonly: true });
    const event = database
      .query(
        `SELECT agent_state, stopped, reason, waiting_on FROM activity_events
         WHERE agent_id = 'alpha' ORDER BY event_id DESC LIMIT 1`,
      )
      .get() as Record<string, unknown>;
    database.close(false);
    expect(event).toEqual({
      agent_state: "done",
      stopped: 1,
      reason: "waiting on user: keep or revert the token change",
      waiting_on: "user",
    });
  });

  test("waiting_on is recorded only on stops, and a stop may leave it unsaid", () => {
    const { store, dbPath } = createStoreWithPath();
    const alpha = store.announce(request("alpha", [], { waitingOn: "user" }));
    store.announce(
      request("alpha", [], {
        state: "stopped",
        reason: "waiting on the next stable release",
        waitingOn: "external",
        leaseId: alpha.self.lease_id!,
        nowMs: 1_800_000_001_000,
      }),
    );
    const bravo = store.announce(request("bravo", [], { nowMs: 1_800_000_002_000 }));
    store.announce(
      request("bravo", [], {
        state: "stopped",
        reason: "out of ideas",
        leaseId: bravo.self.lease_id!,
        nowMs: 1_800_000_003_000,
      }),
    );

    const database = new Database(dbPath, { readonly: true });
    const rows = database
      .query("SELECT agent_id, stopped, waiting_on FROM activity_events ORDER BY event_id ASC")
      .all();
    database.close(false);
    expect(rows).toEqual([
      { agent_id: "alpha", stopped: 0, waiting_on: null },
      { agent_id: "alpha", stopped: 1, waiting_on: "external" },
      { agent_id: "bravo", stopped: 0, waiting_on: null },
      { agent_id: "bravo", stopped: 1, waiting_on: null },
    ]);
  });
});

describe("recent peers", () => {
  const T = 1_800_000_000_000;
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  test("a fresh lease hears agents that recently completed", () => {
    const store = createStore();
    const alpha = store.announce(
      request("alpha", ["src/auth"], {
        nowMs: T,
        emoji: "🔧",
      }),
    );
    store.announce(
      request("alpha", [], {
        state: "done",
        leaseId: alpha.self.lease_id ?? undefined,
        summary: "alpha finished auth work",
        nowMs: T + 5 * MINUTE,
      }),
    );

    const observer = store.announce(request("beta", [], { nowMs: T + 10 * MINUTE }));
    expect(observer.peers).toHaveLength(0);
    expect(observer.recent_peers).toHaveLength(1);
    expect(observer.recent_peers[0]).toMatchObject({
      agent_id: "alpha",
      outcome: "completed",
      summary: "alpha finished auth work",
      repo: "example",
      branch: "main",
    });
  });

  test("an agent that stopped unfinished is reported as stopped, with its reason", () => {
    const store = createStore();
    const alpha = store.announce(
      request("alpha", ["src/auth"], { nowMs: T }),
    );
    store.announce(
      request("alpha", [], {
        state: "stopped",
        reason: "typecheck fails in auth, out of ideas",
        waitingOn: "none",
        leaseId: alpha.self.lease_id ?? undefined,
        summary: "alpha paused the auth work",
        nowMs: T + 5 * MINUTE,
      }),
    );

    const observer = store.announce(request("beta", [], { nowMs: T + 10 * MINUTE }));
    expect(observer.recent_peers).toHaveLength(1);
    expect(observer.recent_peers[0]).toMatchObject({
      agent_id: "alpha",
      outcome: "stopped",
      reason: "typecheck fails in auth, out of ideas",
      waiting_on: "none",
      summary: "alpha paused the auth work",
    });
  });

  test("completed and expired entries carry no reason", () => {
    const store = createStore();
    const alpha = store.announce(request("alpha", [], { nowMs: T }));
    store.announce(
      request("alpha", [], {
        state: "done",
        leaseId: alpha.self.lease_id ?? undefined,
        nowMs: T + MINUTE,
      }),
    );

    const observer = store.announce(request("beta", [], { nowMs: T + 2 * MINUTE }));
    expect(observer.recent_peers[0]).toMatchObject({
      outcome: "completed",
      reason: null,
      waiting_on: null,
    });
  });

  test("an agent whose lease lapsed without done is reported as expired", () => {
    const store = createStore();
    store.announce(request("alpha", ["src"], { nowMs: T }));

    // 30m lease: at T+31m the lease is lazily deleted, but the last event on
    // record is still a working announcement.
    const observer = store.announce(request("beta", [], { nowMs: T + 31 * MINUTE }));
    expect(observer.peers).toHaveLength(0);
    expect(observer.recent_peers).toHaveLength(1);
    expect(observer.recent_peers[0]).toMatchObject({
      agent_id: "alpha",
      outcome: "expired",
      summary: "alpha work",
    });
  });

  test("active agents appear as peers, never as recent peers", () => {
    const store = createStore();
    store.announce(request("alpha", ["src"], { nowMs: T }));

    const observer = store.announce(request("beta", [], { nowMs: T + MINUTE }));
    expect(observer.peers.map((peer) => peer.agent_id)).toEqual(["alpha"]);
    expect(observer.recent_peers).toHaveLength(0);
  });

  test("one entry per agent, from its latest event", () => {
    const store = createStore();
    const alpha = store.announce(
      request("alpha", ["src"], { nowMs: T }),
    );
    store.announce(
      request("alpha", ["src"], {
        leaseId: alpha.self.lease_id ?? undefined,
        summary: "alpha renewing",
        nowMs: T + MINUTE,
      }),
    );
    store.announce(
      request("alpha", [], {
        state: "done",
        leaseId: alpha.self.lease_id ?? undefined,
        summary: "alpha done",
        nowMs: T + 2 * MINUTE,
      }),
    );

    const observer = store.announce(request("beta", [], { nowMs: T + 3 * MINUTE }));
    expect(observer.recent_peers).toHaveLength(1);
    expect(observer.recent_peers[0]).toMatchObject({ outcome: "completed", summary: "alpha done" });
  });

  test("renewals and completions hear only what changed since the caller last listened", () => {
    const store = createStore();
    const alpha = store.announce(request("alpha", [], { nowMs: T }));
    store.announce(
      request("alpha", [], {
        state: "done",
        leaseId: alpha.self.lease_id ?? undefined,
        nowMs: T + MINUTE,
      }),
    );

    // Beta's fresh lease hears alpha; its renewal must not repeat it.
    const fresh = store.announce(request("beta", [], { nowMs: T + 2 * MINUTE }));
    expect(fresh.recent_peers.map((peer) => peer.agent_id)).toEqual(["alpha"]);

    const gamma = store.announce(request("gamma", [], { nowMs: T + 3 * MINUTE }));
    store.announce(
      request("gamma", [], {
        state: "done",
        leaseId: gamma.self.lease_id ?? undefined,
        summary: "gamma landed",
        nowMs: T + 4 * MINUTE,
      }),
    );

    const renewal = store.announce(
      request("beta", [], { leaseId: fresh.self.lease_id ?? undefined, nowMs: T + 5 * MINUTE }),
    );
    expect(renewal.recent_peers.map((peer) => peer.summary)).toEqual(["gamma landed"]);

    // Nothing new since the renewal: the next delta is empty, and the
    // completing call itself reports the same quiet frequency.
    const completion = store.announce(
      request("beta", [], {
        state: "done",
        leaseId: fresh.self.lease_id ?? undefined,
        nowMs: T + 6 * MINUTE,
      }),
    );
    expect(completion.recent_peers).toHaveLength(0);
  });

  test("a done call without a live lease gets no orientation dump", () => {
    const store = createStore();
    const alpha = store.announce(request("alpha", [], { nowMs: T }));
    store.announce(
      request("alpha", [], {
        state: "done",
        leaseId: alpha.self.lease_id ?? undefined,
        nowMs: T + MINUTE,
      }),
    );

    const completion = store.announce(
      request("beta", [], { state: "done", nowMs: T + 2 * MINUTE }),
    );
    expect(completion.status).toBe("completed");
    expect(completion.recent_peers).toHaveLength(0);
  });

  test("the orientation window is bounded and the list capped, newest first", () => {
    const store = createStore();
    const stale = store.announce(request("stale", [], { nowMs: T - 25 * HOUR }));
    store.announce(
      request("stale", [], {
        state: "done",
        leaseId: stale.self.lease_id ?? undefined,
        nowMs: T - 25 * HOUR + MINUTE,
      }),
    );

    for (let index = 0; index < 7; index += 1) {
      const lease = store.announce(request(`agent-${index}`, [], { nowMs: T + index * MINUTE }));
      store.announce(
        request(`agent-${index}`, [], {
          state: "done",
          leaseId: lease.self.lease_id ?? undefined,
          nowMs: T + index * MINUTE + 30_000,
        }),
      );
    }

    const observer = store.announce(request("beta", [], { nowMs: T + 10 * MINUTE }));
    expect(observer.recent_peers.map((peer) => peer.agent_id)).toEqual([
      "agent-6",
      "agent-5",
      "agent-4",
      "agent-3",
      "agent-2",
    ]);
  });

  test("traffic_scope widens recent peers from worktree to project to machine", () => {
    const store = createStore();
    const sibling = store.announce(
      request("sibling", [], {
        nowMs: T,
        metadata: metadata({ worktreeId: "worktree-2", worktreeRoot: "/code/example-wt2" }),
      }),
    );
    store.announce(
      request("sibling", [], {
        state: "done",
        leaseId: sibling.self.lease_id ?? undefined,
        nowMs: T + MINUTE,
        metadata: metadata({ worktreeId: "worktree-2", worktreeRoot: "/code/example-wt2" }),
      }),
    );
    const foreign = store.announce(
      request("foreign", [], {
        nowMs: T,
        metadata: metadata({
          projectId: "project-2",
          localRepoId: "clone-2",
          repoName: "other",
          worktreeId: "worktree-3",
          worktreeRoot: "/code/other",
        }),
      }),
    );
    store.announce(
      request("foreign", [], {
        state: "done",
        leaseId: foreign.self.lease_id ?? undefined,
        nowMs: T + MINUTE,
        metadata: metadata({
          projectId: "project-2",
          localRepoId: "clone-2",
          repoName: "other",
          worktreeId: "worktree-3",
          worktreeRoot: "/code/other",
        }),
      }),
    );

    const sameWorktree = store.announce(request("beta", [], { nowMs: T + 2 * MINUTE }));
    expect(sameWorktree.recent_peers).toHaveLength(0);

    const project = store.announce(
      request("beta-project", [], { nowMs: T + 3 * MINUTE, trafficScope: "project" }),
    );
    expect(project.recent_peers.map((peer) => peer.agent_id)).toEqual(["sibling"]);

    const machine = store.announce(
      request("beta-machine", [], { nowMs: T + 4 * MINUTE, trafficScope: "machine" }),
    );
    expect(machine.recent_peers.map((peer) => peer.agent_id).sort()).toEqual([
      "foreign",
      "sibling",
    ]);
  });
});
