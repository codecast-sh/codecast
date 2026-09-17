// Slack writes reactions and inline emoji as :names:. Chat stores unicode
// (chatText.isValidEmoji refuses anything else), so ingest, render and the
// reaction API all share this table. It is the Slack/iamcal shortcode set, not
// a hand-picked subset: an unknown name stays as text inbound and is skipped
// outbound.

import { EMOJI_BY_NAME } from "./emojiData";

const SKIN_TONE_RE = /::skin-tone-[2-6]$/;
const SKIN_TONE_MODIFIER_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const VARIATION_SELECTOR_RE = /️/g;

const NAME_BY_EMOJI: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  // First name wins, so the canonical Slack names (listed first per glyph) are
  // what outbound reactions carry.
  for (const [name, glyph] of Object.entries(EMOJI_BY_NAME)) {
    if (!(glyph in out)) out[glyph] = name;
  }
  // Slack accepts these bare names for the two most common reactions.
  out["👍"] = "+1";
  out["👎"] = "-1";
  return out;
})();

/** A Slack emoji name (with or without colons, with or without a skin tone) to
 *  its unicode glyph, or null when the name is not in the working set. */
export function shortcodeToEmoji(name: string): string | null {
  const bare = name.replace(/^:|:$/g, "").replace(SKIN_TONE_RE, "");
  return EMOJI_BY_NAME[bare] ?? EMOJI_BY_NAME[bare.toLowerCase()] ?? null;
}

/** A unicode emoji to the Slack name its reaction API wants, or null when Slack
 *  has no name we know for it. Skin tones and variation selectors are dropped
 *  first so 👍🏽 reacts as +1. */
export function emojiToShortcode(emoji: string): string | null {
  const direct = NAME_BY_EMOJI[emoji];
  if (direct) return direct;
  const stripped = emoji.replace(SKIN_TONE_MODIFIER_RE, "").replace(VARIATION_SELECTOR_RE, "");
  if (NAME_BY_EMOJI[stripped]) return NAME_BY_EMOJI[stripped];
  for (const [glyph, name] of Object.entries(NAME_BY_EMOJI)) {
    if (glyph.replace(VARIATION_SELECTOR_RE, "") === stripped) return name;
  }
  return null;
}

/** Replace :name: shortcodes in prose with their glyphs. Unknown names stay. */
export function replaceShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+\-']+)(?:::skin-tone-[2-6])?:/gi, (whole, name: string) => {
    const glyph = EMOJI_BY_NAME[name] ?? EMOJI_BY_NAME[name.toLowerCase()];
    return glyph ?? whole;
  });
}
