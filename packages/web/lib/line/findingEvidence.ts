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
const STUB = /^(?:placeholder(?: (?:removed|text|body))?\.?|todo|tbd|tba|n\/?a|none|null|undefined|empty|lorem ipsum\b.*|[.…\-–—?]+)$/i;

/** The lines a problem's description wraps its opening finding in (convex signals.ts causeDescription). */
const WRAPPER = [/^opened by\b/i, /^about:/i, /^where it was seen:/i];

/** A finding says nothing: every paragraph it has (its expectation line, quote and bookkeeping aside) is a stub, or it
 *  has none. A quote alone is evidence: it is the words the finder judged. */
export function isEmptyFinding(s: Pick<FindingLike, "title" | "detail_md" | "source" | "subject"> & { moment?: string | null }): boolean {
  // A judge's finding on a moment is that moment: the conversation it frames is the evidence, words or none.
  if (s.moment) return false;
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

/** Words a rule shares with any sentence: they name no subject, so sharing one says nothing about being on topic. */
const COMMON = new Set("that this with from what when where which while only after before ship show work well than then them they their there these those into onto over under about also just like make made change replace does done have been being were will would should could must each every some more most less least same other another first last never always nothing something someone anyone every still back down your ours they them because should".split(" "));
/** A text's subject words: four letters or more, the common ones out, a plural or tense ending cut. */
export const subjectWords = (text: string) => new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4).map((w) => w.replace(/(?:ing|ed|(?<!s)s)$/, "")).filter((w) => w.length >= 4 && !COMMON.has(w)));

/** The findings with words, on a problem that rests on nothing (findingSupport), that share no subject word with its
 *  title: its title is the expectation an empty finding named, so nothing ties them to it, and their own words are
 *  about something else (ct-57470: an A/B rule for cold email, its one worded finding a match pitched to the wrong
 *  person). Empty for a supported problem, or a title too short to judge. */
export function offTopicFindings<T extends Pick<FindingLike, "title" | "detail_md" | "source" | "subject"> & { attach?: string | null; created_at?: number }>(title: string, rows: ReadonlyArray<T>): Set<T> {
  const { empty, unsupported } = findingSupport(rows);
  const rule = subjectWords(title.replace(/^not met:\s*/i, ""));
  if (!unsupported || rule.size < 2) return new Set();
  return new Set(rows.filter((r) => {
    if (empty.has(r)) return false;
    const said = subjectWords(findingBlocks({ ...r, evidence_url: null }).map((b) => b.text).join("\n"));
    return ![...rule].some((w) => said.has(w));
  }));
}

const sameWords = (s: Pick<FindingLike, "title" | "detail_md">) => `${s.title}\n${s.detail_md ?? ""}`.toLowerCase().replace(/[\s.…,;:!?"'()\-–—]+/g, " ").trim();

/** The findings that repeat an earlier one word for word under the same source key (a finder that filed one moment
 *  twice, ct-57368 Oct 8 12:02 and 12:03): one occurrence, so they are never counted or drawn apart. The feeds carry
 *  each detail's first 1200 characters, enough to tell two moments apart. Returns the repeats, oldest kept. */
export function repeatedFindings<T extends Pick<FindingLike, "title" | "detail_md" | "source" | "subject"> & { fingerprint?: string | null; observed_at?: number; created_at: number }>(rows: ReadonlyArray<T>): Set<T> {
  const seen = new Set<string>();
  const out = new Set<T>();
  for (const s of [...rows].sort((a, b) => (a.observed_at || a.created_at) - (b.observed_at || b.created_at))) {
    if (isEmptyFinding(s)) continue;
    const k = repeatKey(s);
    if (seen.has(k)) out.add(s); else seen.add(k);
  }
  return out;
}

/** What makes two findings one moment: the same source key and the same words, past the finder's own bookkeeping
 *  (AgentWatch ends each with "3 findings in this AgentWatch cluster", which counts up between two filings of one moment). */
export const repeatKey = (s: Pick<FindingLike, "title" | "detail_md"> & { fingerprint?: string | null }): string =>
  `${s.fingerprint ?? ""}\n${sameWords({ ...s, detail_md: s.detail_md?.replace(/^\s*\d+ findings? in this [^\n]*cluster[^\n]*$/gim, "") })}`;

/** The findings a reader lists, in the order given: a finding that says nothing is left out (and out of the count),
 *  and one that says word for word what an earlier one says folds into it as a repeat. `empty` is how many were left
 *  out; a row's `repeats` is the findings it stands for besides itself. */
export function listedFindings<T extends Pick<FindingLike, "title" | "detail_md" | "source" | "subject">>(rows: ReadonlyArray<T>): { rows: Array<{ signal: T; repeats: T[] }>; empty: number } {
  const out: Array<{ signal: T; repeats: T[] }> = [];
  const by = new Map<string, { signal: T; repeats: T[] }>();
  let empty = 0;
  for (const s of rows) {
    if (isEmptyFinding(s)) { empty++; continue; }
    const k = sameWords(s);
    const had = by.get(k);
    if (had) { had.repeats.push(s); continue; }
    const row = { signal: s, repeats: [] as T[] };
    by.set(k, row);
    out.push(row);
  }
  return { rows: out, empty };
}
