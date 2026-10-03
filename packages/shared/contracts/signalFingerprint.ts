// The fingerprints finders compute for `signals.ingest` (docs/architecture/
// the-line-end-to-end.md LE3). A fingerprint is the dedupe key: the same
// observation seen again must hash to the same string, so a cause collects it
// instead of a second cause opening. Each finder's shape lives here once, so
// the CLI, the evals package and convex never spell one differently.
import { fnv1a32 } from "./inboxProjection";

/** What a signal can say it saw (LE3). The door, the CLI and a repo's line profile share this list. */
export const SIGNAL_KINDS = ["bug", "regression", "prompt_miss", "ux", "cohesion", "request"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** An eval finding: a surface and the check (a gate, a verdict) or freeze id it concerns. */
export function evalsSignalFingerprint(surface: string, ref: string): string {
  return `evals:${surface.trim()}:${ref.trim()}`;
}

/**
 * A blocker a session insight recorded. The text is a model's sentence, so it
 * is folded before hashing (case, whitespace, punctuation at the ends): the
 * same blocker restated with a trailing period is one fingerprint.
 */
export function insightSignalFingerprint(conversationShortId: string, blocker: string): string {
  const folded = blocker.toLowerCase().replace(/\s+/g, " ").trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return `insight:${conversationShortId.trim()}:${fnv1a32(folded).toString(16).padStart(8, "0")}`;
}
