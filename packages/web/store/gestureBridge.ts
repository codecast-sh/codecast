// Cross-window gesture bridge.
//
// The desktop app runs several SAME-ORIGIN windows (main, compose palette, …)
// against ONE IndexedDB principal store, and each window persists rows with
// per-row WHOLE-ROW puts diffed against its own in-memory shadow
// (idbCache.ts → writePatchesToIDB → diffCollection). That makes stale memory
// destructive, not merely stale: a window that never learned about a gesture
// made in a sibling window still holds the pre-gesture row, and the next time
// anything about that row changes it writes the whole row back — clobbering
// the sibling's write in shared IDB. That is the mechanism behind killed
// sessions resurrecting and pinned stubs becoming immortal.
//
// The fix is to converge SIBLING MEMORY at gesture time: the acting window
// broadcasts what the user did, and every other window applies the same field
// edits locally (store.applyGestureBridge, a sync() action — local only, no
// dispatch, no outbox). Their later whole-row puts then carry the gesture
// instead of undoing it.
//
// Why an event and not a merge-on-write in the persistence layer: the hidden
// fields are nullable, and `null` is ambiguous on disk — it means both "this
// window never knew" and "the user just restored this". Only an event carries
// the intent, so only an event can be merged correctly.
//
// Delivery is best-effort by construction. A missed broadcast (window closed,
// no BroadcastChannel) degrades to today's behaviour — the server round-trip
// and the dismiss/stash reconcile crawls remain the durable path; the bridge
// only closes the window between the gesture and that reconcile.

// The row fields the bridge carries. Every one of them is written by a user
// gesture and read by the inbox's bucket/sort logic, and every one is
// nullable — which is what makes a stale sibling's whole-row put destructive.
export const BRIDGED_FIELDS = [
  "inbox_dismissed_at",
  "inbox_stashed_at",
  "inbox_stash_hidden",
  "inbox_pinned_at",
  "is_pinned",
] as const;
export type BridgedField = (typeof BRIDGED_FIELDS)[number];

/** One user gesture, as seen by the window that performed it. */
export type GestureMessage =
  // `ids` is the SENDER's already-resolved cascade set (the session plus its
  // nested children), not a parent id the receiver would have to re-derive:
  // the two windows can disagree about which children exist, and the visual
  // group the user took down is the sender's.
  //
  // One cascade can both flag and delete rows — a stub or an injected teammate
  // row can't be hidden durably, so hiding it means deleting it. `forget`
  // carries that half INLINE rather than as a second broadcast, so one user
  // gesture is exactly one message (a receiver that saw only half of a split
  // pair would converge to a state the user never asked for).
  // `hidden` = "Stash and hide" (stash mode only): the receiver writes the
  // same inbox_stash_hidden the sender did, so both windows agree on whether
  // a trigger wake brings the row back.
  | { kind: "hide"; mode: "kill" | "stash"; hidden?: boolean; ids: string[]; forget?: string[]; ts: number }
  | { kind: "restore"; ids: string[]; ts: number }
  // `pinnedAt` is the EXACT value the sender wrote, carried separately from
  // `ts` (the ordering stamp) because undo restores the ORIGINAL pin time, not
  // the time of the undo. The receiver plants a pending field lock holding this
  // value, and that lock only retires when the server echo matches it — so a
  // receiver that re-derived the timestamp would pin a value the server will
  // never send and the lock would stick forever.
  | { kind: "pin"; id: string; pinned: boolean; pinnedAt: number | null; ts: number }
  // A verbatim write of the bridged fields, for the generic `patchConversation`
  // path: the /sessions surface drives its own pin and stash/restore toggles
  // through it, writing whichever subset of these four fields it wants. Copying
  // the exact field/value pairs is the only shape that mirrors it without
  // guessing, and it keeps the receiver's planted locks equal to the values the
  // sender dispatched.
  | { kind: "fields"; id: string; fields: Partial<Record<BridgedField, number | boolean | null>>; ts: number }
  // Rows the sender DELETED outright rather than flagged: local-only stubs,
  // injected teammate rows, and server-verified ghosts. A sibling holding one
  // in memory would re-put it, so it has to drop it too.
  //
  // `scope` mirrors HOW MUCH the sender dropped, because the receiver plants
  // the excludes that make its delete durable and an over-broad exclude is
  // itself a bug. "all" (the default) is a whole-entity forget. "session-row"
  // drops only the inbox row: markKilling removes the card for a session the
  // server still has (killed, marked completed), so a receiver that also
  // dropped conversations[id] would blind itself to a live conversation.
  | { kind: "forget"; ids: string[]; scope?: "session-row" | "all"; ts: number };

