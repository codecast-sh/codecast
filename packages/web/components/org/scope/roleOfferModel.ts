// The Head of People's offer (docs/architecture/org-staffing.md S24): what its
// thread proposes next instead of a slash command. Pure: the row reads the
// Company review trigger, whether the seat is working, and the workspace's
// proposals, and says which one state the row is in. One state at a time, so
// a run in flight is never started twice from here.
import { COMPANY_REVIEW_TITLE, orgReviewFocusOf, type OrgReviewFocusKey } from "@codecast/shared/contracts/orgReview";

export type RoleOfferTrigger = {
  id: string;
  short_id: string | null;
  status: string;
  run_at: number | null;
  last_run_at: number | null;
  /** A run a person asked for that has not been claimed yet. */
  requested: boolean;
  /** The focus key on that request, when it carries one. */
  focus: string | null;
};

export type RoleOfferProposal = { _id: string; short_id: string; title: string; status: string; created_at: number };

export type RoleOfferInput = {
  trigger: RoleOfferTrigger | null;
  /** The standing session is working right now. */
  working: boolean;
  /** The workspace's proposals in any status; none means the org was never set up. */
  proposals: readonly RoleOfferProposal[];
  now: number;
};

/** The focus of the run in flight, in the row's words. */
export type RoleOfferFocus = { label: string; running: string };

export type RoleOffer =
  /** No live routine on the seat: nothing to offer from here. */
  | { kind: "none" }
  | { kind: "paused"; trigger: RoleOfferTrigger }
  /** Asked for, not yet picked up by the daemon. */
  | { kind: "starting"; trigger: RoleOfferTrigger; focus: RoleOfferFocus | null; since: number }
  /** The run landed in the thread and the seat is still on it. */
  | { kind: "reviewing"; trigger: RoleOfferTrigger; focus: RoleOfferFocus | null; since: number }
  | { kind: "offer"; trigger: RoleOfferTrigger; setUp: boolean; open: RoleOfferProposal | null };

/** How long after a run lands the seat's work still counts as that review. */
export const REVIEW_WINDOW_MS = 2 * 60 * 60 * 1000;

const LIVE = new Set(["scheduled", "running", "paused"]);

export function deriveRoleOffer(input: RoleOfferInput): RoleOffer {
  const t = input.trigger;
  if (!t || !LIVE.has(t.status)) return { kind: "none" };
  if (t.status === "paused") return { kind: "paused", trigger: t };
  const focus: RoleOfferFocus | null = orgReviewFocusOf(t.focus);
  // The request stands until a run has landed since it: run_at is the request
  // time (the store's run now flips it), last_run_at moves only when the
  // daemon has delivered the run.
  const runAt = t.run_at ?? 0;
  const lastRun = t.last_run_at ?? 0;
  if (t.status === "running" || (t.requested && lastRun < runAt)) return { kind: "starting", trigger: t, focus, since: runAt || input.now };
  const newest = input.proposals.reduce<RoleOfferProposal | null>((best, p) => (!best || p.created_at > best.created_at ? p : best), null);
  const landedSince = !!newest && newest.created_at >= lastRun;
  if (lastRun > 0 && input.now - lastRun < REVIEW_WINDOW_MS && input.working && !landedSince) return { kind: "reviewing", trigger: t, focus, since: lastRun };
  const open = input.proposals.filter((p) => p.status === "open").sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  return { kind: "offer", trigger: t, setUp: input.proposals.length === 0, open };
}

/** The Company review among a seat's triggers (the title is how every reader
 *  finds the routine), a live one first. */
export function companyReviewOf(tasks: readonly { title?: string; status: string }[]): any | null {
  const mine = tasks.filter((t) => t.title === COMPANY_REVIEW_TITLE);
  return mine.find((t) => t.status === "scheduled" || t.status === "running") ?? mine.find((t) => t.status === "paused") ?? mine[0] ?? null;
}

/** The trigger row as the offer reads it. */
export function offerTriggerOf(t: any | null): RoleOfferTrigger | null {
  if (!t) return null;
  return {
    id: String(t._id),
    short_id: t.short_id ?? null,
    status: t.status,
    run_at: typeof t.run_at === "number" ? t.run_at : null,
    last_run_at: typeof t.last_run_at === "number" ? t.last_run_at : null,
    requested: t.requested_run_source === "manual",
    focus: t.requested_run_focus ?? null,
  };
}

/** The one focus a person can give from the row today. */
export const GOAL_TREE_FOCUS: OrgReviewFocusKey = "goal_tree";
