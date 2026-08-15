// The scraped-prose twin, and why a transcript shows the same paragraphs twice.
//
// While an AskUserQuestion is pending, Claude Code buffers the whole turn out
// of the JSONL — including the prose that motivates the question. So the
// daemon scrapes that prose off the tmux pane and emits it as its own message,
// `<promptUuid>-prose`, purely so the web has something to show while the
// question is open. The daemon's own comment says that copy is "best-effort
// while pending, replaced byte-exact when the turn flushes".
//
// It is not replaced. When the turn finally flushes, the real assistant
// message arrives alongside the scrape and both persist, so the reader sees
// the identical paragraphs twice (reported 2026-08-15).
//
// Matching on CONTENT rather than timing is deliberate: it also cleans
// transcripts that were already written this way, so no backfill is needed.

type ProseCandidate = {
  role?: string;
  content?: string | null;
  message_uuid?: string | null;
};

const SCRAPED_PREFIX = "interactive-prompt-";
const PROSE_SUFFIX = "-prose";

export function isScrapedProseTwin(uuid: string | null | undefined): boolean {
  return !!uuid && uuid.startsWith(SCRAPED_PREFIX) && uuid.endsWith(PROSE_SUFFIX);
}

/**
 * Drop each `-prose` scrape whose text a real assistant message already
 * carries. A scrape with no real counterpart is KEPT — while the question is
 * still pending it is the only copy of the reasoning, which is the whole
 * reason the daemon emits it.
 */
export function dropScrapedProseTwins<T extends ProseCandidate>(messages: T[]): T[] {
  let anyTwin = false;
  const realProse = new Set<string>();
  for (const m of messages) {
    if (isScrapedProseTwin(m.message_uuid)) { anyTwin = true; continue; }
    if (m.role !== "assistant") continue;
    const text = (m.content ?? "").trim();
    if (text.length > 0) realProse.add(text);
  }
  // Keep the array identity stable in the common case (no twins at all) so the
  // memo above this doesn't hand the message list a new ref every render.
  if (!anyTwin || realProse.size === 0) return messages;
  return messages.filter(
    (m) => !(isScrapedProseTwin(m.message_uuid) && realProse.has((m.content ?? "").trim()))
  );
}
