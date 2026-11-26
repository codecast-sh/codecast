// Codecast's binding of the @platform/engine undo stack. The mechanics (the
// stacks, the history, the guard, replay and redo) live in the engine; this
// module installs sonner as the notifier and preserves the import path.
//
// - A recorded entry's toast carries an Undo button for THAT entry
//   (undoEntry), never whatever happens to be newest. Each recorded toast has
//   its own id, and once its entry leaves the undo stack (stepped from the
//   toast, the keyboard or the timeline, a multi-step "Back to here"
//   included, or lost to a conflict) the toast comes down, so no Undo button
//   outlives its entry.
// - Undo and redo announcements share one toast id, so a chain of undos
//   updates one toast in place instead of stacking them. sonner merges an
//   update into the toast it replaces, so every announcement names its action
//   (or its absence) explicitly; a "Redid" must not keep the "Undid" History.
// - A partial step says how many rows it reached: "Undid: X (2 of 3; 1
//   changed since)". A conflict comes from the engine through notify:
//   "Can't undo X: changed since".
// - While the timeline tier is hidden, the "Undid" toast offers a quiet
//   History action once there is more history than the step it announces.
// - An account boundary resets the history; the card and every undo toast
//   come down with it.
// - While the timeline card is open it narrates the steps, so the notifier
//   stays silent, and opening it takes down the status toast already showing.
//   A gesture recorded while the held peek shows still gets its own Undo
//   toast: the peek narrates steps, and it closes as the gesture ends the walk.
//   A ⌘Z that stops at an entry whose undo widens access is the one notice
//   the card cannot narrate by moving its head, so it flashes that row.
//   A Close or Kill whose close advice is pending keeps it when the card
//   opens: a needs-you verdict still shows its card while the entry is undoable,
//   and a needs-you card already on screen stays up.
// - A needs-you card is a toast of its own, raised fresh so it lands in front
//   of whatever showed since its gesture; it retires the receipt it replaces.
//   A receipt or notice raised here later goes behind it: the card is raised
//   again in front, with its whole life, as the phone's bar shows it again.
import { createElement } from "react";
import { toast } from "sonner";
import { getUndoHistory, onUndoReset, setUndoNotifier, subscribeUndoHistory, undoEntry, undoRowCount, type UndoEntry, type UndoNotifier } from "@platform/engine";
import * as undoTimeline from "../lib/undoTimelineOpen";
import { liftToasterAboveComposer } from "../lib/composerToasterLift";
import { splitLabelNote } from "./undo/labels";
import { CLOSE_ADVICE_CARD_MS, CLOSE_ADVICE_HOLD_MS, claimCloseAdvice, closeAdviceCard, type CloseAdviceCard, type PendingCloseAdvice } from "../lib/closeAdviceBar";

export const UNDO_STATUS_TOAST_ID = "undo-status";
/** The toast class that wears its action as a ghost button (components/ui/sonner.css). */
export const UNDO_QUIET_ACTION_CLASS = "cc-toast-quiet-action";
/** The toast class for undo receipts: one quiet line with a text Undo, not a
 *  card. A change the person just made needs a way back, not attention. */
export const UNDO_RECEIPT_CLASS = "cc-toast-receipt";
/** How long an entry's receipt stays up. */
export const UNDO_RECEIPT_MS = 5000;
/** The class of the card a Close or Kill receipt becomes when close advice
 *  says a closed session asked the person something (sonner.css). */
export const CLOSE_ADVICE_CLASS = "cc-toast-ask";

/** The id of the toast announcing a recorded entry. */
export function undoEntryToastId(entryId: string): string {
  return `undo-${entryId}`;
}

export function undoStepMessage(kind: "undo" | "redo", steps: number, entry: Pick<UndoEntry, "label" | "skipped" | "objects">): string {
  const verb = kind === "undo" ? "Undid" : "Redid";
  if (steps > 1) return `${verb} ${steps} changes`;
  const left = undoRowCount(entry.skipped);
  if (left === 0) return `${verb}: ${entry.label}`;
  const total = Math.max(undoRowCount(entry.objects), left);
  return `${verb}: ${entry.label} (${total - left} of ${total}; ${left} changed since)`;
}

/** Take down a toast if it is on screen (a no-op for an id that is not).
 *  sonner schedules the dismissal on a frame; without one (the bun store
 *  tests) no Toaster is mounted and there is nothing on screen to take down.
 *  Not gated on toast.getToasts(): a plain toast() never clears its id from
 *  sonner's dismissed set, so a reused id (the status toast) drops out of that
 *  list for good after its first dismissal while still showing on screen. */
