import { create } from 'zustand';
import { getUndoHistory, onUndoReset, setUndoNotifier, undoEntry, withoutUndo } from '@platform/engine';
import { sessionTitle, splitLabelNote } from '@codecast/web/store/undo/labels';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { lastMessageId, restoreAsked, startCloseAdvice } from '@codecast/web/store/closeAdvice';
import {
  CLOSE_ADVICE_CARD_MS, CLOSE_ADVICE_HOLD_MS, claimCloseAdvice, closeAdviceCard, withCloseAdvice, type PendingCloseAdvice,
} from '@codecast/web/lib/closeAdviceBar';

// The app's one undo bar (components/UndoBar, mounted at the root). It is the
// mobile notifier for the shared undo engine: every gesture the engine records
// with a toast (close, stash, kill-all, restore) shows here with its own Undo, as
// sonner shows it on web (web/store/undoStack.ts).
//
// A single kill does not run straight away. Undoing a kill brings the row back
// but leaves the agent stopped, so the kill is held behind the bar instead and
// only reaches the store when the bar drains. Undo during the hold leaves the
// agent untouched. A new bar, the app leaving the foreground (the bar's
// AppState listener, setAppActive), or swiping the bar away runs the held
// kill at once, so it is never lost. No React Native in here, so bun tests it
// directly.
//
// Close advice (web lib/closeAdviceBar): a Close or Kill of rows the inbox
// filed outside Needs You asks the server, beside the gesture, whether any of
// them asked the person something. The bar shows as it always does, only held
// up to CLOSE_ADVICE_HOLD_MS longer while the verdict is pending; a needs-you
// verdict turns it into a card (the ask, Undo and Open), anything
// else puts it back on its own clock. There is one bar, so a later gesture's
// bar can take the place of one still waiting on its verdict: that gesture's
// needs-you card still shows when it lands, and its answers act on that
// earlier gesture. It never takes the place of a bar still inside its own undo
// window (that would run its held Kill early or drop its Undo): it waits for
// that bar to go, however it goes, and replaces only a notice.
//
// A card leaves only when the person answers it (Undo, Open, Keep K, a swipe)
// or when its own life runs out on screen. Anything else that takes it off
// the screen (a newer bar, the app going inactive, which also runs a held
// kill) puts it back at the front of the queue, and it shows again with its
// whole life as soon as the screen is free. A queued card is dropped only
// when its gesture can no longer be taken back (undone, or the account
// changed).

export const UNDO_BAR_MS = 5000;
/** How long the bar takes to leave (components/UndoBar), from leaveUndoBar
 *  to dismissUndoBar. */
export const UNDO_BAR_EXIT_MS = 140;
const NOTICE_MS = 2500;

export type UndoBarItem = {
  /** Each showing has its own key, so the bar restarts its countdown. */
  key: number;
  title: string;
  note?: string;
  durationMs: number;
  tone: 'quiet' | 'kill';
  onUndo?: () => void;
  /** Close advice's card: what the closed session asked, clamped to two lines. */
  ask?: string;
  /** The card's second answer beside Undo: Open, or Keep K. */
  action?: { label: string; onPress: () => void };
  /** Bumped when the bar's life changes under the same key (a verdict
   *  landed), so the bar restarts its countdown without showing again. */
  life: number;
};

type UndoBarState = {
  item: UndoBarItem | null;
  heldKillId: string | null;
  /** The window y of the top of a screen's docked stack (a conversation's
   *  composer and what rides the keyboard with it): the bar sits above it.
   *  Null with no such screen focused: the bar sits over the tab bar. */
  dockTop: number | null;
};

export const useUndoBar = create<UndoBarState>(() => ({ item: null, heldKillId: null, dockTop: null }));

/** A focused screen with a composer reports its docked stack's top, and null when it blurs. */
export function setUndoBarDock(top: number | null) {
  if (useUndoBar.getState().dockTop !== top) useUndoBar.setState({ dockTop: top });
}

/** How far above its host's bottom the bar sits to clear a docked stack whose
 *  top is at `dockTop`, both in window coordinates: the host's own bottom, not
 *  the window's height, which on Android edge-to-edge includes the navigation
 *  bar below the root. */
export function undoBarLift(hostBottom: number, dockTop: number): number {
  return Math.max(0, hostBottom - dockTop);
}

let shown = 0;
let lives = 0;
let held: { id: string; key: number; timer: ReturnType<typeof setTimeout> } | null = null;

/** A bar whose close advice is still pending, by its key. It stays here when a
 *  later bar takes its place, and leaves when the bar is taken down or its
 *  verdict lands. */
