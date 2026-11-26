// Close advice for a Close or Kill, read off the store: which rows are asked
// about, the pending advice the gesture's undo bar takes, and Keep K. Web
// (store/undoActions) and the phone (mobile lib/undoBar) both start it here,
// so the two apps ask about the same rows and bring back the same ones; each
// draws its own bar and opens a session its own way. Relative imports only:
// the phone bundles this file.
import { placedRailPlacement, placeInboxRows, useInboxStore, viewerCommandsSession } from "./inboxStore";
import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { CLOSE_ADVICE_HOLD_MS, closeAdviceCall, closeAdviceTargets, requestCloseAdvice, type CloseVerb, type PendingCloseAdvice } from "../lib/closeAdviceBar";
import { isConvexId } from "../lib/entityLinks";
import { counted, undoAsOne } from "./undo/labels";

type State = ReturnType<typeof useInboxStore.getState>;

/**
 * The rows of a Close or Kill to ask close advice about, as the store holds
 * them just before the gesture (lib/closeAdviceBar closeAdviceTargets): the
 * viewer's own sessions, in a workspace with close advice on, that the inbox
 * placement files outside Needs You, whose agent is not still at work, and
 * the person did not file Done.
 */
export function closeAdviceTargetsIn(state: State, ids: string[]): string[] {
  let placed: ReturnType<typeof placeInboxRows> | null = null;
  const meId = state.currentUser?._id?.toString?.() ?? null;
  return closeAdviceTargets(ids, {
    row: (id) => state.sessions[id],
    placement: (id) => placedRailPlacement((placed ??= placeInboxRows(state, { focusedId: state.currentSessionId ?? null })), id),
    featureOn: (row) => workspaceFeatureEnabled(state.teams || [], row.team_id ?? null, "close_advice"),
    mine: (row) => isConvexId(row._id) && meId !== null && viewerCommandsSession(row, meId),
  });
}

/** Ask close advice about a Close or Kill as it is pressed, beside it: the
 *  gesture never waits. `receiptMs` is how long the app's bar normally stays
 *  up; the verdict may land until CLOSE_ADVICE_HOLD_MS past it. `keep` is the
 *  card's second answer (Keep K, or Open). Null when nothing is asked (the
 *  feature off, no row outside Needs You, no server bound). */
export function startCloseAdvice(
  ids: string[],
  verb: CloseVerb,
  opts: { receiptMs: number; keep: PendingCloseAdvice["keep"] },
): PendingCloseAdvice | null {
  const call = closeAdviceCall();
  if (!call) return null;
  const state = useInboxStore.getState();
  const targets = closeAdviceTargetsIn(state, ids);
  if (targets.length === 0) return null;
  return {
    verb,
    ids,
    targets,
    titles: Object.fromEntries(targets.map((id) => [id, state.sessions[id]?.title || (state.conversations as any)?.[id]?.title])),
    verdict: requestCloseAdvice((sessions) => call(sessions, verb === "Killed" ? "kill" : "close"), targets, opts.receiptMs + CLOSE_ADVICE_HOLD_MS),
    keep: opts.keep,
  };
}

/** Bring back only `ids` of a Close or Kill, as one undo (the first lands
 *  last, so it is the one in view). Keep K (`file`) also files them under
 *  Needs You, so the person sees which ones asked; Open only brings its one
 *  back, since it opens it. */
export function restoreAsked(ids: string[], file: boolean): void {
  const store = useInboxStore.getState();
  undoAsOne(`Kept ${counted(ids.length, "session")}`, () => {
    for (const id of [...ids].reverse()) {
      store.restoreSession(id);
      if (file) store.setSessionRest(id, "needs_input");
    }
  });
}

/** The id of a session's last message the store holds, for Open. */
export function lastMessageId(id: string): string | undefined {
  const messages = (useInboxStore.getState().messages?.[id] ?? []) as Array<{ _id?: string }>;
  return messages[messages.length - 1]?._id;
}
