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
   *  "Accepted", "Accepted, 1 skipped", "12 of 105 decided", "2 failed". */
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
      : decided > 0 ? `${decided} of ${changes.length} decided`
      : null;
    const records = changes.every((c) => isSyncChange(c.change));
    const foldLabel = records ? plural(recordsInLine(changes), "record", "records") : plural(changes.length, "change", "changes");
    return { index, title: a.title, why: a.why, effect: a.effect, changes, remaining, failed, skipped, state, foldLabel, verdictLine };
  });
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
  if (b.lines.length === 0) return "After: the daily limits stay the same";
  const key = (["tokens_per_day", "wakes_per_day", "hands_per_day"] as (keyof BudgetCaps)[]).find((k) => b.today[k] > 0 || b.after[k] > 0) ?? "tokens_per_day";
  const today = b.today[key], after = b.after[key];
  if (today <= 0) return "After: the agents get their first daily limit";
  if (after <= 0) return "After: no agent has a daily limit left to use";
  const ratio = after / today;
  if (Math.abs(ratio - 1) < 0.04) return "After: the daily limits add up to about the same";
  if (ratio >= 1.8) return `After: the daily limits add up to about ${Math.round(ratio) === 2 ? "double" : `${Math.round(ratio)} times as much`}`;
  if (ratio < 0.12) return "After: the daily limits add up to almost nothing";
  return `After: the daily limits add up to about ${shareWords(Math.abs(ratio - 1))} ${ratio > 1 ? "more" : "less"}`;
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
export function letterParts(summaryMd: string | null | undefined): { lead: string; rest: string; evidenceHref: string | null } {
  const { ask, tail, evidenceHref } = splitAsk(summaryMd);
  const paragraphs = [ask, ...tail.split(/\n[ \t]*\n+/)].map((p) => p.trim()).filter(Boolean);
  let taken = 0, size = 0;
  for (const p of paragraphs) {
    if (taken > 0 && size + p.length > LETTER_LEAD_CHARS) break;
    taken += 1; size += p.length;
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
