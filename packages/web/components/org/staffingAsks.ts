// A proposal as a few asks (docs/architecture/org-staffing.md S19): the view
// model the right column renders. The partition itself is the shared
// contract's (`resolveOrgAsks`, the same function the server runs); this file
// joins each ask to its change rows and says, in words, where each ask and
// the whole proposal stand. Pure; the cards render what it returns.
import { resolveOrgAsks, type OrgAskNames } from "@codecast/shared/contracts/orgProposal";
import type { OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";
import { isDecidable, isSyncChange, orderChanges, recordsInLine, splitAsk, type BudgetArithmetic, type BudgetCaps } from "./staffingModel";

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
   *  "Accepted", "Accepted, 1 skipped", "12 of 105 changes decided" (the
 *  header counts asks, so the card names its unit), "2 changes failed". */
  verdictLine: string | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The chart's names for a derived ask's words (S19): an agent by handle, a
 *  project or plan by the id, short id or title a change carries. */
export function askNames(tree: OrgTree | null | undefined): OrgAskNames | undefined {
  if (!tree) return undefined;
  const roles = new Map(tree.roles.map((r) => [r.handle.toLowerCase(), r.name]));
  const projects = new Map<string, string>(), plans = new Map<string, string>();
  for (const r of tree.roles) {
    for (const x of r.scope_names.projects) for (const k of [x.id, x.short_id, x.title]) if (k) projects.set(k, x.title);
    for (const x of r.scope_names.plans) for (const k of [x.id, x.short_id, x.title]) if (k) plans.set(k, x.title);
  }
  return { role: (h) => roles.get(h), project: (ref) => projects.get(ref), plan: (ref) => plans.get(ref) };
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
      state === "skipped" ? "Skipped"
      : state === "accepted" ? (skipped > 0 ? `Accepted, ${skipped} skipped` : "Accepted")
      : failed > 0 ? `${plural(failed, "change", "changes")} failed. Accept tries ${failed === 1 ? "it" : "them"} again`
      : decided > 0 ? `${decided} of ${changes.length} changes decided`
      : null;
    const records = changes.every((c) => isSyncChange(c.change));
    const foldLabel = records ? plural(recordsInLine(changes), "record", "records") : plural(changes.length, "change", "changes");
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
    ? { count: `All ${total} decided`, action: "See them" }
    : { count: `${toDecide} to decide`, action: "Open the asks" };
}

/** The header's count: an ask is decided once nothing in it waits. */
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

/** A share as a person says it. Exact numbers are one tap away. */
function shareWords(share: number): string {
  if (share < 0.15) return "a tenth";
  if (share < 0.22) return "a fifth";
  if (share < 0.29) return "a quarter";
  if (share < 0.42) return "a third";
  if (share < 0.58) return "half";
  if (share < 0.71) return "two thirds";
  return "three quarters";
}

/**
 * The one line under the asks (S19): what accepting everything still open
 * does to the daily limits, as a share, in words. Reads the limit that costs
 * money first (tokens), then the two that only count activity. The
 * arithmetic (staffingModel.budgetArithmetic) is behind the tap.
 */
export function costLine(b: BudgetArithmetic): string {
  const lead = "If you accept everything, ";
  if (b.lines.length === 0) return `${lead}the daily limits stay as they are`;
  const key = (["tokens_per_day", "wakes_per_day", "hands_per_day"] as (keyof BudgetCaps)[]).find((k) => b.today[k] > 0 || b.after[k] > 0) ?? "tokens_per_day";
  const today = b.today[key], after = b.after[key];
  if (today <= 0) return `${lead}the agents get their first daily limit`;
  if (after <= 0) return `${lead}no agent has a daily limit left to use`;
  const ratio = after / today;
  if (Math.abs(ratio - 1) < 0.04) return `${lead}the daily limits add up to about the same`;
  if (ratio >= 1.8) return `${lead}the daily limits add up to about ${Math.round(ratio) === 2 ? "double" : `${Math.round(ratio)} times as much`}`;
  if (ratio < 0.12) return `${lead}the daily limits add up to almost nothing`;
  return `${lead}the daily limits add up to about ${shareWords(Math.abs(ratio - 1))} ${ratio > 1 ? "more" : "less"}`;
}

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
  const who = named ? `I am your ${authorName}, an agent that looks at how the work here is organized and suggests changes.` : "I am an agent that looked at how the work here is organized, and these are the changes I suggest.";
  return `${who} You decide each one, and nothing changes until you accept it.`;
}
