// Close advice on the undo bar: after the person Closes or Kills sessions the
// inbox did not file under Needs You, close advice (convex
// closeAdvice.adviseAfterClose) says which of them asked the person something,
// and the gesture's undo bar says so. The gesture never waits: it lands and
// shows its usual receipt at once, the call runs beside it, and a needs_you
// verdict that arrives while the bar is up turns the receipt into a card.
//
// This module is the part every app shares (web store/undoStack draws the
// sonner toast, the phone its undo bar): which rows are asked about, the call
// with its deadline, and the card's words. Relative imports only: the phone
// bundles this file.
import { AFTER_CLOSE_MAX, type AfterCloseResult, type CloseGesture } from "@codecast/shared/contracts/closeKind";
import { userRestOf, type InboxBucket, type WorkState } from "@codecast/shared/contracts";
import { counted, quoted } from "../store/undo/labels";
import { isSessionDismissed, isSessionStashed } from "./sessionRetirement";

/** How much longer than its usual life the bar stays while a verdict is
 *  pending. Nothing on it says so: a verdict that lands in time changes it, and
 *  one that does not is dropped. */
export const CLOSE_ADVICE_HOLD_MS = 6000;
// The server stops each advice call at AFTER_CLOSE_CALL_MS (contracts/closeKind),
// well inside the receipt plus this hold, so its answer lands while the bar waits.
/** The card asks something of the person, so it stays up longer than a receipt. */
export const CLOSE_ADVICE_CARD_MS = 12000;

/** The placements the inbox shows under Needs You: the person has seen those,
 *  so a Close of one is deliberate and is never asked about. */
const NEEDS_YOU_BUCKETS: ReadonlySet<InboxBucket> = new Set<InboxBucket>(["questions", "needs_input"]);
/** The shelves the person filed a row on themselves (Closed, Stashed, Snoozed),
 *  like their own Done: a Kill from there is deliberate and is never asked about. */
const OWN_FILING_BUCKETS: ReadonlySet<InboxBucket> = new Set<InboxBucket>(["dismissed", "stashed", "snoozed"]);

/** The person's own filing read off the row's stamps, for a row the placement
 *  does not cover (a Closed or Stashed row past the working set's recency
 *  window). Any snooze stamp counts: a due one resurfaces under Needs You. */
function ownFilingOf(row: CloseAdviceRow): InboxBucket | undefined {
  if (isSessionDismissed(row)) return "dismissed";
  if (isSessionStashed(row)) return "stashed";
  return row.inbox_snoozed_until ? "snoozed" : undefined;
}

/** A row's placement as the inbox shows it (store placedRailPlacement): the
 *  section it files under and its own work state. */
export type CloseAdvicePlacement = { bucket: InboxBucket; state: WorkState };

export type CloseAdviceRow = {
  _id: string;
  updated_at: number;
  inbox_rest?: string | null;
  inbox_rest_at?: number | null;
  inbox_dormant_at?: number | null;
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  inbox_snoozed_until?: number | null;
};

/**
 * The rows of a Close or Kill to ask close advice about, read from the store
 * just BEFORE the gesture: the person's own sessions (`mine`), in a workspace
 * with close advice on (`featureOn`), that the inbox filed outside Needs You
 * and Working (`bucket`, the placement the inbox itself shows) and the person did not
 * file Done, Closed, Stashed or Snoozed themselves (a row the placement
 * does not cover is read off its own stamps). The server trusts this list. At most AFTER_CLOSE_MAX,
 * the first ones of the gesture.
 */
export function closeAdviceTargets<R extends CloseAdviceRow>(
  ids: readonly string[],
  look: {
    row: (id: string) => R | undefined;
    placement: (id: string) => CloseAdvicePlacement | null | undefined;
    featureOn: (row: R) => boolean;
    mine: (row: R) => boolean;
  },
): string[] {
  const out: string[] = [];
  for (const id of new Set(ids)) {
    if (out.length >= AFTER_CLOSE_MAX) break;
    const row = look.row(id);
    if (!row || !look.mine(row) || !look.featureOn(row)) continue;
    const placement = look.placement(id);
    // Still at work, whatever section it files in (Pinned, or a lead's as a
    // rider): it has asked nothing yet, so a Close sets it aside and a Kill
    // stops what the person saw running. (Sleeping stays asked about: a Kill
    // cancels the wake behind a promise.)
    if (placement?.state === "working") continue;
    const bucket = placement?.bucket ?? ownFilingOf(row);
    if (bucket && (NEEDS_YOU_BUCKETS.has(bucket) || OWN_FILING_BUCKETS.has(bucket))) continue;
    if (userRestOf({ ...row, inbox_rest: row.inbox_rest ?? null }) === "done") continue;
    out.push(id);
  }
  return out;
}

