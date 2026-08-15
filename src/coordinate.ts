import { sanitizeEmoji } from "./emoji";
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

/**
 * The reason is what makes a "stopped" announcement worth having: without one,
 * a stop is indistinguishable from an expiry to everybody reading it later, so
 * the state refuses to land silently. For every other state it is dropped —
 * "done" already means success, and a live state's story is its summary.
 */
export function sanitizeReason(value: string | undefined, state: string): string | null {
  const reason = (value ?? "").replace(UNSAFE_FORMATTING, " ").replace(/\s+/gu, " ").trim();
  if (state !== "stopped") return null;
  if (!reason) {
    throw new Error('state "stopped" requires a reason: say briefly why the run is ending unfinished');
  }
  if (reason.length > 200) {
    throw new Error("reason must be at most 200 characters");
  }
  return reason;
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
      reason: sanitizeReason(input.reason, input.state ?? "working"),
      // An unusable emoji is decoration, not coordination data: drop it and let
      // the announcement through rather than failing a safety-relevant call.
      emoji: sanitizeEmoji(input.emoji),
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
