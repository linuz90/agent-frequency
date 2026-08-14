import { describe, expect, test } from "bun:test";

import { MAX_EMOJI_LENGTH, sanitizeEmoji } from "../src/emoji";

describe("sanitizeEmoji", () => {
  test("keeps a single emoji, including multi-codepoint sequences", () => {
    expect(sanitizeEmoji("🐛")).toBe("🐛");
    expect(sanitizeEmoji("👍🏽")).toBe("👍🏽");
    expect(sanitizeEmoji("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(sanitizeEmoji("🇮🇹")).toBe("🇮🇹");
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizeEmoji("  🚀 ")).toBe("🚀");
  });

  test("adopts the emoji presentation of text-default glyphs", () => {
    expect(sanitizeEmoji("⚠")).toBe("⚠️");
    expect(sanitizeEmoji("⚠️")).toBe("⚠️");
  });

  test("drops anything that is not exactly one emoji", () => {
    expect(sanitizeEmoji("")).toBeNull();
    expect(sanitizeEmoji("   ")).toBeNull();
    expect(sanitizeEmoji("hi")).toBeNull();
    expect(sanitizeEmoji("🐛🐛")).toBeNull();
    expect(sanitizeEmoji("🐛 fixing the parser")).toBeNull();
    expect(sanitizeEmoji("a")).toBeNull();
  });

  test("drops values carrying control or directional formatting", () => {
    expect(sanitizeEmoji("\u{1F41B}\u202E")).toBeNull();
    expect(sanitizeEmoji("\u{1F41B}\u0007")).toBeNull();
    expect(sanitizeEmoji("\u{1F41B}\u2066")).toBeNull();
  });

  test("drops non-strings and oversized values", () => {
    expect(sanitizeEmoji(undefined)).toBeNull();
    expect(sanitizeEmoji(null)).toBeNull();
    expect(sanitizeEmoji(42)).toBeNull();
    expect(sanitizeEmoji({ emoji: "🐛" })).toBeNull();
    expect(sanitizeEmoji("🐛".repeat(MAX_EMOJI_LENGTH))).toBeNull();
  });
});