function retireToast(id: string): void {
  if (typeof requestAnimationFrame !== "function") return;
  toast.dismiss(id);
}

/** Entries whose recorded toast may still be on screen, to that toast's id:
 *  the receipt's, or the needs-you card's that replaced it. */
const liveEntryToasts = new Map<string, string>();

/** One Close or Kill's close advice, from the gesture until the person lets
 *  its receipt or card go: the receipt timing out, Undo, a dismissal, or an
 *  answer on the card. The undo timeline taking the receipt down is not one
 *  of those, so a verdict still pending then shows its card when it lands. */
type LiveAdvice = {
  entryId: string;
  advice: PendingCloseAdvice;
  card: CloseAdviceCard | null;
  /** The receipt's own note (a Kill's "Agent stays stopped on undo"), kept on the card. */
  note?: string;
  triggersToastId?: string;
  /** The timeline took the receipt down: that is not the person letting it go. */
  behindTimeline?: boolean;
  /** The receipt or card holds the composer lift until it comes down. */
  release?: () => void;
  /** The toast showing the card now; each raise in front is a new one. */
  cardId?: string;
  raised?: number;
};
/** The close advice of every Close or Kill the person has not let go of. */
const liveAdvice = new Set<LiveAdvice>();
const adviceOf = (entryId: string) => [...liveAdvice].find((l) => l.entryId === entryId);
const undoable = (entryId: string) => getUndoHistory().undoOrder.includes(entryId);

// Any history change can move several entries at once (undoTo walks the
// stack), so every live toast whose entry is no longer undoable comes down.
subscribeUndoHistory(() => {
  if (liveEntryToasts.size === 0) return;
  const undoable = new Set(getUndoHistory().undoOrder);
  for (const [id, toastId] of liveEntryToasts) {
    if (undoable.has(id)) continue;
    liveEntryToasts.delete(id);
    retireToast(toastId);
  }
});

// The card opens in the toast corner and narrates from then on: the "Undid"
// toast that announced the step before the held peek opened, or a recorded
// entry's Undo toast, would sit on top of it. The card lists those entries
// with their own way back, so their toasts come down too.
// A verdict still pending outlives its receipt here: it shows its card when it
// lands. A needs-you card is a warning the timeline cannot narrate: it stays.
undoTimeline.subscribe(() => {
  if (!undoTimeline.isOpen()) return;
  retireToast(UNDO_STATUS_TOAST_ID);
  for (const [id, toastId] of [...liveEntryToasts]) {
    const live = adviceOf(id);
    if (live?.card) continue;
    if (live) live.behindTimeline = true;
    liveEntryToasts.delete(id);
    retireToast(toastId);
  }
});

// A reset history (the store's account boundary) takes everything that shows
// it down with it: the card, the status toast, and every entry's Undo toast.
onUndoReset(() => {
  undoTimeline.close();
  retireToast(UNDO_STATUS_TOAST_ID);
  for (const toastId of liveEntryToasts.values()) retireToast(toastId);
  liveEntryToasts.clear();
  liveAdvice.clear();
});

