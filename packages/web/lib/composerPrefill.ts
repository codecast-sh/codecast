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

/** Text a link seeds an existing session's composer with. `append` marks text
 *  to continue (`?compose=`, lib/composeLink), which goes after a draft
 *  already there; a quote alone only fills an empty composer. */
export type ComposerSeed = { text: string; append: boolean };

/** The composer's text once a link's seed lands on `current` (what is typed
 *  or kept as the draft), or null to leave the composer alone. A draft or an
 *  attached image outranks a quote, which is dropped; text to continue goes
 *  under the draft after a blank line, and a second click of the same link
 *  adds nothing. */
export function seedComposer(current: string, hasImages: boolean, seed: ComposerSeed): string | null {
  if (!current.trim() && !hasImages) return seed.text;
  if (!seed.append) return null;
  if (!current.trim()) return seed.text;
  const kept = current.trimEnd();
  return kept.endsWith(seed.text.trimEnd()) ? current : `${kept}\n\n${seed.text}`;
}
