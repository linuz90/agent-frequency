import { posix as path } from "node:path";

export const MAX_PATHS = 32;

const UNSAFE_FORMATTING = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_FORMATTING_ALL = new RegExp(UNSAFE_FORMATTING.source, "gu");
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

/**
 * For peer-visible text that cannot simply be rejected (e.g. filenames Git
 * reports). Control and directional-formatting characters would otherwise
 * reach other agents' transcripts raw, where an RLO override can visually
 * reorder surrounding text.
 */
export function stripUnsafeFormatting(value: string): string {
  return value.replace(UNSAFE_FORMATTING_ALL, " ").replace(/\s+/g, " ").trim();
}

export function normalizePath(value: string): string {
  if (value.length === 0) {
    throw new Error("Paths cannot be empty");
  }
  if (UNSAFE_FORMATTING.test(value)) {
    throw new Error("Paths cannot contain control or directional formatting characters");
  }

  // MCP clients may run on another platform, so treat both slash styles as
  // separators before applying the same repo-relative rules everywhere.
  const portablePath = value.replaceAll("\\", "/");
  if (
    path.isAbsolute(portablePath) ||
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    portablePath.split("/").includes("..")
  ) {
    throw new Error(`Path must stay inside the repository: ${value}`);
  }

  const normalizedPath = path.normalize(portablePath);
  const normalized = normalizedPath === "." ? normalizedPath : normalizedPath.replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path must stay inside the repository: ${value}`);
  }

  return normalized;
}

export function normalizePaths(paths: string[]): string[] {
  if (paths.length > MAX_PATHS) {
    throw new Error(`At most ${MAX_PATHS} paths can be announced at once`);
  }
  return [...new Set(paths.map(normalizePath))].sort((a, b) => a.localeCompare(b));
}

export function pathsOverlap(left: string, right: string, ignoreCase = false): boolean {
  const normalizedLeft = ignoreCase ? left.toLocaleLowerCase("en-US") : left;
  const normalizedRight = ignoreCase ? right.toLocaleLowerCase("en-US") : right;

  return (
    normalizedLeft === "." ||
    normalizedRight === "." ||
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}
