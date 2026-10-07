// The org screen's pure helpers (docs/architecture/org-staffing.md S41): the
// URL, the message a proposal's card sits in, which proposals to feed, the
// strip's rows, the mission, and the path the split opens. No React, so the
// rules test without a DOM.

import { proposalTotals } from "@codecast/shared/contracts/orgChangeWords";
import { agoOf } from "../../lib/threadState";
import { proposalAnswersOf } from "../../lib/reviewActions";
import type { PendingComment } from "../../lib/quoteFormat";
import { composeParam, openProposals, proposalParam, proposalProgress } from "./staffingModel";
import type { OrgProposalAuthor, OrgProposalRow } from "./orgStaffingTypes";
import type { MapFilter } from "./OrgMap";

/** A host's scroll-to request for an embedded conversation: the message to
 *  land on, or the time to centre on while the message is not loaded, with
 *  `find` naming the proposal whose card the embed then looks for in the
 *  window that lands (findProposalCardMessage). A new nonce is a new request.
 *  `onSettled` runs once the thread has settled on the message's row, once
 *  per nonce: the host then lands on what it wanted inside that row (a card,
 *  the focused entry), and the thread's own settle yields to that scroll. */
export type JumpRequest = { messageId?: string; timestamp?: number; find?: string; nonce: number; onSettled?: () => void };

export type OrgScreenShow = "conversation" | "map";

/** Under this width the two columns stack behind a Conversation | Map
 *  switch: the conversation's 560px floor and the map's 360px floor, with
 *  room for the cards' wide layout (ProposalSubjectCard flips at 561px). */
export const ORG_STACK_BELOW = 980;

export type OrgScreenParams = {
  /** `op-N`, lower case: the card to scroll to, or the foreign row to expand. */
  proposal: string | null;
  /** The change seq to light. */
  focus: number | null;
  /** The stacked layout's column; ignored when wide. */
  show: OrgScreenShow | null;
  /** The conversation this pane sits beside, set by the split opener. */
  beside: string | null;
  /** The map's filter; absent reads as everything. */
  lens: MapFilter;
  /** "As proposed" on the map; `proposed=0` turns it off. */
  proposed: boolean;
  /** Text to seed the head's draft with. */
  compose: string | null;
  /** `panel=history`: open the history sheet. */
  history: boolean;
};

const paramsOf = (search: string | URLSearchParams | null | undefined): URLSearchParams =>
  typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search ?? new URLSearchParams();

/** Every URL parameter the screen reads, from one parse. `s` and `follow` are
 *  not read: the pane never follows a thread. */
export function orgScreenParams(search: string | URLSearchParams | null | undefined): OrgScreenParams {
  const q = paramsOf(search);
  const s = q.toString();
  const focus = q.get("focus");
  const show = q.get("show");
  const lens = q.get("lens");
  return {
    proposal: proposalParam(s),
    focus: focus && /^\d+$/.test(focus) ? Number(focus) : null,
    show: show === "conversation" || show === "map" ? show : null,
    beside: q.get("beside") || null,
    lens: lens === "goals" || lens === "people" ? lens : "everything",
    proposed: q.get("proposed") !== "0",
    compose: composeParam(s),
    history: q.get("panel") === "history",
  };
}

/** `/org?` with `proposal`, `focus`, `lens`, `show`, `beside`, in that order
 *  and only those set; `everything` is the absent lens. The split opener and
 *  the chip build their links here. */
export function orgScreenPath(p: { proposal?: string | null; focus?: string | number | null; lens?: string | null; show?: OrgScreenShow | null; beside?: string | null }): string {
  const q = new URLSearchParams();
  if (p.proposal) q.set("proposal", p.proposal);
  if (p.focus !== undefined && p.focus !== null && p.focus !== "") q.set("focus", String(p.focus));
  if (p.lens && p.lens !== "everything") q.set("lens", p.lens);
  if (p.show) q.set("show", p.show);
  if (p.beside) q.set("beside", p.beside);
  const s = q.toString();
  return s ? `/org?${s}` : "/org";
}

/** The message that draws a proposal's card: the first one from the START
 *  whose text has `op-N` alone on a line (the same line CARD_RE in
 *  orgChartPointer.ts reads, which also takes `#seq`; fold the two together
 *  once that file settles) and that a person did not write. The author posts
 *  the card once; later turns write `op-N#3` in sentences and the person's
 *  reply block writes `op-N#seq` followed by words, so neither matches. */
