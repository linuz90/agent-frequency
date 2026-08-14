export const CLIENT_SURFACES = [
  "t3-code",
  "codex-app",
  "claude-app",
  "cli",
  "unknown",
] as const;

export type ClientSurface = (typeof CLIENT_SURFACES)[number];

interface ClassifyClientSurfaceOptions {
  explicit?: string;
  ancestry?: readonly string[];
  clientName?: string;
}

const MAX_ANCESTORS = 12;

/**
 * Identifies the host that launched the MCP process without retaining raw
 * process metadata. App ancestry wins over the inner Codex/Claude executable:
 * T3 Code and desktop apps commonly launch those same CLI binaries.
 */
export function classifyClientSurface(
  options: ClassifyClientSurfaceOptions = {},
): ClientSurface {
  if (options.explicit !== undefined) {
    return normalizeClientSurface(options.explicit);
  }

  const ancestry = (options.ancestry ?? []).map((entry) => entry.toLowerCase());
  if (ancestry.some((entry) => entry.includes("t3 code") || entry.includes("t3-code"))) {
    return "t3-code";
  }
  if (
    ancestry.some(
      (entry) => entry.includes("/chatgpt.app/") || entry.includes("/codex.app/"),
    )
  ) {
    return "codex-app";
  }
  if (ancestry.some((entry) => entry.includes("/claude.app/"))) {
    return "claude-app";
  }

  const clientName = options.clientName?.toLowerCase() ?? "";
  if (
    ancestry.some((entry) => isAgentExecutable(entry))
    || clientName.includes("codex")
    || clientName.includes("claude")
  ) {
    return "cli";
  }
  return "unknown";
}

export function normalizeClientSurface(value: unknown): ClientSurface {
  if (typeof value !== "string") return "unknown";
  switch (value.trim().toLowerCase().replace(/[\s_]+/gu, "-")) {
    case "t3":
    case "t3-code":
      return "t3-code";
    case "chatgpt":
    case "chatgpt-app":
    case "codex-app":
      return "codex-app";
    case "claude-app":
      return "claude-app";
    case "terminal":
    case "codex-cli":
    case "claude-cli":
    case "cli":
      return "cli";
    default:
      return "unknown";
  }
}

/**
 * Captures executable paths only—never command arguments or environment—to
 * avoid leaking prompts or credentials into presence state.
 */
export function readProcessAncestry(startPid = process.ppid): string[] {
  const ancestry: string[] = [];
  const seen = new Set<number>();
  let pid = startPid;

  for (let depth = 0; depth < MAX_ANCESTORS && pid > 0 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid=", "-o", "comm="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) break;

    const output = new TextDecoder().decode(result.stdout).trim();
    const match = output.match(/^(\d+)\s+(.+)$/su);
    if (!match) break;

    const parentPid = Number(match[1]);
    ancestry.push(match[2]);
    if (!Number.isSafeInteger(parentPid) || parentPid === pid) break;
    pid = parentPid;
  }
  return ancestry;
}

function isAgentExecutable(value: string): boolean {
  const executable = value.split("/").at(-1) ?? value;
  return executable === "codex" || executable === "claude";
}