/** Codecast's notifier: sonner toasts, silent while the timeline is open. */
export const CODECAST_UNDO_NOTIFIER: UndoNotifier = {
  notify: (message) => {
    if (undoTimeline.isOpen()) return;
    toast(message, { id: UNDO_STATUS_TOAST_ID, description: undefined, action: undefined, className: UNDO_RECEIPT_CLASS });
    raiseCardsToFront();
  },
  notifyWithUndo: (label, entryId) => {
    // A Close or Kill hands its pending close advice to the bar it raises.
    const advice = claimCloseAdvice();
    const live: LiveAdvice | null = advice && { entryId, advice, card: null, note: splitLabelNote(label)[1] };
    // A newly recorded gesture is not a step the card narrates. The held
    // peek is on its way out (the gesture's key or click ends the walk), so
    // only the interactive card, which lists the entry with its own way
    // back, stands in for the entry's Undo toast. A closed session that asked
    // something is a warning the card cannot narrate: that card still shows.
    if (undoTimeline.isOpen() && undoTimeline.getMode() === "interactive") {
      if (live) awaitCloseAdvice(Object.assign(live, { behindTimeline: true }), null);
      return;
    }
    const receiptId = undoEntryToastId(entryId);
    liveEntryToasts.set(entryId, receiptId);
    // On a phone-width window a receipt that may become a card goes up above
    // the composer from the start, so the card grows where the receipt was.
    // It holds the lift until it comes down; another advised toast still up
    // keeps it.
    if (live) live.release = liftToasterAboveComposer();
    // Its card retiring it is not the person letting it go.
    const forget = () => {
      if (live?.card) return;
      if (liveEntryToasts.get(entryId) === receiptId) liveEntryToasts.delete(entryId);
      if (live) letGo(live);
    };
    const [title, description] = splitLabelNote(label);
    const receipt = (duration: number) => toast(title, {
      id: receiptId,
      description,
      // sonner takes a toast down on its own button without onDismiss.
      action: { label: "Undo", onClick: () => { forget(); undoEntry(entryId); } },
      className: UNDO_RECEIPT_CLASS,
      duration,
      onAutoClose: forget,
      onDismiss: forget,
    });
    // While a verdict is pending the receipt looks as it always does; it only
    // lives longer, so a late verdict still finds it up.
    receipt(live ? UNDO_RECEIPT_MS + CLOSE_ADVICE_HOLD_MS : UNDO_RECEIPT_MS);
    raiseCardsToFront();
    if (live) awaitCloseAdvice(live, receipt);
  },
  onConfirmStop: (entry, message) => {
    if (undoTimeline.isOpen()) undoTimeline.flashRow(entry.id);
    // The message points at the entry's toast, which is long gone by the
    // time a ⌘Z reaches it, so this toast carries that Undo itself.
    else {
      toast(message, { id: UNDO_STATUS_TOAST_ID, description: undefined, action: { label: "Undo", onClick: () => undoEntry(entry.id) }, className: undefined });
      raiseCardsToFront();
    }
  },
  onHistoryStep: (kind, steps, entry) => {
    if (undoTimeline.isOpen()) return;
    const more = kind === "undo"
      && undoTimeline.UNDO_HISTORY_TIER === "hidden"
      && getUndoHistory().items.length > steps;
    // The status toast is one id updated in place, so the note is always
    // passed, undefined included, or the last one's would stay under it.
    const [title, description] = splitLabelNote(undoStepMessage(kind, steps, entry));
    toast(title, {
      id: UNDO_STATUS_TOAST_ID,
      description,
      action: more ? { label: "History", onClick: () => undoTimeline.open("interactive") } : undefined,
      // Quiet: a way into the history, not the toast's answer (sonner.css).
      className: more ? `${UNDO_RECEIPT_CLASS} ${UNDO_QUIET_ACTION_CLASS}` : UNDO_RECEIPT_CLASS,
    });
    raiseCardsToFront();
  },
};
setUndoNotifier(CODECAST_UNDO_NOTIFIER);

// ── Close advice on a Close or Kill receipt (lib/closeAdviceBar) ──

/** The person let this gesture's toast go (or the timeline took it while a
 *  verdict was pending, which keeps the advice): its advice ends with it. */
function letGo(live: LiveAdvice): void {
  live.release?.();
  live.release = undefined;
  if (live.card || !live.behindTimeline) liveAdvice.delete(live);
}

/** Wait for the verdict, tracked from the gesture. `receipt` re-raises the
 *  gesture's receipt; null when none was raised (the interactive timeline). */
function awaitCloseAdvice(live: LiveAdvice, receipt: ((duration: number) => void) | null): void {
  const shownAt = Date.now();
  liveAdvice.add(live);
  void live.advice.verdict.then((results) => {
    // Let go of, or taken back: the verdict has nowhere to land.
    if (!liveAdvice.has(live) || !undoable(live.entryId)) return void liveAdvice.delete(live);
    const card = closeAdviceCard(live.advice, results);
    if (card) return showAdviceCard(card, live);
    liveAdvice.delete(live);
    // Nothing asked: back to the receipt's own life, what is left of it, and
    // sonner's timer decides (it waits while the bar is hovered or the tab hidden).
    if (receipt && liveEntryToasts.get(live.entryId) === undoEntryToastId(live.entryId)) receipt(Math.max(UNDO_RECEIPT_MS - (Date.now() - shownAt), 1));
  });
}

/** The card takes the receipt's place (or shows, when the timeline took the
 *  receipt): the ask, a Kill's triggers line and the receipt's note under it, Undo, and Open or Keep
 *  K. A new toast, so sonner puts it in front of any toast raised since the
 *  gesture (an update keeps a toast where it was in the stack, hidden behind
 *  newer ones), retiring the toast it replaces; `fresh: false` (a later
 *  triggers line) updates it in place. One toast: a triggers notice of the
 *  same kill is taken down and its line joins the card. */