export function findProposalCardMessage(messages: readonly { _id: string; role?: string; content?: string }[] | undefined, shortId: string): string | null {
  const re = new RegExp(`^[ \\t]*${shortId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "im");
  return messages?.find((m) => m.role !== "user" && typeof m.content === "string" && re.test(m.content))?._id ?? null;
}

/** The change rows of this many open proposals are fed at once (one
 *  subscription each, OrgProposalFeeders); real data needs about five. */
export const OPEN_PROPOSAL_FEED_CAP = 8;

/** The refs to feed change rows for: this workspace's open proposals, oldest
 *  first, capped, plus the linked one when it is not among them. */
export function openProposalsToFeed(rows: OrgProposalRow[], linkedRef: string | null): string[] {
  const refs = openProposals(rows).reverse().slice(0, OPEN_PROPOSAL_FEED_CAP).map((p) => p.short_id);
  if (linkedRef && !refs.includes(linkedRef)) refs.push(linkedRef);
  return refs;
}

/** The strip row's count: the one helper's ("64 records", "11 changes to
 *  goals"), or the list row's while the change rows load. */
export function stripCount(p: Pick<OrgProposalRow, "changes" | "counts">): string {
  if (p.changes.length === 0) return p.counts?.total ? `${p.counts.total} changes` : "";
  return proposalTotals(p.changes).count;
}

/** The strip row's totals sentence (its hover): the one helper's line without
 *  the stop, else the count. */
export function stripTotals(p: Pick<OrgProposalRow, "changes" | "counts">): string {
  const line = p.changes.length ? proposalTotals(p.changes).line : null;
  return (line ?? stripCount(p)).replace(/\.$/, "");
}

export type StripRow = {
  proposal: OrgProposalRow;
  /** The proposal's thread is not the conversation on screen (or it has
   *  none): nothing to scroll to, so the strip expands its card instead. */
  foreign: boolean;
  /** The short count drawn on the row. */
  count: string;
  /** The totals sentence, for the row's hover. */
  totals: string;
  /** Answers staged in this conversation's batch for this proposal. */
  answered: number;
  decided: number;
  total: number;
  age: string;
  author: OrgProposalAuthor;
};

/** The strip's rows: the open proposals OLDEST first, so the rows match the
 *  order of the cards in the thread and the oldest, which has waited longest,
 *  leads. `everyRowHere` is the dev preview, whose column draws every
 *  fixture itself: no row is foreign, whatever thread it names. */
export function stripRows(open: OrgProposalRow[], headConv: string | null, comments: readonly PendingComment[] | undefined, now: number, everyRowHere = false): StripRow[] {
  return openProposals(open).reverse().map((proposal) => {
    const { decided, total } = proposalProgress(proposal);
    return {
      proposal,
      foreign: !everyRowHere && proposal.thread?.conversation_id !== headConv,
      count: stripCount(proposal),
      totals: stripTotals(proposal),
      answered: proposalAnswersOf(comments, proposal._id).length,
      decided,
      total,
      age: agoOf(now - proposal.created_at),
      author: proposal.author,
    };
  });
}

/** The strip's one line: how many wait, the changes they hold in all (when
 *  every row's count is known), and the staged answers across them. */
export function stripLine(rows: readonly Pick<StripRow, "proposal" | "answered">[]): { wait: string; changes: string | null; answered: string | null } {
  // The list row's count, or the fed change rows when the list row has none
  // (the dev preview's fixtures); a row with neither leaves the changes off.
  const totals = rows.map((r) => r.proposal.counts?.total ?? (r.proposal.changes.length || undefined));
  const changes = totals.every((t): t is number => typeof t === "number") ? totals.reduce((n, t) => n + t, 0) : null;
  const answered = rows.reduce((n, r) => n + r.answered, 0);
  return {
    wait: rows.length === 1 ? "1 proposal waits on you" : `${rows.length} proposals wait on you`,
    changes: changes === null ? null : changes === 1 ? "1 change" : `${changes} changes`,
    answered: answered > 0 ? `${answered} answered, waiting for your send` : null,
  };
}

/** The mission, by goalsLayout's rule: roots are rows with no parent; a root
 *  with a child among the rows is a mission; exactly one mission and exactly
 *  one root is that goal, else none. */
export function missionOf(rows: readonly { _id: string; short_id: string; title: string; parent_initiative_id?: string }[]): { title: string; shortId: string } | null {
  const roots = rows.filter((r) => !r.parent_initiative_id);
  if (roots.length !== 1) return null;
  const root = roots[0];
  return rows.some((r) => r.parent_initiative_id === root._id) ? { title: root.title, shortId: root.short_id } : null;
}
