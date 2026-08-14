/**
 * A single task emoji rides each announcement so the monitor can show what an
 * agent is doing at a glance. It is peer-authored, untrusted display data:
 * anything that is not exactly one emoji is dropped rather than rejected, so a
 * bad value can never fail an announcement or block coordination.
 */

// Long enough for the widest real grapheme (a four-person ZWJ family with skin
// tones is 19 UTF-16 units, a tag-sequence flag is 14), short enough that a
// hostile value cannot smuggle a banner into the UI.
export const MAX_EMOJI_LENGTH = 32;

// Mirrors the summary defense in coordinate.ts and monitor.ts.
const UNSAFE_FORMATTING = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
);

/**
 * `RGI_Emoji` matches exactly the recommended emoji sequences (ZWJ families,
 * skin-tone modifiers, flags) as whole graphemes, which is the property we
 * actually want. It needs the `v` flag, so fall back to an approximation on
 * engines that lack it rather than throwing at module load.
 */
const EMOJI_PATTERN = buildEmojiPattern();

function buildEmojiPattern(): RegExp {
  try {
    return new RegExp("^\\p{RGI_Emoji}$", "v");
  } catch {
    return new RegExp(
      "^(?:[\\u{1F1E6}-\\u{1F1FF}]{2}"
        + "|\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?"
        + "(?:\\u200D\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?)*)$",
      "u",
    );
  }
}

/**
 * Returns the emoji when `value` is exactly one, else null. Callers treat null
 * as "no emoji announced" and render nothing.
 */
export function sanitizeEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_EMOJI_LENGTH) return null;
  // Control and bidi characters never belong in an emoji; a value carrying one
  // is malformed rather than something to clean up and display.
  if (UNSAFE_FORMATTING.test(candidate)) return null;
  if (EMOJI_PATTERN.test(candidate)) return candidate;
  // Characters with text presentation by default (⚠, ✏) are only RGI once the
  // emoji variation selector is attached, and callers rarely send it. Adopt the
  // emoji form rather than dropping a perfectly good glyph.
  const withPresentation = `${candidate}\uFE0F`;
  return EMOJI_PATTERN.test(withPresentation) ? withPresentation : null;
}
