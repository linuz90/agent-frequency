import { describe, expect, test } from "bun:test";

import { normalizeScopePath, normalizeScopes, scopePathsOverlap } from "../src/scopes";

describe("normalizeScopePath", () => {
  test("normalizes portable repo-relative paths", () => {
    expect(normalizeScopePath("src//auth/./token.ts")).toBe("src/auth/token.ts");
    expect(normalizeScopePath("src\\auth\\token.ts")).toBe("src/auth/token.ts");
    expect(normalizeScopePath(".")).toBe(".");
  });

  test.each(["", "/tmp/file", "../secret", "src/../secret", "C:\\tmp\\file", "src\nfile", "src/\u202efile"])(
    "rejects an unsafe path: %s",
    (unsafePath) => {
      expect(() => normalizeScopePath(unsafePath)).toThrow();
    },
  );
});

describe("normalizeScopes", () => {
  test("deduplicates paths and keeps the strongest requested access", () => {
    expect(
      normalizeScopes([
        { path: "src/", access: "shared" },
        { path: "src", access: "exclusive" },
      ]),
    ).toEqual([{ path: "src", access: "exclusive" }]);
  });

  test("caps the number of supplied scopes", () => {
    const scopes = Array.from({ length: 33 }, (_, index) => ({
      path: `src/${index}.ts`,
      access: "shared" as const,
    }));
    expect(() => normalizeScopes(scopes)).toThrow("At most 32 scopes");
  });
});

describe("scopePathsOverlap", () => {
  test("matches only full path segments", () => {
    expect(scopePathsOverlap("src/auth", "src/auth/token.ts")).toBeTrue();
    expect(scopePathsOverlap("src/auth", "src/authentication.ts")).toBeFalse();
    expect(scopePathsOverlap(".", "anything/here.ts")).toBeTrue();
  });

  test("can follow a case-insensitive worktree", () => {
    expect(scopePathsOverlap("src/Auth", "src/auth/token.ts", true)).toBeTrue();
    expect(scopePathsOverlap("src/Auth", "src/auth/token.ts", false)).toBeFalse();
  });
});