type Envelope = GestureMessage & {
  v: 1;
  /** Per-window random token, so a window ignores its own broadcast. */
  source: string;
  /** The acting user. A receiver on another account drops the message. */
  userId: string | null;
};

export type ChannelFactory = (name: string) => BroadcastChannel | null;

const PROTOCOL_VERSION = 1;

// Same-origin is already enforced by BroadcastChannel; the remaining way two
// windows can differ is the signed-in account, so the channel name carries it.
// The payload repeats the user id and the receiver re-checks it — the name
// alone would be trusted state, and an account switch races the rebind.
function channelName(userId: string | null): string {
  return `codecast-gesture:${userId ?? "anon"}`;
}

const defaultChannelFactory: ChannelFactory = (name) => {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(name);
  } catch {
    return null;
  }
};

let channelFactory: ChannelFactory = defaultChannelFactory;

/** Test seam — swap the BroadcastChannel constructor. Pass null to restore. */
export function setGestureChannelFactory(factory: ChannelFactory | null): void {
  channelFactory = factory ?? defaultChannelFactory;
}

let sourceToken: string | null = null;

/** This window's identity on the bridge. Stable for the window's lifetime. */
export function gestureSourceToken(): string {
  if (sourceToken) return sourceToken;
  sourceToken =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return sourceToken;
}

/**
 * Announce a gesture to sibling windows. Fire-and-forget: a fresh channel per
 * post (the composeBridge idiom) so there is no long-lived handle to keep in
 * sync with account switches — posted messages are still delivered after the
 * synchronous close().
 */
export function broadcastGesture(msg: GestureMessage, userId: string | null): void {
  const ch = channelFactory(channelName(userId));
  if (!ch) return;
  const envelope: Envelope = { ...msg, v: PROTOCOL_VERSION, source: gestureSourceToken(), userId };
  try {
    ch.postMessage(envelope);
  } catch {
    // A structured-clone or closed-channel failure must never break the
    // gesture itself — the local state change already landed.
  } finally {
    try {
      ch.close();
    } catch {
      /* already closed */
    }
  }
}

function isGestureMessage(data: unknown): data is Envelope {
  if (!data || typeof data !== "object") return false;
  const e = data as Partial<Envelope>;
  if (e.v !== PROTOCOL_VERSION || typeof e.ts !== "number") return false;
  if (e.kind === "pin") {
    return typeof e.id === "string" && typeof e.pinned === "boolean" &&
      (e.pinnedAt === null || typeof e.pinnedAt === "number");
  }
  if (e.kind === "fields") {
    if (typeof e.id !== "string" || !e.fields || typeof e.fields !== "object") return false;
    // Only the four bridged fields may cross — this message writes verbatim, so
    // an unrecognized key would let a malformed post edit arbitrary row state.
    return Object.entries(e.fields).every(([k, v]) =>
      (BRIDGED_FIELDS as readonly string[]).includes(k) &&
      (v === null || typeof v === "number" || typeof v === "boolean"));
  }
  if (e.kind === "hide") {
    if (e.forget !== undefined && !Array.isArray(e.forget)) return false;
    if (e.hidden !== undefined && typeof e.hidden !== "boolean") return false;
    return Array.isArray(e.ids) && (e.mode === "kill" || e.mode === "stash");
  }
  if (e.kind === "forget") {
    if (e.scope !== undefined && e.scope !== "session-row" && e.scope !== "all") return false;
    return Array.isArray(e.ids);
  }
  if (e.kind === "restore") return Array.isArray(e.ids);
  return false;
}

/**
 * Listen for sibling gestures for `userId`. `currentUserId` is read at DELIVERY
 * time (not bind time) so an account switch that races an in-flight message
 * still drops it; the caller separately rebinds the channel when the user
 * changes, which is what keeps the two accounts on different channel names.
 */
export function subscribeGestures(
  userId: string | null,
  currentUserId: () => string | null,
  apply: (msg: GestureMessage) => void,
): () => void {
  const ch = channelFactory(channelName(userId));
  if (!ch) return () => {};
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (!isGestureMessage(data)) return;
    if (data.source === gestureSourceToken()) return; // our own gesture
    if ((data.userId ?? null) !== (currentUserId() ?? null)) return;
    const { v: _v, source: _source, userId: _userId, ...msg } = data;
    apply(msg as GestureMessage);
  };
  ch.addEventListener("message", handler);
  return () => {
    ch.removeEventListener("message", handler);
    try {
      ch.close();
    } catch {
      /* already closed */
    }
  };
}
