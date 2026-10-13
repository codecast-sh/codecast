// Whether a problem's findings are evidence (line-journeys.md LJ6.2, LJ8.3).
// A finder can file a finding with nothing in it: Union's match judge sent
// "placeholder" as the body of whole AgentWatch clusters (ct-57470). Such a
// finding names an expectation and says nothing about what happened, so it is
// no evidence, and a problem opened by one rests on nothing: its title is the
// expectation's words, and grounding's question about it ("open the linked
// cluster and name the violating change") cannot be answered from anything on
// the page. The For you reader and the problem's ask both read this one rule:
// such a problem asks nobody a question; it reads "No supporting finding" and
// offers Close first. Pure.
import { findingBlocks, type FindingLike } from "./problemPage";

/** A body a finder writes when it has nothing to say: a stub, not a description. */
const STUB = /^(?:placeholder|todo|tbd|tba|n\/?a|none|null|undefined|empty|lorem ipsum\b.*|[.…\-–—?]+)$/i;

/** The lines a problem's description wraps its opening finding in (convex signals.ts causeDescription). */
const WRAPPER = [/^opened by\b/i, /^about:/i, /^where it was seen:/i];

/** A finding says nothing: every paragraph it has (its expectation line, quote and bookkeeping aside) is a stub, or it
 *  has none. A quote alone is evidence: it is the words the finder judged. */
export function isEmptyFinding(s: Pick<FindingLike, "title" | "detail_md" | "source" | "subject">): boolean {
  const blocks = findingBlocks({ ...s, evidence_url: null }).filter((b) => !(b.kind === "text" && WRAPPER.some((re) => re.test(b.text))));
  return blocks.every((b) => b.kind === "text" && b.text.split("\n").every((l) => !l.trim() || STUB.test(l.trim())));
}

/** A problem the door opened on a finding that says nothing: its description carries that finding's body (the door
 *  writes it there), so this reads at list level, before the problem's own findings are fed. A problem filed by hand,
 *  or with no description, is not judged here. */
export function restsOnNothing(task: { source?: string | null; title: string; description?: string | null } | null | undefined): boolean {
  if (!task || task.source !== "signal" || !task.description?.trim()) return false;
  return isEmptyFinding({ title: task.title, detail_md: task.description, source: "signal", subject: null });
}

/** How a problem's findings stand as evidence: `empty` say nothing, `opener` is whether the one that opened it is
 *  among them. Unsupported when none says anything, or the opener says nothing (its title rests on nothing; the rest
 *  were attached to that title). */
export function findingSupport<T extends Pick<FindingLike, "title" | "detail_md" | "source" | "subject"> & { attach?: string | null; created_at?: number }>(
  rows: ReadonlyArray<T>,
): { empty: Set<T>; unsupported: boolean } {
  const empty = new Set(rows.filter(isEmptyFinding));
  const opener = rows.find((r) => r.attach === "new") ?? [...rows].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))[0];
  return { empty, unsupported: rows.length > 0 && (empty.size === rows.length || (!!opener && empty.has(opener))) };
}
