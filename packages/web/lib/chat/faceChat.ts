import { useCallback, useSyncExternalStore } from "react";

// CHAT FROM THE FACE.
//
// An arriving chat line from a teammate does not land as a card over the work.
// It drops from that person's face in the header for a few seconds, then folds
// back into the face and leaves a red count there; a click on the count opens
// what they have been saying, with a reply box. useChatToasts still decides
// WHETHER a line interrupts (chatToastTier); this module decides how a line
// that does interrupt is shown, and holds the choreography so the header layer
// (components/faces/FaceChatLayer) only draws it.
//
// The state is per window and ephemeral: what this window has shown you and
// you have not opened yet. The messages themselves live in the store
// (chatMessages); `recent` only keeps the previews the rail carried for lines
// whose channel was never loaded, so the panel can still show them.
//
// One bubble at a time. A second person speaking while a bubble is up waits
// for the first to have had a fair look (MIN_SHOW_MS); a burst shows one
// bubble (an addressed line wins it) and badges everyone else.

export type FaceArrival = {
  messageId: string;
  channelId: string;
  channelName: string;
  isDm: boolean;
  threadRootId?: string;
  /** A reply in a thread, even when the thread's root is not known here. */
  inThread?: boolean;
  /** A reply also sent to the channel, so the channel timeline shows it. */
  broadcast?: boolean;
  preview: string;
  at: number;
  /** Addressed to the viewer (chatToastTier "loud"): it stays longer. */
  loud: boolean;
  /** How many lines this arrival stands for (the rail can collapse several). */
  count: number;
};

export type FaceBubble = {
  key: number;
  authorId: string;
  items: FaceArrival[];
  /** wait: placed but not yet shown (the face may still be arriving on the row). */
  phase: "wait" | "in" | "out";
  /** The current dwell, for the drain line; restarts whenever the timer does. */
  dwellMs: number;
  armedAt: number;
  held: boolean;
};

export type FaceChatState = {
  unseen: Readonly<Record<string, readonly FaceArrival[]>>;
  recent: Readonly<Record<string, readonly FaceArrival[]>>;
  bubble: FaceBubble | null;
  /** Whose card is open with their messages; `focus` when it was opened to read (count, bubble), not by a hover. */
  panel: { authorId: string; unreadIds: readonly string[]; focus: boolean } | null;
};

export type FaceChatLayer = {
  /** The header can show this person a bubble: it is on screen and they are a teammate. */
  canShow: (authorId: string) => boolean;
};

const MIN_SHOW_MS = 1600;
const RETRACT_MS = 320;
const MAX_LINES = 3;
const RECENT_PER_AUTHOR = 30;

let state: FaceChatState = { unseen: {}, recent: {}, bubble: null, panel: null };
const listeners = new Set<() => void>();
let layer: FaceChatLayer | null = null;
let queue: FaceArrival[] = [];
let queueAuthors: string[] = [];
const fallbacks = new Map<string, () => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let bubbleSeq = 0;

/** A view whose newest line the reader has had on screen, and how far that
 *  view reached. Lines at or before `through` stay read after they leave the
 *  screen; a later line in the same view still badges. */
type ReadCursor = { channelId: string; threadRootId?: string; through: number };
let cursors: ReadCursor[] = [];
/** Lines committed to becoming a count but not in `unseen` yet: a bubble
 *  folding, a burst waiting its turn. A read has to see them, or the timeout
 *  badges a line the reader already saw. */
let held: { items: FaceArrival[] }[] = [];
let epoch = 0;

