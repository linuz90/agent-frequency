import { collectGitMetadata } from "./git";
import { AgentFrequencyStore } from "./store";
import type { ClientSurface } from "./client-surface";
import type { AnnounceInput, AnnounceOutput } from "./types";

interface AgentIdentity {
  agentId: string;
  agentLabel: string;
  clientSurface: ClientSurface;
}

interface CoordinateOptions {
  dbPath?: string;
  nowMs?: number;
}

const UNSAFE_FORMATTING = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeSummary(value: string): string {
  const summary = value.replace(UNSAFE_FORMATTING, " ").replace(/\s+/gu, " ").trim();
  if (!summary) {
    throw new Error("summary must contain visible text");
  }
  if (summary.length > 160) {
    throw new Error("summary must be at most 160 characters");
  }
  return summary;
}

export async function coordinateAnnouncement(
  input: AnnounceInput,
  agent: AgentIdentity,
  options: CoordinateOptions = {},
): Promise<AnnounceOutput> {
  const metadata = await collectGitMetadata(input.cwd);
  const store = new AgentFrequencyStore({ dbPath: options.dbPath });

  try {
    return store.announce({
      agentId: agent.agentId,
      agentLabel: agent.agentLabel,
      clientSurface: agent.clientSurface,
      state: input.state ?? "working",
      trafficScope: input.traffic_scope ?? "worktree",
      summary: sanitizeSummary(input.summary),
      metadata,
      scopes: input.scopes ?? [],
      timebox: input.timebox ?? "1h",
      leaseId: input.lease_id,
      nowMs: options.nowMs,
    });
  } finally {
    store.close();
  }
}
