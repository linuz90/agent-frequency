import { posix as path } from "node:path";

import type { Scope } from "./types";

export const MAX_SCOPES = 32;

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

export function normalizeScopePath(value: string): string {
  if (value.length === 0) {
    throw new Error("Scope paths cannot be empty");
  }
  if (UNSAFE_FORMATTING.test(value)) {
    throw new Error("Scope paths cannot contain control or directional formatting characters");
  }

  // MCP clients may run on another platform, so treat both slash styles as
  // separators before applying the same repo-relative rules everywhere.
  const portablePath = value.replaceAll("\\", "/");
  if (
    path.isAbsolute(portablePath) ||
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    portablePath.split("/").includes("..")
  ) {
    throw new Error(`Scope path must stay inside the repository: ${value}`);
  }

  const normalizedPath = path.normalize(portablePath);
  const normalized = normalizedPath === "." ? normalizedPath : normalizedPath.replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Scope path must stay inside the repository: ${value}`);
  }

  return normalized;
}

export function normalizeScopes(scopes: Scope[]): Scope[] {
  if (scopes.length > MAX_SCOPES) {
    throw new Error(`At most ${MAX_SCOPES} scopes can be announced at once`);
  }

  const normalized = new Map<string, Scope["access"]>();
  for (const scope of scopes) {
    const scopePath = normalizeScopePath(scope.path);
    const existingAccess = normalized.get(scopePath);
    // Duplicate claims add no information. Preserve the stronger access mode
    // so callers cannot accidentally weaken a claim through ordering.
    normalized.set(
      scopePath,
      existingAccess === "exclusive" || scope.access === "exclusive" ? "exclusive" : "shared",
    );
  }

  return [...normalized.entries()]
    .map(([scopePath, access]) => ({ path: scopePath, access }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.access.localeCompare(b.access));
}

export function scopePathsOverlap(left: string, right: string, ignoreCase = false): boolean {
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

export function scopesOverlap(left: Scope, right: Scope, ignoreCase = false): boolean {
  return scopePathsOverlap(left.path, right.path, ignoreCase);
}
