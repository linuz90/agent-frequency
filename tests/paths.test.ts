import { describe, expect, test } from "bun:test";

import { normalizePath, normalizePaths, pathsOverlap } from "../src/paths";

describe("normalizePath", () => {
  test("normalizes portable repo-relative paths", () => {
    expect(normalizePath("src//auth/./token.ts")).toBe("src/auth/token.ts");
    expect(normalizePath("src\\auth\\token.ts")).toBe("src/auth/token.ts");
    expect(normalizePath(".")).toBe(".");
  });

  test.each(["", "/tmp/file", "../secret", "src/../secret", "C:\\tmp\\file", "src\nfile", "src/\u202efile"])(
    "rejects an unsafe path: %s",
    (unsafePath) => {
      expect(() => normalizePath(unsafePath)).toThrow();
    },
  );
});

describe("normalizePaths", () => {
  test("deduplicates and sorts normalized paths", () => {
    expect(normalizePaths(["src/b.ts", "src/", "src"])).toEqual(["src", "src/b.ts"]);
  });

  test("caps the number of supplied paths", () => {
    const paths = Array.from({ length: 33 }, (_, index) => `src/${index}.ts`);
    expect(() => normalizePaths(paths)).toThrow("At most 32 paths");
  });
});

describe("pathsOverlap", () => {
  test("matches only full path segments", () => {
    expect(pathsOverlap("src/auth", "src/auth/token.ts")).toBeTrue();
    expect(pathsOverlap("src/auth", "src/authentication.ts")).toBeFalse();
    expect(pathsOverlap(".", "anything/here.ts")).toBeTrue();
  });

  test("can follow a case-insensitive worktree", () => {
    expect(pathsOverlap("src/Auth", "src/auth/token.ts", true)).toBeTrue();
    expect(pathsOverlap("src/Auth", "src/auth/token.ts", false)).toBeFalse();
  });
});