function set(next: Partial<FaceChatState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** A thread reply lives in the thread. A root, and a reply also sent to the
 *  channel, live on the channel timeline. */
function threadOnly(a: FaceArrival): boolean {
  return !!a.inThread && !a.broadcast;
}

function matchesView(a: FaceArrival, channelId: string, threadRootId?: string): boolean {
  if (a.channelId !== channelId) return false;
  if (threadRootId) return threadOnly(a) && a.threadRootId === threadRootId;
  return !threadOnly(a);
}

function coveredByRead(a: FaceArrival): boolean {
  for (const c of cursors) {
    if (matchesView(a, c.channelId, c.threadRootId) && a.at <= c.through) return true;
  }
  return false;
}

/** Read is the newest line actually on screen, recorded by noteFaceContextRead.
 *  A channel merely being the open route is not that: the reader may be in its
 *  history, and a line still on its way into the count must keep its badge. */
function suppressed(a: FaceArrival): boolean {
  return coveredByRead(a);
}

/** Hand lines to the count later, and remember them until then so a read in
 *  between can retire them. */
function deferUnseen(authorId: string, items: readonly FaceArrival[], delay: number) {
  const box = { items: items.filter((a) => !suppressed(a)) };
  if (!box.items.length) return;
  held.push(box);
  const epochAt = epoch;
  setTimeout(() => {
    const i = held.indexOf(box);
    if (i >= 0) held.splice(i, 1);
    if (epochAt !== epoch) return;
    const live = box.items.filter((a) => !suppressed(a));
    if (live.length) addUnseen(authorId, live);
  }, delay);
}

function sweepRead() {
  let unseenChanged = false;
  const nextUnseen: Record<string, readonly FaceArrival[]> = {};
  for (const id in state.unseen) {
    const list = state.unseen[id];
    const keep = list.filter((a) => !suppressed(a));
    if (keep.length !== list.length) unseenChanged = true;
    if (keep.length) nextUnseen[id] = keep.length === list.length ? list : keep;
  }
  if (queue.some(suppressed)) {
    const nextQ: FaceArrival[] = [];
    const nextA: string[] = [];
    queue.forEach((a, i) => {
      if (suppressed(a)) return;
      nextQ.push(a);
      nextA.push(queueAuthors[i]);
    });
    queue = nextQ;
    queueAuthors = nextA;
  }
  for (const box of held) box.items = box.items.filter((a) => !suppressed(a));

  const b = state.bubble;
  let bubble = b;
  let bubbleChanged = false;
  if (b) {
    const keep = b.items.filter((a) => !suppressed(a));
    if (keep.length !== b.items.length) {
      bubbleChanged = true;
      if (!keep.length) {
        clearTimer();
        bubble = null;
      } else bubble = { ...b, items: keep };
    }
  }
  if (!unseenChanged && !bubbleChanged) return;
  set({
    ...(unseenChanged ? { unseen: nextUnseen } : {}),
    ...(bubbleChanged ? { bubble } : {}),
  });
}

/** The newest line of this view is on screen. The header count drops the
 *  lines that view shows, including one still on its way into the count. A
 *  thread covers its replies. The channel timeline covers everything else. */
export function noteFaceContextRead(channelId: string, threadRootId?: string): void {
  let through = Date.now();
  const bump = (a: FaceArrival) => {
    if (matchesView(a, channelId, threadRootId) && a.at > through) through = a.at;
  };
  for (const id in state.unseen) for (const a of state.unseen[id]) bump(a);
  for (const a of state.bubble?.items ?? []) bump(a);
  for (const a of queue) bump(a);
  for (const box of held) for (const a of box.items) bump(a);
  const key = threadRootId ?? "";
  const prev = cursors.find((c) => c.channelId === channelId && (c.threadRootId ?? "") === key);
  if (prev) prev.through = Math.max(prev.through, through);
  else cursors.push({ channelId, threadRootId, through });
  sweepRead();
}

export function getFaceChat(): FaceChatState {
  return state;
}

export function registerFaceChatLayer(l: FaceChatLayer): () => void {
  layer = l;
  return () => {
    if (layer !== l) return;
    layer = null;
    clearTimer();
    queue = [];
    queueAuthors = [];
    set({ bubble: null, panel: null });
  };
}

function remember(authorId: string, a: FaceArrival) {
  const list = (state.recent[authorId] ?? []).filter((x) => x.messageId !== a.messageId);
  set({ recent: { ...state.recent, [authorId]: [...list, a].slice(-RECENT_PER_AUTHOR) } });
}

function addUnseen(authorId: string, items: readonly FaceArrival[]) {
  const incoming = items.filter((a) => !suppressed(a));
  if (!incoming.length) return;
  for (const a of incoming) fallbacks.delete(a.messageId);
  const have = state.unseen[authorId] ?? [];
  const fresh = incoming.filter((a) => !have.some((x) => x.messageId === a.messageId));
  set({ unseen: { ...state.unseen, [authorId]: [...have, ...fresh] } });
}

/**
 * Hand an arriving line to its author's face. False when the header cannot
 * show it (no header, the author is not a face there): the caller toasts.
 * `fallback` runs if the face never turns up on screen to take the line.
 */
export function deliverChatToFace(authorId: string, a: FaceArrival, fallback: () => void): boolean {
  if (!layer?.canShow(authorId)) return false;
  remember(authorId, a);
  // Already read in the view that shows it: no bubble and no count. The
  // caller treats true as handled, so it does not also toast.
  if (suppressed(a)) return true;
  fallbacks.set(a.messageId, fallback);
  const { bubble, panel } = state;
  if (panel?.authorId === authorId) {
    fallbacks.delete(a.messageId);
    if (!panel.unreadIds.includes(a.messageId)) set({ panel: { ...panel, unreadIds: [...panel.unreadIds, a.messageId] } });
    return true;
  }
  if (panel) {
    addUnseen(authorId, [a]);
    return true;
  }
  if (bubble && bubble.authorId === authorId && bubble.phase !== "out") {
    set({ bubble: { ...bubble, items: [...bubble.items, a].slice(-MAX_LINES) } });
    if (bubble.phase === "in") (queue.length ? hurry() : arm());
    return true;
  }
  if (bubble) {
    queue.push(a);
    queueAuthors.push(authorId);
    set({});
    hurry();
    return true;
  }
  openBubble(authorId, [a]);
  return true;
}

function openBubble(authorId: string, items: FaceArrival[]) {
  const live = items.filter((a) => !suppressed(a));
  if (!live.length) return;
  clearTimer();
  set({ bubble: { key: ++bubbleSeq, authorId, items: live.slice(-MAX_LINES), phase: "wait", dwellMs: 0, armedAt: 0, held: false } });
}

/** The layer found the face and placed the bubble under it: start the clock. */
export function faceBubbleShown(key: number) {
  const b = state.bubble;
  if (!b || b.key !== key || b.phase !== "wait") return;
  set({ bubble: { ...b, phase: "in" } });
  queue.length ? hurry() : arm();
}

/** The face never appeared (the header is hidden, the row overflowed): the
 *  lines go out the old way, as toasts. */
export function faceBubbleFailed(key: number) {
  const b = state.bubble;
  if (!b || b.key !== key) return;
  for (const a of b.items) {
    fallbacks.get(a.messageId)?.();
    fallbacks.delete(a.messageId);
  }
  set({ bubble: null });
  next();
}

function dwellOf(b: FaceBubble): number {
  const last = b.items[b.items.length - 1];
  return 3200 + Math.min((last?.preview.length ?? 0) * 40, 2800) + (b.items.some((a) => a.loud) ? 2400 : 0);
}

function arm(ms?: number) {
  const b = state.bubble;
  if (!b || b.phase !== "in" || b.held) return;
  const dwell = ms ?? dwellOf(b);
  clearTimer();
  timer = setTimeout(advance, dwell);
  set({ bubble: { ...b, dwellMs: dwell, armedAt: Date.now() } });
}

/** Someone else is waiting: the current bubble gets its fair minimum, then goes. */
function hurry(min = MIN_SHOW_MS) {
  const b = state.bubble;
  if (!b || b.phase !== "in" || b.held) return;
  const shown = b.armedAt ? Date.now() - b.armedAt : 0;
  arm(Math.max(350, Math.min(min - shown, b.dwellMs ? b.dwellMs - shown : Infinity)));
}

/** The pointer is on the bubble: it stays. */
export function holdFaceBubble() {
  const b = state.bubble;
  if (!b || b.phase !== "in") return;
  clearTimer();
  set({ bubble: { ...b, held: true } });
}
export function releaseFaceBubble() {
  const b = state.bubble;
  if (!b || !b.held) return;
  set({ bubble: { ...b, held: false } });
  queue.length ? arm(600) : arm(1400);
}

/** Fold the bubble back into its face, and leave the count. */
export function retractFaceBubble() {
  const b = state.bubble;
  if (!b || b.phase === "out") return;
  clearTimer();
  if (b.phase === "wait") return faceBubbleFailed(b.key);
  set({ bubble: { ...b, phase: "out" } });
  deferUnseen(b.authorId, b.items, RETRACT_MS * 0.6);
  setTimeout(() => {
    if (state.bubble?.key === b.key) set({ bubble: null });
  }, RETRACT_MS);
}

function advance() {
  retractFaceBubble();
  next(RETRACT_MS);
}

/** The next bubble after a burst: an addressed line wins it, everyone else is badged. */
function next(delay = 0) {
  if (!queue.length) return;
  const items = queue;
  const authors = queueAuthors;
  queue = [];
  queueAuthors = [];
  let lead = authors.length - 1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].loud) { lead = i; break; }
  const leadAuthor = authors[lead];
  const others = new Map<string, FaceArrival[]>();
  items.forEach((a, i) => {
    if (authors[i] === leadAuthor) return;
    others.set(authors[i], [...(others.get(authors[i]) ?? []), a]);
  });
  [...others].forEach(([id, list], i) => deferUnseen(id, list, delay + 150 * i));
  const mine = items.filter((_, i) => authors[i] === leadAuthor);
  const box = { items: mine.filter((a) => !suppressed(a)) };
  if (box.items.length) held.push(box);
  const epochAt = epoch;
  setTimeout(() => {
    if (epochAt !== epoch) return;
    const i = held.indexOf(box);
    if (i >= 0) held.splice(i, 1);
    const live = box.items.filter((a) => !suppressed(a));
    if (!live.length) return;
    if (state.panel) return addUnseen(leadAuthor, live);
    if (!state.bubble) return openBubble(leadAuthor, live);
    queue.push(...live);
    queueAuthors.push(...live.map(() => leadAuthor));
    set({});
  }, delay);
}