function showAdviceCard(card: CloseAdviceCard, live: LiveAdvice, fresh = true): void {
  const { entryId } = live;
  live.card = card;
  const shown = liveEntryToasts.get(entryId);
  if (fresh || !live.cardId) {
    if (shown) retireToast(shown);
    live.raised = (live.raised ?? 0) + 1;
    // Never shown or dismissed before, so sonner never merges it into a toast on its way out.
    live.cardId = `${undoEntryToastId(entryId)}:ask-${live.raised}`;
  }
  const cardId = live.cardId!;
  liveEntryToasts.set(entryId, cardId);
  live.release ??= liftToasterAboveComposer();
  const done = () => {
    // A copy retired by a raise in front is not the card going.
    if (live.cardId !== cardId) return;
    if (liveEntryToasts.get(entryId) === cardId) liveEntryToasts.delete(entryId);
    letGo(live);
  };
  const description = createElement(
    "span",
    { className: "cc-toast-ask-body" },
    createElement("span", { className: "cc-toast-ask-reason" }, card.ask),
    card.triggers ? createElement("span", { className: "cc-toast-ask-note" }, card.triggers) : null,
    live.note ? createElement("span", { className: "cc-toast-ask-note" }, live.note) : null,
  );
  toast(card.title, {
    id: cardId,
    description,
    // sonner takes a toast down on its own buttons without onDismiss.
    cancel: { label: "Undo", onClick: () => { done(); undoEntry(entryId); } },
    action: { label: card.action.label, onClick: () => { done(); live.advice.keep(card.action.sessions, card.action.open); } },
    className: CLOSE_ADVICE_CLASS,
    duration: CLOSE_ADVICE_CARD_MS,
    onAutoClose: done,
    onDismiss: done,
  });
  if (live.triggersToastId) retireToast(live.triggersToastId);
}

/** A receipt or notice just raised goes behind every needs-you card still
 *  up: each is raised again in front, oldest first, with its whole life. */
function raiseCardsToFront(): void {
  for (const live of liveAdvice) {
    if (live.card && live.cardId && liveEntryToasts.get(live.entryId) === live.cardId && undoable(live.entryId)) showAdviceCard(live.card, live);
  }
}

/**
 * A Kill's "Also canceled … triggers" line. While that kill's receipt waits on
 * close advice, the line is kept for the card; when the card is already up,
 * it joins the card and the caller shows no toast of its own (true). Otherwise
 * the caller shows its own notice under `toastId`, which the card takes down
 * if it comes. `advice` is that Kill's own (animatedHideSessions), so a later
 * Kill of a session an earlier gesture closed never joins that gesture's card.
 */
export function closeAdviceTakesTriggers(advice: PendingCloseAdvice | null, line: string, toastId: string): boolean {
  // This kill's advice, while the person has not let go of it, pending or a card.
  const live = advice && [...liveAdvice].find((l) => l.advice === advice && undoable(l.entryId));
  if (!live) return false;
  live.advice.triggers = line;
  if (!live.card) {
    live.triggersToastId = toastId;
    return false;
  }
  showAdviceCard({ ...live.card, triggers: line }, live, false);
  return true;
}

/**
 * Give a gesture exactly one toast. When `fn` records an undo entry the toast
 * is that entry's own, with its Undo button, taken down once the entry is
 * undone: a spec with `toast: true` has raised it already, and otherwise
 * `message` raises it. A gesture that recorded nothing shows `message` plainly.
 */
export function gestureToast<T>(message: string, fn: () => T): T {
  const before = getUndoHistory().head;
  const out = fn();
  const head = getUndoHistory().head;
  if (head && head !== before) {
    if (!liveEntryToasts.has(head)) CODECAST_UNDO_NOTIFIER.notifyWithUndo!(message, head);
  } else {
    toast.success(message);
    raiseCardsToFront();
  }
  return out;
}

export {
  pushUndo,
  performUndo,
  performRedo,
  undoEntry,
  undoTo,
  redoTo,
  undoGroup,
  withoutUndo,
  showUndoToast,
  canUndo,
  canRedo,
  deferUndoGesture,
  commitPendingUndoGestures,
  getUndoHistory,
  subscribeUndoHistory,
  getUndoKeyboardWindowMs,
  undoKeyboardSince,
  useUndoHistory,
  type UndoEntry,
  type UndoOutcome,
  type UndoHistoryItem,
  type UndoHistorySnapshot,
  type CellChange,
  type UndoSpec,
  type UndoWriter,
  type Invocation,
} from "@platform/engine";
