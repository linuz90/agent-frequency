import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { clearDemoTraffic, demoRoot, readDemoCounts, seedDemoTraffic } from "../src/demo";
import { AgentFrequencyStore } from "../src/store";
import type { StoreAnnounceRequest } from "../src/types";

const stores: AgentFrequencyStore[] = [];
const temporaryDirectories: string[] = [];

const HOME = "/demo-home";
const NOW_MS = 1_800_000_000_000;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { store: AgentFrequencyStore; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-frequency-demo-test-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "state.sqlite3");
  const store = new AgentFrequencyStore({ dbPath });
  stores.push(store);
  return { store, dbPath };
}

function realRequest(overrides: Partial<StoreAnnounceRequest> = {}): StoreAnnounceRequest {
  return {
    agentId: "Claude REAL0001",
    agentLabel: "Claude",
    clientSurface: "cli",
    state: "working",
    trafficScope: "worktree",
    summary: "Real work",
    metadata: {
      projectId: "project-1",
      localRepoId: "clone-1",
      repoName: "acme-web",
      worktreeId: "worktree-1",
      worktreeRoot: "/code/acme-web",
      gitDir: "/code/acme-web/.git",
      gitCommonDir: "/code/acme-web/.git",
      branch: "main",
      headOid: "abc123",
      ignoreCase: false,
      origin: null,
      dirty: false,
      dirtyCount: 0,
      dirtyPaths: [],
      metadataComplete: true,
    },
    scopes: [{ path: "src/billing", access: "exclusive" }],
    timebox: "1h",
    nowMs: NOW_MS,
    ...overrides,
  };
}

function readLeases(dbPath: string): Array<Record<string, unknown>> {
  const database = new Database(dbPath, { readonly: true });
  try {
    return database.query("SELECT * FROM leases").all() as Array<Record<string, unknown>>;
  } finally {
    database.close(false);
  }
}

describe("demo traffic", () => {
  test("seeds live leases and activity across several fake projects and surfaces", () => {
    const { store, dbPath } = createStore();
    const result = seedDemoTraffic(store, { nowMs: NOW_MS, home: HOME });

    expect(result.announcements).toBeGreaterThan(10);
    expect(result.agents).toBeGreaterThanOrEqual(8);
    expect(result.liveLeases).toBeGreaterThan(0);

    const leases = readLeases(dbPath);
    expect(leases.length).toBe(result.liveLeases);
    expect(new Set(leases.map((lease) => lease.repo_name)).size).toBeGreaterThan(2);
    expect(new Set(leases.map((lease) => lease.client_surface)).size).toBeGreaterThan(2);
    expect(new Set(leases.map((lease) => lease.agent_label)).size).toBeGreaterThan(2);

    const counts = readDemoCounts(dbPath, HOME);
    expect(counts.leases).toBe(leases.length);
    expect(counts.events).toBe(result.announcements);
  });

  test("marks every seeded row so it stays identifiable", () => {
    const { store, dbPath } = createStore();
    seedDemoTraffic(store, { nowMs: NOW_MS, home: HOME });

    for (const lease of readLeases(dbPath)) {
      expect(lease.agent_id).toContain(" DEMO");
      expect(String(lease.worktree_root).startsWith(`${demoRoot(HOME)}/`)).toBe(true);
    }
  });

  test("never blocks or warns a real agent, because demo projects are unrelated", () => {
    const { store } = createStore();
    seedDemoTraffic(store, { nowMs: NOW_MS, home: HOME });

    const result = store.announce(realRequest({ trafficScope: "machine" }));

    expect(result.status).toBe("granted");
    expect(result.self.blocked_scopes).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain("SAME_BRANCH");
    expect(result.peers.length).toBeGreaterThan(0);
    expect(result.peers.every((peer) => peer.relation === "other_project")).toBe(true);
  });

  test("clears demo rows without touching real ones", () => {
    const { store, dbPath } = createStore();
    store.announce(realRequest());
    seedDemoTraffic(store, { nowMs: NOW_MS, home: HOME });

    const cleared = clearDemoTraffic(dbPath, HOME);

    expect(cleared.leases).toBeGreaterThan(0);
    expect(cleared.events).toBeGreaterThan(0);
    expect(readDemoCounts(dbPath, HOME)).toEqual({ leases: 0, events: 0 });

    const remaining = readLeases(dbPath);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.agent_id).toBe("Claude REAL0001");

    const database = new Database(dbPath, { readonly: true });
    try {
      const claims = database.query("SELECT lease_id FROM claims").all() as Array<{ lease_id: string }>;
      expect(claims.every((claim) => claim.lease_id === remaining[0]?.lease_id)).toBe(true);
      const events = database.query("SELECT agent_id FROM activity_events").all() as Array<{
        agent_id: string;
      }>;
      expect(events).toEqual([{ agent_id: "Claude REAL0001" }]);
    } finally {
      database.close(false);
    }
  });

  test("reseeding after a clear leaves no duplicates", () => {
    const { store, dbPath } = createStore();
    const first = seedDemoTraffic(store, { nowMs: NOW_MS, home: HOME });
    clearDemoTraffic(dbPath, HOME);
    seedDemoTraffic(store, { nowMs: NOW_MS, home: HOME });

    expect(readDemoCounts(dbPath, HOME)).toEqual({
      leases: first.liveLeases,
      events: first.announcements,
    });
  });

  test("counting and clearing tolerate a database that does not exist yet", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-frequency-demo-test-"));
    temporaryDirectories.push(directory);
    const missing = join(directory, "missing.sqlite3");

    expect(readDemoCounts(missing, HOME)).toEqual({ leases: 0, events: 0 });
    expect(clearDemoTraffic(missing, HOME)).toEqual({ leases: 0, events: 0 });
  });
});
