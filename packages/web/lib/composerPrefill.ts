// A phone notification deep-links back to its session with the draft it is
// asking about (`/conversation/<id>?prefill=<urlencoded text>`), so the reply
// opens with the proposal already quoted and the cursor on the line under it —
// read the notification, type the correction, send. The quote is a real markdown
// blockquote (same shape as the review UI's quote-to-composer), followed by one
// blank line, which is where the correction goes.

import { toBlockquote } from "./quoteFormat";

export const PREFILL_PARAM = "prefill";

// Longer than a notification body ever needs. Past this the link is malformed or
// hostile rather than a draft worth quoting, so the tail is dropped.
export const PREFILL_MAX_LENGTH = 2000;

// The param value is plain text throughout — URLSearchParams has already
// percent-decoded it, and it only ever reaches a textarea's value, so there is
// no markup path to escape.
export function buildPrefillText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const quote = toBlockquote(raw.slice(0, PREFILL_MAX_LENGTH));
  return quote ? `${quote}\n\n` : null;
}

/** Text seeded into an existing session's composer. `fill` (a link's quote, a
 *  cancelled send) only ever fills an empty composer; `add` is text to
 *  continue (`?compose=`, lib/composeLink), typed after `fill`, or under a
 *  draft already there. */
export type ComposerSeed = { fill: string; add: string };

/** The composer's text once a seed lands on `current` (what is typed or kept
 *  as the draft), or null to leave the composer alone. A draft or an attached
 *  image outranks `fill`, which is dropped; `add` goes under the draft after a
 *  blank line, and a second click of the same link adds nothing. */
export function seedComposer(current: string, hasImages: boolean, seed: ComposerSeed): string | null {
  if (!current.trim() && !hasImages) return seed.fill + seed.add || null;
  if (!seed.add) return null;
  if (!current.trim()) return seed.add;
  const kept = current.trimEnd();
  const add = seed.add.trimEnd();
  return kept === add || kept.endsWith(`\n\n${add}`) ? current : `${kept}\n\n${seed.add}`;
}