type Advised = {
  advice: PendingCloseAdvice;
  tone: UndoBarItem['tone'];
  /** The gesture's Undo, as the card shows it. */
  onUndo: () => void;
  /** False once the gesture was taken back. */
  alive: () => boolean;
};
const advised = new Map<number, Advised>();
type Card = { item: Omit<UndoBarItem, 'key' | 'life'>; alive: () => boolean };
/** Cards waiting for the screen to be free, the next to show first. */
let queued: Card[] = [];
/** The card on the bar now, by its key, so whatever takes its place puts it back. */
let front: { key: number; card: Card } | null = null;
/** False while the app is not in the foreground: no card shows then. */
let appActive = true;

/** The card on the bar goes back to the front of the queue. */
function shelveFront() {
  if (front && useUndoBar.getState().item?.key === front.key) queued.unshift(front.card);
  front = null;
}

function show(item: Omit<UndoBarItem, 'key' | 'life'>): number {
  shelveFront();
  // Whatever the bar was holding runs before something else takes its place.
  killHeld();
  shown += 1;
  useUndoBar.setState({ item: { ...item, key: shown, life: 0 } });
  return shown;
}

function showCard(card: Card) {
  front = { key: show(card.item), card };
}

/** Change the bar showing `key` in place, its countdown restarting at
 *  `durationMs` (a held kill runs then). False when the bar is gone. */
function relive(key: number, patch: Partial<Omit<UndoBarItem, 'key' | 'life'>> & { durationMs: number }): boolean {
  const item = useUndoBar.getState().item;
  if (item?.key !== key) return false;
  lives += 1;
  useUndoBar.setState({ item: { ...item, ...patch, life: lives } });
  if (held?.key === key) {
    clearTimeout(held.timer);
    held.timer = runKillAfter(key, patch.durationMs);
  }
  return true;
}

/** A plain notice on the bar, with nothing to undo ("Copied", "Bookmarked"). */
export function showNotice(title: string) {
  show({ title, durationMs: NOTICE_MS, tone: 'quiet' });
}

/** The bar showing `key` starts to leave on its own (its life ran out, a
 *  swipe): a card on it is finished, so a bar that takes its place during the
 *  exit does not put it back in the queue. */
export function leaveUndoBar(key: number) {
  if (front?.key === key) front = null;
}

/** Take the bar down if it still shows `key` (the bar's own timer and swipe). */
export function dismissUndoBar(key: number) {
  advised.delete(key);
  if (held?.key === key) killHeld();
  if (useUndoBar.getState().item?.key === key) useUndoBar.setState({ item: null });
  showQueuedCard();
}

function endHold(keepBar = false): string | null {
  if (!held) return null;
  const { id, key, timer } = held;
  held = null;
  clearTimeout(timer);
  useUndoBar.setState((s) => ({ heldKillId: null, item: !keepBar && s.item?.key === key ? null : s.item }));
  return id;
}

/** End the hold of the bar `key`, if that kill is still the one held. */
function endHoldOf(key: number): boolean {
  if (held?.key !== key) return false;
  endHold();
  showQueuedCard();
  return true;
}

function killHeld(keepBar = false) {
  const id = endHold(keepBar);
  // The hold was the undo window; the kill itself records nothing, so no
  // second bar follows it.
  if (id) withoutUndo(() => useInboxStore.getState().killSession(id));
}

/** The held kill of bar `key` runs once its window ends, `ms` from now. Its
 *  life ran out, so a card on it is finished, but the bar itself stays: its
 *  own drain takes it down (components/UndoBar leave), exit animation and
 *  all. */
function runKillAfter(key: number, ms: number) {
  return setTimeout(() => {
    leaveUndoBar(key);
    killHeld(true);
  }, ms);
}

/** The app came to or left the foreground (UndoBarHost's AppState listener).
 *  Leaving takes a card off the screen into the front of the queue and runs a
 *  held kill, so it is never stranded in a suspended timer; coming back shows
 *  the next waiting card with its whole life. */
export function setAppActive(active: boolean) {
  appActive = active;
  if (!active) {
    const item = useUndoBar.getState().item;
    if (item && front?.key === item.key) {
      shelveFront();
      useUndoBar.setState({ item: null });
    }
    killHeld();
  }
  showQueuedCard();
}

/** Kill `id` once the bar drains, unless Undo is pressed first. */
export function holdKill(id: string) {
  let key = 0;
  let undone = false;
  // While the kill is held, Undo only drops it and Open drops it and opens
  // the session. A later bar runs it early; a card for it then brings the
  // session back instead.
  const onUndo = () => {
    undone = true;
    if (!endHoldOf(key)) withoutUndo(() => useInboxStore.getState().restoreSession(id));
  };
  const advice = startCloseAdvice([id], 'Killed', {
    receiptMs: UNDO_BAR_MS,
    keep: (ids, open) => {
      if (endHoldOf(key)) openAtLastMessage(id);
      else keepAsked(ids, open);
    },
  });
  const title = `Killing ${sessionTitle(useInboxStore.getState(), id)}`;
  const durationMs = advice ? UNDO_BAR_MS + CLOSE_ADVICE_HOLD_MS : UNDO_BAR_MS;
  key = show({ title, durationMs, tone: 'kill', onUndo });
  held = { id, key, timer: runKillAfter(key, durationMs) };
  useUndoBar.setState({ heldKillId: id });
  if (advice) awaitCloseAdvice(key, { advice, tone: 'kill', onUndo, alive: () => !undone });
}