/** Open this person's card with what they have been saying. Clears their count. */
export function openFacePanel(authorId: string, focus = true) {
  const b = state.bubble;
  if (b) {
    if (b.authorId === authorId) {
      clearTimer();
      set({ bubble: null });
      for (const a of b.items) fallbacks.delete(a.messageId);
    } else retractFaceBubble();
  }
  const pending = queue;
  const pendingAuthors = queueAuthors;
  queue = [];
  queueAuthors = [];
  const others = new Map<string, FaceArrival[]>();
  pending.forEach((a, i) => {
    const id = pendingAuthors[i];
    if (id !== authorId) others.set(id, [...(others.get(id) ?? []), a]);
  });
  [...others].forEach(([id, list], i) => deferUnseen(id, list, 200 + 150 * i));
  const unreadIds = [...(state.unseen[authorId] ?? []), ...(b?.authorId === authorId ? b.items : [])].map((a) => a.messageId);
  const { [authorId]: _, ...rest } = state.unseen;
  set({ unseen: rest, panel: { authorId, unreadIds, focus } });
}

/** The viewer looked at this person: their count goes, nothing opens. */
export function clearFaceUnseen(authorId: string) {
  if (!state.unseen[authorId]) return;
  const { [authorId]: _, ...rest } = state.unseen;
  set({ unseen: rest });
}