/** The server call: the sessions, and the gesture that closed them (the
 *  server reads each as that gesture leaves it). */
export type AdviseAfterClose = (sessions: string[], gesture: CloseGesture) => Promise<{ results: AfterCloseResult[] }>;

let boundCall: AdviseAfterClose | null = null;
/** The app binds the server call once, where it holds its Convex client. */
export function bindCloseAdviceCall(call: AdviseAfterClose | null): void {
  boundCall = call;
}
export const closeAdviceCall = (): AdviseAfterClose | null => boundCall;

/** The verdicts, or null on an error or once `waitMs` passes: either way the
 *  bar stays as it is. Never rejects. `call` is the bound call with its
 *  gesture given. */
export function requestCloseAdvice(call: (sessions: string[]) => ReturnType<AdviseAfterClose>, sessions: string[], waitMs: number): Promise<AfterCloseResult[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), waitMs);
    const settle = (results: AfterCloseResult[] | null) => {
      clearTimeout(timer);
      resolve(results);
    };
    try {
      call(sessions).then((r) => settle(Array.isArray(r?.results) ? r.results : null), () => settle(null));
    } catch {
      settle(null);
    }
  });
}

export type CloseVerb = "Closed" | "Killed";

/** One gesture's pending advice, from the moment it is pressed until its bar comes down. */
export type PendingCloseAdvice = {
  verb: CloseVerb;
  /** Every session the gesture closed. */
  ids: string[];
  /** The ones asked about (closeAdviceTargets). */
  targets: string[];
  /** Each target's title as the inbox showed it. */
  titles: Record<string, string | undefined>;
  verdict: Promise<AfterCloseResult[] | null>;
  /** A Kill's "Also canceled … triggers" line, once the kill has said it. */
  triggers?: string;
  /** The card's second answer: bring back only `sessions` (Keep K), and
   *  open the one at its last message (Open). */
  keep: (sessions: string[], open: boolean) => void;
};

// The advice of the gesture being committed right now, handed to the undo bar
// its own write raises (claimCloseAdvice). The write and the bar are one
// synchronous call, so nothing else can claim it in between.
let armed: PendingCloseAdvice | null = null;

/** Run the gesture's write with its advice on hand for the bar it raises. */
export function withCloseAdvice<T>(advice: PendingCloseAdvice | null, write: () => T): T {
  armed = advice;
  try {
    return write();
  } finally {
    armed = null;
  }
}

/** The undo bar of a gesture takes its advice (once). */
export function claimCloseAdvice(): PendingCloseAdvice | null {
  const advice = armed;
  armed = null;
  return advice;
}

/** Close advice's reason, as one line of text (the bar clamps it to two lines). */
export function askLine(reason: string | undefined): string {
  return (reason ?? "").replace(/\s+/g, " ").trim() || "It asked you something";
}

export type CloseAdviceCard = {
  title: string;
  /** The ask: advice's reason for one session, the count for several. Clamped to two lines. */
  ask: string;
  /** A Kill's triggers line, under the ask. */
  triggers?: string;
  /** The second answer beside Undo: Open (one session) or Keep K (several). */
  action: { label: string; sessions: string[]; open: boolean };
};

/**
 * The card a gesture's undo bar becomes, or null when no closed session asked
 * the person anything (a close or skip verdict, an error, a timeout): the bar
 * stays the plain receipt.
 *   one asked:   `Closed “X”` (`and N more` in a bulk), the reason, Undo / Open
 *   K≥2 asked:   `Closed N sessions`, `K asked you something`, Undo / Keep K
 */
export function closeAdviceCard(advice: Pick<PendingCloseAdvice, "verb" | "ids" | "targets" | "titles" | "triggers">, results: AfterCloseResult[] | null): CloseAdviceCard | null {
  const targets = new Set(advice.targets);
  const asked = (results ?? []).filter((r) => r.verdict === "needs_you" && targets.has(r.session));
  const askedIds = [...new Set(asked.map((r) => r.session))];
  if (askedIds.length === 0) return null;
  const n = Math.max(advice.ids.length, askedIds.length);
  const triggers = advice.triggers || undefined;
  if (askedIds.length === 1) {
    const id = askedIds[0]!;
    const more = n > 1 ? ` and ${n - 1} more` : "";
    return {
      title: `${advice.verb} ${quoted(advice.titles[id], "session")}${more}`,
      ask: askLine(asked.find((r) => r.session === id)?.reason),
      triggers,
      action: { label: "Open", sessions: [id], open: true },
    };
  }
  return {
    title: `${advice.verb} ${counted(n, "session")}`,
    ask: `${askedIds.length} asked you something`,
    triggers,
    action: { label: `Keep ${askedIds.length}`, sessions: askedIds, open: false },
  };
}