/** A gesture's bar with Undo, which takes back the history entry `entryId`. */
export function showUndo(label: string, entryId: string) {
  // A Close or Kill hands its pending close advice to the bar it raises.
  const advice = claimCloseAdvice();
  const [title, note] = splitLabelNote(label);
  const onUndo = () => { undoEntry(entryId); };
  const key = show({
    title, note, tone: 'quiet', onUndo,
    durationMs: advice ? UNDO_BAR_MS + CLOSE_ADVICE_HOLD_MS : UNDO_BAR_MS,
  });
  if (advice) awaitCloseAdvice(key, { advice, tone: 'quiet', onUndo, alive: () => getUndoHistory().undoOrder.includes(entryId) });
}

// ── Close advice ──

type OpenSession = (id: string, messageId?: string) => void;
let openSession: OpenSession | null = null;
/** The bar's host binds how a session opens (its native screen). */
export function bindUndoBarOpen(open: OpenSession | null) {
  openSession = open;
}

const focusedOpeners: OpenSession[] = [];
/** A focused conversation opens a session its own way (a swap in place that
 *  closes its slide-out), so Open never stacks a second session screen over
 *  it. Over the host's; the latest wins; the returned function takes it back. */
export function bindFocusedUndoBarOpen(open: OpenSession): () => void {
  focusedOpeners.push(open);
  return () => {
    const i = focusedOpeners.lastIndexOf(open);
    if (i >= 0) focusedOpeners.splice(i, 1);
  };
}

function openAtLastMessage(id: string) {
  (focusedOpeners.at(-1) ?? openSession)?.(id, lastMessageId(id));
}

/** Close advice's second answer for a Close or a Kill that ran: bring back
 *  only `ids`, and for Open, open it at its last message. */
function keepAsked(ids: string[], open: boolean) {
  restoreAsked(ids, !open);
  if (open) openAtLastMessage(ids[0]!);
}

/** Close `id` (the swipe, the menu), asking close advice beside it. */
export function closeWithAdvice(id: string) {
  const advice = startCloseAdvice([id], 'Closed', { receiptMs: UNDO_BAR_MS, keep: keepAsked });
  withCloseAdvice(advice, () => useInboxStore.getState().closeSession(id));
}

function awaitCloseAdvice(key: number, entry: Advised) {
  const shownAt = Date.now();
  advised.set(key, entry);
  const { advice } = entry;
  void advice.verdict.then((results) => {
    // The bar was taken down (undone, swiped, timed out): nowhere to land.
    if (!advised.delete(key)) return;
    const card = closeAdviceCard(advice, results);
    const answers: Card | null = card && {
      item: {
        title: card.title,
        note: card.triggers,
        ask: card.ask,
        action: { label: card.action.label, onPress: () => advice.keep(card.action.sessions, card.action.open) },
        durationMs: CLOSE_ADVICE_CARD_MS,
        tone: entry.tone,
        onUndo: entry.onUndo,
      },
      alive: entry.alive,
    };
    if (useUndoBar.getState().item?.key !== key) {
      // A later bar took its place: a card for this gesture still shows.
      if (answers && entry.alive()) offerCard(answers);
      return;
    }
    if (answers) {
      if (appActive) {
        relive(key, answers.item);
        front = { key, card: answers };
      } else {
        // Out of sight: the card waits, first, for the app to come back.
        dismissUndoBar(key);
        queued.unshift(answers);
      }
      return;
    }
    // Nothing asked: back to the bar's own life, or down if that has passed.
    const left = UNDO_BAR_MS - (Date.now() - shownAt);
    if (left > 0) relive(key, { durationMs: left });
    else dismissUndoBar(key);
  });
}

/** An earlier gesture's card replaces a notice; a bar with its own Undo or
 *  card it waits behind, so that gesture keeps its whole undo window. */
function offerCard(card: Card) {
  const item = useUndoBar.getState().item;
  if (!appActive || (item && (item.onUndo || item.ask))) queued.push(card);
  else showCard(card);
}

/** The screen is free: the next waiting card whose gesture still stands
 *  shows, its life starting now. */
function showQueuedCard() {
  while (appActive && !useUndoBar.getState().item && queued.length > 0) {
    const next = queued.shift()!;
    if (next.alive()) showCard(next);
  }
}

setUndoNotifier({
  notify: showNotice,
  notifyWithUndo: showUndo,
});

// An account boundary: the history is gone, and a kill held for the account
// that just left is dropped rather than run against the next one.
onUndoReset(() => {
  advised.clear();
  queued = [];
  front = null;
  endHold();
  useUndoBar.setState({ item: null });
});
