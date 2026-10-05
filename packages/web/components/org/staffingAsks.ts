// A proposal as a few asks (docs/architecture/org-staffing.md S19): the view
// model the right column renders. The partition itself is the shared
// contract's (`resolveOrgAsks`, the same function the server runs); this file
// joins each ask to its change rows and says, in words, where each ask and
// the whole proposal stand. Pure; the cards render what it returns.
import { resolveOrgAsks, type OrgAskNames, isOrgQuietChange } from "@codecast/shared/contracts/orgProposal";
import type { OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";
import { isDecidable, isSyncChange, orderChanges, recordsInLine, splitAsk } from "./staffingModel";
import { refMatches, refResolves } from "./orgLayout";

/** Where one ask stands. `open` = something in it still waits on the person
 *  (a failed row does, the server takes it again); the other two are decided. */
export type AskState = "open" | "accepted" | "skipped";

export type AskView = {
  /** The index `orgProposals.decideAsk` and `say` take. */
  index: number;
  title: string;
  why: string;
  effect: string;
  /** The ask's change rows, in the order accepting applies them. */
  changes: OrgProposalChange[];
  /** Rows still waiting on a verdict, failed ones included. */
  remaining: number;
  failed: number;
  skipped: number;
  state: AskState;
  /** What the fold says it holds: "105 records", "3 changes". */
  foldLabel: string;
  /** The line a touched ask carries under its title, null while untouched:
   *  "Approved", "Approved, 1 rejected", "12 of 105 changes answered" (the
   *  header counts asks, so the card names its unit), "2 changes failed". */
  verdictLine: string | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A row a ref can name: a project, a plan, a goal. */
type NamedRow = { id: string; title: string; short_id?: string };

/** The chart's names for a derived ask's words (S19): an agent by handle, a
 *  project or plan by the id, short id or title a change carries. `extra` is
 *  what a card has in hand beyond the tree: the workspace's projects, plans
 *  and goals (a project in no role's area, a goal by its `in-N` or title),
 *  roles the proposal itself creates, and a session's title by its short id. */
export function askNames(tree: OrgTree | null | undefined, extra?: { projects?: readonly NamedRow[]; plans?: readonly NamedRow[]; goals?: readonly NamedRow[]; roles?: readonly { handle: string; name: string }[]; sessions?: (ref: string) => string | undefined }): OrgAskNames | undefined {
  if (!tree && !extra) return undefined;
  const roles = new Map([...(extra?.roles ?? []), ...(tree?.roles ?? [])].map((r) => [r.handle.replace(/^@/, "").toLowerCase(), r.name]));
  const projects = new Map<string, string>(), plans = new Map<string, string>();
  for (const r of tree?.roles ?? []) {
    for (const x of r.scope_names.projects) for (const k of [x.id, x.short_id, x.title]) if (k) projects.set(k, x.title);
    for (const x of r.scope_names.plans) for (const k of [x.id, x.short_id, x.title]) if (k) plans.set(k, x.title);
  }
  // A project resolves the way the server reads one (refResolves); a plan and a goal by id, short id or title.
  const named = (rows: readonly NamedRow[] | undefined, ref: string) => rows?.find((row) => refMatches(ref, row))?.title;
  return {
    role: (h) => roles.get(h),
    project: (ref) => (extra?.projects && refResolves(ref, extra.projects)?.title) || projects.get(ref),
    plan: (ref) => named(extra?.plans, ref) ?? plans.get(ref),
    ...(extra?.goals ? { initiative: (ref: string) => named(extra.goals, ref) } : {}),
    ...(extra?.sessions ? { session: extra.sessions } : {}),
  };
}

/** The asks of a proposal joined to its rows. A proposal whose change rows
 *  have not landed yet has no asks to show (the header says it is loading). */
export function proposalAsks(p: Pick<OrgProposalRow, "asks" | "changes">, names?: OrgAskNames): AskView[] {
  const bySeq = new Map(p.changes.map((c) => [c.seq, c]));
  return resolveOrgAsks(p.asks, p.changes, names).map((a, index) => {
    const changes = orderChanges(a.seqs.map((q) => bySeq.get(q)).filter((c): c is OrgProposalChange => !!c));
    const remaining = changes.filter((c) => isDecidable(c.status)).length;
    const failed = changes.filter((c) => c.status === "failed").length;
    const skipped = changes.filter((c) => c.status === "skipped").length;
    const decided = changes.length - remaining;
    const state: AskState = remaining > 0 ? "open" : skipped === changes.length ? "skipped" : "accepted";
    const verdictLine =
      state === "skipped" ? "Rejected"
      : state === "accepted" ? (skipped > 0 ? `Approved, ${skipped} rejected` : "Approved")
      : failed > 0 ? `${plural(failed, "change", "changes")} failed. Approve tries ${failed === 1 ? "it" : "them"} again`
      : decided > 0 ? `${decided} of ${changes.length} changes answered`
      : null;
    const records = changes.every((c) => isSyncChange(c.change));
    // A quiet kind (a limit, S23.2) is not a row in the fold; an ask of quiet
    // changes alone reads as sentences, one per change, so it counts them all.
    const drawn = changes.filter((c) => !isOrgQuietChange(c.change)).length;
    const foldLabel = records ? plural(recordsInLine(changes), "record", "records") : plural(drawn || changes.length, "change", "changes");
    return { index, title: a.title, why: a.why, effect: a.effect, changes, remaining, failed, skipped, state, foldLabel, verdictLine };
  });
}

/**
 * The phone's bar at the foot of the conversation (S19), in two parts: the
 * count a person reads, and the verb that says the bar opens the asks (a
 * count alone read as a status line: "nothing tells me so", org eval round
 * 3). The verb goes on a chip drawn as a control.
 */
export function asksBarWords(toDecide: number, total: number): { count: string; action: string } {
  return toDecide === 0
    ? { count: `All ${total} answered`, action: "See them" }
    : { count: `${toDecide} to decide`, action: "Open them" };
}

/** The header's count: an ask is answered once nothing in it waits (a note
 *  alone leaves it open). */
export function asksProgress(asks: AskView[]): { decided: number; total: number; remaining: number } {
  const decided = asks.filter((a) => a.state !== "open").length;
  return { decided, total: asks.length, remaining: asks.length - decided };
}

/** The ask a change belongs to: a row focused from the chart opens its card. */
export function askOfChange(asks: AskView[], changeId: string | null | undefined): AskView | null {
  if (!changeId) return null;
  return asks.find((a) => a.changes.some((c) => c._id === changeId)) ?? null;
}

// ---------------------------------------------------------------- the cost line



// ---------------------------------------------------------------- the letter

/** A letter this long or shorter is the author's first bubble whole. */
export const LETTER_LEAD_CHARS = 900;

/**
 * The letter as the author's first bubble (S19). A letter written for this
 * page is an opening and one short paragraph per ask: it shows whole. An
 * older one runs to a page: its opening paragraphs show, up to the limit, and
 * the rest is one tap away inside the same bubble. The evidence line leaves
 * the prose and becomes a link at the bubble's foot (staffingModel.splitAsk).
 */
/** A paragraph that opens an ask: "First, ...", "One: ...", "1. ...". */
const opensAnAsk = (p: string): boolean => /^(\*\*)?(first|one|1)\b[,.:)]?/i.test(p);

/** The letter opens by introducing its author ("I am the reviewer..."), so
 *  the page's own line of introduction would say it twice. */
export const introducesItself = (lead: string): boolean => /^\s*(\*\*)?I(?:'m| am)\b/.test(lead);

export function letterParts(summaryMd: string | null | undefined): { lead: string; rest: string; evidenceHref: string | null } {
  const { ask, tail, evidenceHref } = splitAsk(summaryMd);
  const paragraphs = [ask, ...tail.split(/\n[ \t]*\n+/)].map((p) => p.trim()).filter(Boolean);
  // A first paragraph that alone runs past the limit (an analyzer's single
  // block of prose) is cut at the last sentence end under it; the rest of the
  // paragraph folds with the paragraphs after it.
  if (paragraphs.length && paragraphs[0].length > LETTER_LEAD_CHARS) {
    const head = paragraphs[0].slice(0, LETTER_LEAD_CHARS + 1);
    const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
    if (cut >= LETTER_LEAD_CHARS / 4) paragraphs.splice(0, 1, paragraphs[0].slice(0, cut + 1), paragraphs[0].slice(cut + 1).trim());
  }
  // A letter written for this page says so by its shape: nothing follows the
  // ask paragraphs until a bold heading opens the rest (cli ORG_LETTER_RULE).
  // The heading is then the cut, so the last ask never folds for being the
  // paragraph that crossed the limit. A letter that runs long before its first
  // heading, or has none, is an older one and keeps the limit.
  const headingAt = paragraphs.findIndex((p) => /^\*\*[^*\n]+\*\*\s*$/.test(p.split("\n")[0]));
  const shaped = headingAt > 0 && paragraphs.slice(0, headingAt).reduce((n, p) => n + p.length, 0) <= 2 * LETTER_LEAD_CHARS;
  let taken = shaped ? headingAt : 0, size = 0;
  if (!shaped) {
    for (const p of paragraphs) {
      if (taken > 0 && size + p.length > LETTER_LEAD_CHARS) break;
      taken += 1; size += p.length;
    }
    // The limit never cuts before the first ask: a lead that is only the
    // author's introduction shows a reader nothing to decide. When the cut
    // fell before the first paragraph that opens an ask, the lead runs
    // through that paragraph, whatever its length.
    const firstAsk = paragraphs.findIndex(opensAnAsk);
    if (firstAsk >= taken) taken = firstAsk + 1;
  }
  return { lead: paragraphs.slice(0, taken).join("\n\n"), rest: paragraphs.slice(taken).join("\n\n"), evidenceHref };
}

/** The line of introduction the author's first bubble opens with, for a
 *  person who has never accepted a change (S19). One line: who is speaking,
 *  what it does, and that the person decides. */
export function letterIntro(authorName: string, named: boolean): string {
  const who = named ? `I am your ${authorName}. I look at how the work here is organized and suggest changes.` : "I looked at how the work here is organized, and these are the changes I suggest.";
  return `${who} You decide each one, and nothing changes until you approve it.`;
}


// ---------------------------------------------------------------- proposal (S19)

/**
 * The asks column: one line of header, one card per ask, one line of cost.
 * Who wrote the proposal, when, and why is the letter in the conversation
 * beside it; the 157 rows are inside the cards' folds. Nothing else is here
 * on purpose: every line added to this column is a line a person reads
 * before they find what to press.
 */
/** "2 of 3 answered", or "loading" while the changes are still on their way. */
export function asksProgressLine(progress: { decided: number; total: number }, loading: boolean): string {
  return loading ? "loading" : `${progress.decided} of ${progress.total} answered`;
}

/** The changes are still on their way: the counts say there are some and none has arrived. */
export function asksLoading(proposal: Pick<OrgProposalRow, "changes" | "counts">): boolean {
  return proposal.changes.length === 0 && (proposal.counts?.total ?? 0) > 0;
}