export function closeFacePanel() {
  if (state.panel) set({ panel: null });
}

/** Whose card the header should hold open with their messages (null: none). */
export function useFaceChatPanelId(): string | null {
  const read = useCallback(() => state.panel?.authorId ?? null, []);
  return useSyncExternalStore(subscribe, read, read);
}

/** The card was opened to read this person: its reply box takes the keys. */
export function useFaceChatFocus(authorId: string): boolean {
  const read = useCallback(() => state.panel?.authorId === authorId && state.panel.focus, [authorId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The lines that were new when this person's card opened, for its dots. */
export function useFaceChatUnreadIds(authorId: string): readonly string[] {
  const read = useCallback(() => (state.panel?.authorId === authorId ? state.panel.unreadIds : NONE), [authorId]);
  return useSyncExternalStore(subscribe, read, read);
}
const NONE: readonly string[] = [];

/** The previews this window was handed for a person, for lines never loaded. */
export function useFaceChatRecent(authorId: string): readonly FaceArrival[] {
  const read = useCallback(() => state.recent[authorId] ?? NO_ARRIVALS, [authorId]);
  return useSyncExternalStore(subscribe, read, read);
}
const NO_ARRIVALS: readonly FaceArrival[] = [];

export function useFaceChat(): FaceChatState {
  return useSyncExternalStore(subscribe, getFaceChat, getFaceChat);
}

/** A face's count, as one primitive so the seat renders only when it moves:
 *  lines this window showed and the viewer has not opened or read in the
 *  channel, plus DM unread the server knows about beyond those. */
export function useFaceChatBadge(authorId: string, dmUnread: number): number {
  const read = useCallback(() => {
    const list = state.unseen[authorId] ?? [];
    let n = 0;
    let dm = 0;
    for (const a of list) {
      n += a.count;
      if (a.isDm) dm += a.count;
    }
    return n + Math.max(0, dmUnread - dm);
  }, [authorId, dmUnread]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Whose faces the header must keep on screen: anyone mid-bubble, open, or holding a count. */
export function useFaceChatActive(): string {
  const read = useCallback(() => {
    const ids = new Set(Object.keys(state.unseen).filter((id) => state.unseen[id].length));
    if (state.bubble) ids.add(state.bubble.authorId);
    for (const id of queueAuthors) ids.add(id);
    if (state.panel) ids.add(state.panel.authorId);
    return [...ids].sort().join(",");
  }, []);
  return useSyncExternalStore(subscribe, read, read);
}

/** Tests only. */
export function __resetFaceChat() {
  clearTimer();
  epoch++;
  queue = [];
  queueAuthors = [];
  cursors = [];
  held = [];
  fallbacks.clear();
  layer = null;
  state = { unseen: {}, recent: {}, bubble: null, panel: null };
}
