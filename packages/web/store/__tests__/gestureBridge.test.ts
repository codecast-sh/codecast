import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";
import {
  broadcastGesture,
  gestureSourceToken,
  setGestureChannelFactory,
  subscribeGestures,
  type GestureMessage,
} from "../gestureBridge";
import { declareViewNav } from "../viewNav";
import { undoableHideSession, undoablePinSession } from "../undoActions";
import { performUndo } from "../undoStack";

// The desktop app's windows share ONE IndexedDB principal store and persist
// rows with whole-row puts diffed against per-window memory, so a window that
// never learned about a sibling's dismiss/kill/pin writes the pre-gesture row
// back over it — killed sessions resurrect, pinned stubs become immortal. The
// bridge converges sibling MEMORY so their later puts carry the gesture.

const REAL_A = "a".repeat(32);
const REAL_B = "b".repeat(32);
const STUB = "stub-local-1";

// Seeds that place the user ON a conversation must declare a view-nav source —
// undeclared non-null view writes are reverted by the guard (viewNav.ts).
function seed(partial: Record<string, unknown>) {
  declareViewNav("gesture");
  useInboxStore.setState({
    sessions: {},
    conversations: {},
    messages: {},
    pendingMessages: {},
    pagination: {},
    pendingSessionCreates: {},
    pending: {},
    currentSessionId: null,
    viewingDismissedId: null,
    currentUser: null,
    clientState: {},
    ...partial,
  } as any);
}

function session(id: string, extra: Partial<InboxSession> = {}): InboxSession {
  return {
    _id: id,
    session_id: `sess-${id}`,
    updated_at: Date.now(),
    agent_type: "claude_code",
    message_count: 1,
    is_idle: true,
    has_pending: false,
    ...extra,
  } as InboxSession;
}

// ---------------------------------------------------------------------------
// A fake BroadcastChannel hub: channels with the same name see each other's
// posts, exactly like the real one (and, like the real one, a sender never
// receives its own post — self-filtering is the source token's job across
// WINDOWS, which share no channel object).
// ---------------------------------------------------------------------------
type Posted = { name: string; data: any };

function makeHub() {
  const posted: Posted[] = [];
  const listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  const factory = (name: string) => {
    const own = new Set<(e: MessageEvent) => void>();
    const chan = {
      postMessage(data: any) {
        posted.push({ name, data: structuredClone(data) });
        for (const [n, set] of listeners) {
          if (n !== name) continue;
          for (const fn of set) {
            if (own.has(fn)) continue;
            fn({ data: structuredClone(data) } as MessageEvent);
          }
        }
      },
      addEventListener(_type: string, fn: (e: MessageEvent) => void) {
        own.add(fn);
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(fn);
      },
      removeEventListener(_type: string, fn: (e: MessageEvent) => void) {
        own.delete(fn);
        listeners.get(name)?.delete(fn);
      },
      close() {},
    };
    return chan as unknown as BroadcastChannel;
  };
  return { posted, factory };
}

let hub: ReturnType<typeof makeHub>;

beforeEach(() => {
  hub = makeHub();
  setGestureChannelFactory(hub.factory);
});

afterEach(() => {
  setGestureChannelFactory(null);
  // Middleware-injected bindings aren't declared on InboxStoreState (same
  // reason outboxRetention.test.ts reaches for them off the wrapped store).
  const store = useInboxStore.getState() as any;
  store._setOutbox(null, null, null);
  store._setDispatch(null);
});

describe("gesture bridge senders", () => {
  it("killSession broadcasts exactly one hide with the resolved cascade set", () => {
    const child = REAL_B;
    seed({
      sessions: {
        [REAL_A]: session(REAL_A),
        [child]: session(child, { parent_conversation_id: REAL_A } as any),
      },
      conversations: { [REAL_A]: { _id: REAL_A }, [child]: { _id: child } },
    });

    useInboxStore.getState().killSession(REAL_A);

    expect(hub.posted).toHaveLength(1);
    const msg = hub.posted[0].data;
    expect(msg.kind).toBe("hide");
    expect(msg.mode).toBe("kill");
    expect(new Set(msg.ids)).toEqual(new Set([REAL_A, child]));
    expect(msg.forget).toBeUndefined();
    expect(typeof msg.ts).toBe("number");
    expect(msg.source).toBe(gestureSourceToken());
  });

  it("stashSession broadcasts mode:stash", () => {
    seed({ sessions: { [REAL_A]: session(REAL_A) }, conversations: { [REAL_A]: { _id: REAL_A } } });
    useInboxStore.getState().stashSession(REAL_A);
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data.mode).toBe("stash");
    expect(hub.posted[0].data.hidden).toBeUndefined();
    // A plain stash writes the mode flag explicitly (null), so a re-stash
    // never inherits an earlier "stash and hide".
    expect(useInboxStore.getState().sessions[REAL_A].inbox_stash_hidden).toBeNull();
  });

  it("stash and hide carries hidden:true and stamps the mode on the row", () => {
    seed({ sessions: { [REAL_A]: session(REAL_A) }, conversations: { [REAL_A]: { _id: REAL_A } } });
    useInboxStore.getState().stashSession(REAL_A, { hidden: true });
    expect(hub.posted[0].data.mode).toBe("stash");
    expect(hub.posted[0].data.hidden).toBe(true);
    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_stash_hidden).toBe(true);
    expect((s.conversations[REAL_A] as any).inbox_stash_hidden).toBe(true);
  });

  it("a stub in the cascade rides the SAME message as a forget list", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A), [STUB]: session(STUB, { parent_conversation_id: REAL_A } as any) },
      conversations: { [REAL_A]: { _id: REAL_A }, [STUB]: { _id: STUB } },
    });

    useInboxStore.getState().killSession(REAL_A);

    // One user gesture => one message, even though it both flags and deletes.
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data.ids).toEqual([REAL_A]);
    expect(hub.posted[0].data.forget).toEqual([STUB]);
  });

  it("killSessions (bulk) broadcasts once for the whole gesture", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A), [REAL_B]: session(REAL_B) },
      conversations: { [REAL_A]: { _id: REAL_A }, [REAL_B]: { _id: REAL_B } },
    });
    useInboxStore.getState().killSessions([REAL_A, REAL_B]);
    expect(hub.posted).toHaveLength(1);
    expect(new Set(hub.posted[0].data.ids)).toEqual(new Set([REAL_A, REAL_B]));
  });

  it("killSessions stamps every row with the ONE timestamp its message carries", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A), [REAL_B]: session(REAL_B) },
      conversations: { [REAL_A]: { _id: REAL_A }, [REAL_B]: { _id: REAL_B } },
    });

    // Wall-clock drifts across a big sweep. With a per-row Date.now(), the merged
    // message's timestamp matched only the LAST row, so the receiver planted a
    // lock holding a value the server would never echo for every earlier row —
    // and a lock that never matches an echo never retires.
    const realNow = Date.now;
    let t = 1_800_000_000_000;
    Date.now = () => (t += 1000);
    try {
      useInboxStore.getState().killSessions([REAL_A, REAL_B]);
    } finally {
      Date.now = realNow;
    }

    const s = useInboxStore.getState();
    const ts = hub.posted[0].data.ts;
    expect(s.sessions[REAL_A].inbox_dismissed_at).toBe(ts);
    expect(s.sessions[REAL_B].inbox_dismissed_at).toBe(ts);
    expect((s.conversations[REAL_B] as any).inbox_dismissed_at).toBe(ts);
  });

  it("restoreSession broadcasts restore for the session and its hidden children", () => {
    seed({
      sessions: {
        [REAL_A]: session(REAL_A, { inbox_dismissed_at: 100 } as any),
        [REAL_B]: session(REAL_B, { parent_conversation_id: REAL_A, inbox_dismissed_at: 100 } as any),
      },
      conversations: { [REAL_A]: { _id: REAL_A }, [REAL_B]: { _id: REAL_B } },
    });

    useInboxStore.getState().restoreSession(REAL_A);

    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data.kind).toBe("restore");
    expect(new Set(hub.posted[0].data.ids)).toEqual(new Set([REAL_A, REAL_B]));
  });

  it("pinSession broadcasts the RESOLVED pin value, not the toggle", () => {
    seed({ sessions: { [REAL_A]: session(REAL_A) }, conversations: { [REAL_A]: { _id: REAL_A } } });

    useInboxStore.getState().pinSession(REAL_A);
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data).toMatchObject({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: hub.posted[0].data.ts });

    useInboxStore.getState().pinSession(REAL_A);
    expect(hub.posted).toHaveLength(2);
    expect(hub.posted[1].data).toMatchObject({ kind: "pin", id: REAL_A, pinned: false, pinnedAt: null });
  });

  it("pruneGhostSessions announces only the ids it actually removed", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A), [REAL_B]: session(REAL_B) },
      conversations: { [REAL_A]: { _id: REAL_A }, [REAL_B]: { _id: REAL_B } },
      currentSessionId: REAL_B, // guarded: never pruned
    });

    useInboxStore.getState().pruneGhostSessions([REAL_A, REAL_B]);

    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data).toMatchObject({ kind: "forget", ids: [REAL_A] });
  });

  it("markKilling forgets ONLY the inbox row (the conversation is still live)", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    useInboxStore.getState().markKilling(REAL_A);

    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data).toMatchObject({
      kind: "forget", ids: [REAL_A], scope: "session-row",
    });
    // The sender kept the conversation cached — the message must not tell
    // siblings to drop it.
    expect(useInboxStore.getState().conversations[REAL_A]).toBeDefined();
  });

  it("markSessionsDismissed broadcasts one hide for the whole sweep", () => {
    seed({
      sessions: {
        [REAL_A]: session(REAL_A),
        [REAL_B]: session(REAL_B),
      },
      conversations: { [REAL_A]: { _id: REAL_A }, [REAL_B]: { _id: REAL_B } },
    });

    useInboxStore.getState().markSessionsDismissed([REAL_A, REAL_B]);

    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data).toMatchObject({ kind: "hide", mode: "kill" });
    expect(hub.posted[0].data.ids).toEqual([REAL_A, REAL_B]);
  });

  it("markSessionsDismissed's message excludes already-dismissed ids", () => {
    seed({
      sessions: {
        [REAL_A]: session(REAL_A, { inbox_dismissed_at: 111 } as any),
        [REAL_B]: session(REAL_B),
      },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 111 }, [REAL_B]: { _id: REAL_B } },
    });

    useInboxStore.getState().markSessionsDismissed([REAL_A, REAL_B]);

    // Only REAL_B was actually stamped, so only it is announced — and REAL_A
    // keeps its original stamp rather than being re-dated.
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data.ids).toEqual([REAL_B]);
    expect(useInboxStore.getState().sessions[REAL_A].inbox_dismissed_at).toBe(111);
  });

  it("a sweep that stamps nothing broadcasts nothing", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 111 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 111 } },
    });
    useInboxStore.getState().markSessionsDismissed([REAL_A]);
    expect(hub.posted).toHaveLength(0);
  });

  it("a prune of an id this window doesn't hold does nothing at all", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    // Callers re-fire on ids they already pruned (ConversationView's 3s retry,
    // ComposeView's unmount).
    useInboxStore.getState().pruneGhostSessions([REAL_B]);

    const s = useInboxStore.getState();
    // No broadcast: this window has no evidence to order a sibling's delete on.
    expect(hub.posted).toHaveLength(0);
    // And no excludes — they're STICKY, so planting them for a row we never held
    // blinds this window to that id if it ever arrives on a later crawl.
    expect(s.pending[`sessions:${REAL_B}`]).toBeUndefined();
    expect(s.pending[`conversations:${REAL_B}`]).toBeUndefined();
    expect(s.sessions[REAL_A]).toBeDefined();
  });

  it("patchConversation announces the bridged fields the /sessions toggles write", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    // handleToggleDismiss's stash leg (app/sessions/page.tsx).
    useInboxStore.getState().patchConversation(REAL_A, { inbox_stashed_at: 4242 });

    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data).toMatchObject({
      kind: "fields", id: REAL_A, fields: { inbox_stashed_at: 4242 },
    });
  });

  it("patchConversation stays silent for fields the bridge doesn't carry", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });
    useInboxStore.getState().patchConversation(REAL_A, { title: "renamed", project_path: "/tmp" });
    expect(hub.posted).toHaveLength(0);
  });

  it("undoing a pin broadcasts the reverted value, not silence", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    undoablePinSession(REAL_A);
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data).toMatchObject({ kind: "pin", pinned: true });

    // Undo must retract it: an un-announced undo leaves the sibling holding the
    // pinned row, which both re-puts the undone pin and inverts its next toggle.
    expect(performUndo()).toBe(true);

    expect(hub.posted).toHaveLength(2);
    expect(hub.posted[1].data).toMatchObject({
      kind: "pin", id: REAL_A, pinned: false, pinnedAt: null,
    });
  });

  it("undoing a hide broadcasts the snapshot flags per id, under one timestamp", () => {
    // The child was STASHED when the parent was killed, so its undo is not a
    // blanket un-hide: it has to land back in Stashed. That's why the undo rides
    // a per-id "fields" message carrying the snapshot verbatim, not a "restore".
    seed({
      sessions: {
        [REAL_A]: session(REAL_A),
        [REAL_B]: session(REAL_B, { parent_conversation_id: REAL_A, inbox_stashed_at: 111 } as any),
      },
      conversations: { [REAL_A]: { _id: REAL_A }, [REAL_B]: { _id: REAL_B, inbox_stashed_at: 111 } },
    });

    undoableHideSession(REAL_A, "kill");
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0].data.kind).toBe("hide");

    // An un-announced undo leaves the sibling holding the KILLED row, and its
    // next whole-row put writes the undone kill back into shared IDB.
    expect(performUndo()).toBe(true);

    const undo = hub.posted.slice(1).map((p) => p.data);
    expect(undo).toHaveLength(2);
    // One gesture, one timestamp — the sibling's locks for both rows key off it.
    expect(new Set(undo.map((m) => m.ts)).size).toBe(1);
    const byId = Object.fromEntries(undo.map((m) => [m.id, m]));
    expect(byId[REAL_A]).toMatchObject({
      kind: "fields", fields: { inbox_dismissed_at: null, inbox_stashed_at: null },
    });
    // Verbatim: the values applyUndoPatches dispatches, so the receiver's lock
    // retires on the matching server echo.
    expect(byId[REAL_B]).toMatchObject({
      kind: "fields", fields: { inbox_dismissed_at: null, inbox_stashed_at: 111 },
    });
  });

  it("the channel name is scoped to the acting user", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A, is_own: true } },
      currentUser: { _id: "user-1" },
    });
    useInboxStore.getState().killSession(REAL_A);
    expect(hub.posted[0].name).toBe("codecast-gesture:user-1");
    expect(hub.posted[0].data.userId).toBe("user-1");
  });
});

describe("gesture bridge receiver", () => {
  it("hide sets the field on both the session and conversation rows", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_dismissed_at).toBe(500);
    expect((s.conversations[REAL_A] as any).inbox_dismissed_at).toBe(500);
  });

  it("kill clears an existing stash and pin (the buckets are exclusive)", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_stashed_at: 100, is_pinned: true, inbox_pinned_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_stashed_at: 100, inbox_pinned_at: 100 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_dismissed_at).toBe(500);
    expect(s.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect(s.sessions[REAL_A].is_pinned).toBe(false);
    expect(s.sessions[REAL_A].inbox_pinned_at).toBeNull();
    expect((s.conversations[REAL_A] as any).inbox_pinned_at).toBeNull();
  });

  it("a sibling's stash-and-hide lands with the same mode flag", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "stash", hidden: true, ids: [REAL_A], ts: 500 });
    let s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_stashed_at).toBe(500);
    expect(s.sessions[REAL_A].inbox_stash_hidden).toBe(true);
    // A later plain stash from a sibling rewrites the mode, and a restore
    // clears it with the stamp.
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "stash", ids: [REAL_A], ts: 600 });
    s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_stash_hidden).toBeNull();
    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 700 });
    s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect(s.sessions[REAL_A].inbox_stash_hidden).toBeNull();
  });

  it("restore clears both hide flags", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 100, inbox_stashed_at: 90 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 100, inbox_stashed_at: 90 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 500 });

    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_dismissed_at).toBeNull();
    expect(s.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect((s.conversations[REAL_A] as any).inbox_dismissed_at).toBeNull();
  });

  it("pin sets both twins; unpin clears them", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: 500, ts: 500 });
    let s = useInboxStore.getState();
    expect(s.sessions[REAL_A].is_pinned).toBe(true);
    expect(s.sessions[REAL_A].inbox_pinned_at).toBe(500);
    expect((s.conversations[REAL_A] as any).inbox_pinned_at).toBe(500);

    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: false, pinnedAt: null, ts: 600 });
    s = useInboxStore.getState();
    expect(s.sessions[REAL_A].is_pinned).toBe(false);
    expect(s.sessions[REAL_A].inbox_pinned_at).toBeNull();
    expect((s.conversations[REAL_A] as any).inbox_pinned_at).toBeNull();
  });

  it("forget removes every trace of the row and plants the excludes", () => {
    seed({
      sessions: { [STUB]: session(STUB) },
      conversations: { [STUB]: { _id: STUB } },
      messages: { [STUB]: [{ _id: "m1" }] },
      pagination: { [STUB]: { cursor: "x" } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "forget", ids: [STUB], ts: 500 });

    const s = useInboxStore.getState();
    expect(s.sessions[STUB]).toBeUndefined();
    expect(s.conversations[STUB]).toBeUndefined();
    expect(s.messages[STUB]).toBeUndefined();
    expect(s.pagination[STUB]).toBeUndefined();
    // The exclude is what authorizes the durable IDB row delete — a bare
    // store-shrink is ignored by the collection diff.
    expect(s.pending[`sessions:${STUB}`]).toMatchObject({ type: "exclude" });
    expect(s.pending[`conversations:${STUB}`]).toMatchObject({ type: "exclude" });
  });

  it("scope:session-row drops the inbox row but spares the cached conversation", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
      messages: { [REAL_A]: [{ _id: "m1" }] },
    });

    useInboxStore.getState().applyGestureBridge({
      kind: "forget", ids: [REAL_A], scope: "session-row", ts: 500,
    });

    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A]).toBeUndefined();
    expect(s.pending[`sessions:${REAL_A}`]).toMatchObject({ type: "exclude" });
    // The conversation still exists server-side (killed, marked completed) —
    // an exclude here would blind this window to it forever.
    expect(s.conversations[REAL_A]).toBeDefined();
    expect(s.messages[REAL_A]).toBeDefined();
    expect(s.pending[`conversations:${REAL_A}`]).toBeUndefined();
  });

  it("a hide carrying a forget list applies both halves", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A), [STUB]: session(STUB) },
      conversations: { [REAL_A]: { _id: REAL_A }, [STUB]: { _id: STUB } },
    });

    useInboxStore.getState().applyGestureBridge({
      kind: "hide", mode: "kill", ids: [REAL_A], forget: [STUB], ts: 500,
    });

    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_dismissed_at).toBe(500);
    expect(s.sessions[STUB]).toBeUndefined();
  });

  it("forget spares the row this window's user is currently reading", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
      currentSessionId: REAL_A,
    });

    useInboxStore.getState().applyGestureBridge({ kind: "forget", ids: [REAL_A], ts: 500 });

    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A]).toBeDefined();
    expect(s.currentSessionId).toBe(REAL_A);
    expect(s.pending[`sessions:${REAL_A}`]).toBeUndefined();
  });

  it("forget spares a row holding unsent user text in THIS window", () => {
    seed({
      sessions: { [STUB]: session(STUB) },
      conversations: { [STUB]: { _id: STUB } },
      pendingMessages: { [STUB]: [{ content: "half-typed thought" }] },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "forget", ids: [STUB], ts: 500 });

    const s = useInboxStore.getState();
    // A queued message means this window knows something the sender did not.
    expect(s.pendingMessages[STUB]).toHaveLength(1);
    expect(s.sessions[STUB]).toBeDefined();
  });

  it("forget spares a session whose create is still in flight here", () => {
    seed({
      sessions: { [STUB]: session(STUB) },
      conversations: { [STUB]: { _id: STUB } },
      pendingSessionCreates: { [STUB]: { ts: 1 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "forget", ids: [STUB], ts: 500 });

    expect(useInboxStore.getState().sessions[STUB]).toBeDefined();
  });

  it("ignores ids this window has never heard of", () => {
    seed({ sessions: {}, conversations: {} });
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });
    expect(useInboxStore.getState().sessions[REAL_A]).toBeUndefined();
  });

  it("never touches the view: a sibling's kill does not move this window", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
      currentSessionId: REAL_A,
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    expect(useInboxStore.getState().currentSessionId).toBe(REAL_A);
  });
});

describe("gesture bridge ordering guards", () => {
  it("an older hide does not regress a newer local hide", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 900 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 900 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    expect(useInboxStore.getState().sessions[REAL_A].inbox_dismissed_at).toBe(900);
  });

  it("an older restore does not un-hide a newer local kill", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 900 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 900 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 500 });

    expect(useInboxStore.getState().sessions[REAL_A].inbox_dismissed_at).toBe(900);
  });

  it("a delayed older hide cannot overwrite a newer restore lock", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 100 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 900 });
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    expect(useInboxStore.getState().sessions[REAL_A].inbox_dismissed_at).toBeNull();
    expect(useInboxStore.getState().conversations[REAL_A].inbox_dismissed_at).toBeNull();
  });

  it("a no-op restore plants twin tombstones that reject a delayed kill", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: null, inbox_stashed_at: null } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: null, inbox_stashed_at: null } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 900 });
    const locks = useInboxStore.getState().pending;
    expect(locks[`sessions:${REAL_A}:inbox_dismissed_at`]).toEqual({ type: "field", value: null, ts: 900 });
    expect(locks[`conversations:${REAL_A}:inbox_stashed_at`]).toEqual({ type: "field", value: null, ts: 900 });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_stashed_at).toBeNull();
  });

  it("a delayed kill cannot split a newer stash across the session and conversation twins", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "stash", ids: [REAL_A], ts: 900 });
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBeUndefined();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBe(900);
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBeUndefined();
    expect(state.conversations[REAL_A].inbox_stashed_at).toBe(900);
  });

  it("stash clears the sender's pin state on both twins", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: true, inbox_pinned_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: 100 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "stash", ids: [REAL_A], ts: 900 });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBe(900);
    expect(state.sessions[REAL_A].is_pinned).toBe(false);
    expect(state.sessions[REAL_A].inbox_pinned_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_stashed_at).toBe(900);
    expect(state.conversations[REAL_A].inbox_pinned_at).toBeNull();
  });

  it("does not let an older stash clear a newer pin", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: true, inbox_pinned_at: 900 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: 900 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "stash", ids: [REAL_A], ts: 500 });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBeUndefined();
    expect(state.sessions[REAL_A].is_pinned).toBe(true);
    expect(state.sessions[REAL_A].inbox_pinned_at).toBe(900);
    expect(state.conversations[REAL_A].inbox_stashed_at).toBeUndefined();
    expect(state.conversations[REAL_A].inbox_pinned_at).toBe(900);
  });

  it("does not let a delayed pin undo a newer stash", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: true, inbox_pinned_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: 100 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "stash", ids: [REAL_A], ts: 900 });
    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: 500, ts: 500 });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBe(900);
    expect(state.sessions[REAL_A].is_pinned).toBe(false);
    expect(state.sessions[REAL_A].inbox_pinned_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_stashed_at).toBe(900);
    expect(state.conversations[REAL_A].inbox_pinned_at).toBeNull();
  });

  it("keeps divergent twins unchanged for an older hide, then applies a newer hide to both", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_stashed_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_stashed_at: 900 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });
    let state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBeUndefined();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBe(100);
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBeUndefined();
    expect(state.conversations[REAL_A].inbox_stashed_at).toBe(900);

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 1_000 });
    state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBe(1_000);
    expect(state.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBe(1_000);
    expect(state.conversations[REAL_A].inbox_stashed_at).toBeNull();
  });

  it("keeps divergent twins unchanged for an older restore, then restores both", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 900 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 500 });
    let state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBe(100);
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBe(900);

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 1_000 });
    state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_stashed_at).toBeNull();
  });

  it("keeps divergent twins unchanged for older generic fields, then applies them to both", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 900 } },
    });

    const fields = { inbox_dismissed_at: null, inbox_stashed_at: null };
    useInboxStore.getState().applyGestureBridge({ kind: "fields", id: REAL_A, fields, ts: 500 });
    let state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBe(100);
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBe(900);

    useInboxStore.getState().applyGestureBridge({ kind: "fields", id: REAL_A, fields, ts: 1_000 });
    state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_stashed_at).toBeNull();
  });

  it("keeps divergent twins unchanged for an older pin, then applies the newer unpin to both", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: true, inbox_pinned_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: 900 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: false, pinnedAt: null, ts: 500 });
    let state = useInboxStore.getState();
    expect(state.sessions[REAL_A].is_pinned).toBe(true);
    expect(state.sessions[REAL_A].inbox_pinned_at).toBe(100);
    expect(state.conversations[REAL_A].inbox_pinned_at).toBe(900);

    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: false, pinnedAt: null, ts: 1_000 });
    state = useInboxStore.getState();
    expect(state.sessions[REAL_A].is_pinned).toBe(false);
    expect(state.sessions[REAL_A].inbox_pinned_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_pinned_at).toBeNull();
  });

  it("a newer kill atomically replaces an older stash", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "stash", ids: [REAL_A], ts: 500 });
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 900 });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBe(900);
    expect(state.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBe(900);
    expect(state.conversations[REAL_A].inbox_stashed_at).toBeNull();
  });

  it("a no-op unpin plants twin tombstones that reject a delayed pin", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: false, inbox_pinned_at: null } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: null } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: false, pinnedAt: null, ts: 900 });
    const locks = useInboxStore.getState().pending;
    expect(locks[`sessions:${REAL_A}:is_pinned`]).toEqual({ type: "field", value: false, ts: 900 });
    expect(locks[`sessions:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: null, ts: 900 });
    expect(locks[`conversations:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: null, ts: 900 });

    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: 500, ts: 500 });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].is_pinned).toBe(false);
    expect(state.sessions[REAL_A].inbox_pinned_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_pinned_at).toBeNull();
  });

  it("a hide or stash plants pin tombstones on already-unpinned twins", () => {
    const originalNow = Date.now;
    Date.now = () => 1_000;
    try {
      for (const [mode, hiddenField] of [["kill", "inbox_dismissed_at"], ["stash", "inbox_stashed_at"]] as const) {
        const enqueued: any[] = [];
        const dispatched: string[] = [];
        seed({
          sessions: { [REAL_A]: session(REAL_A, { is_pinned: false, inbox_pinned_at: null } as any) },
          conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: null } },
        });
        const store = useInboxStore.getState() as any;
        store._setOutbox((entry: any) => { enqueued.push(entry); }, () => {}, async () => []);
        store._setDispatch((action: string) => { dispatched.push(action); return Promise.resolve(); });

        useInboxStore.getState().applyGestureBridge({ kind: "hide", mode, ids: [REAL_A], ts: 900 });
        let state = useInboxStore.getState();
        expect(state.sessions[REAL_A][hiddenField]).toBe(900);
        expect(state.pending[`sessions:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: null, ts: 900, hideAck: 900 });
        expect(state.pending[`conversations:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: null, ts: 900, hideAck: 900 });

        // The late pin is older than the hide's pin-clear tombstone.
        useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: 500, ts: 500 });
        state = useInboxStore.getState();
        expect(state.sessions[REAL_A].is_pinned).toBe(false);
        expect(state.sessions[REAL_A].inbox_pinned_at).toBeNull();
        expect(state.conversations[REAL_A].inbox_pinned_at).toBeNull();
        expect(enqueued).toEqual([]);
        expect(dispatched).toEqual([]);

        // A stale hidden-reconcile page cannot retire the coupled locks.
        if (mode === "kill") {
          useInboxStore.getState().applyDismissedReconcile([{ _id: REAL_A, inbox_dismissed_at: 500 }], false);
        } else {
          useInboxStore.getState().applyStashedReconcile([{ _id: REAL_A, inbox_stashed_at: 500 }], false);
        }
        expect(useInboxStore.getState().pending[`conversations:${REAL_A}:inbox_pinned_at`]).toBeDefined();

        // Hidden rows never reach normal sessions sync. Their one-field
        // reconcile acknowledgement retires every lock from this hide transition.
        if (mode === "kill") {
          useInboxStore.getState().applyDismissedReconcile([{ _id: REAL_A, inbox_dismissed_at: 900 }], false);
        } else {
          useInboxStore.getState().applyStashedReconcile([{ _id: REAL_A, inbox_stashed_at: 900 }], false);
        }
        const pending = useInboxStore.getState().pending;
        for (const coll of ["sessions", "conversations"]) {
          expect(pending[`${coll}:${REAL_A}:inbox_dismissed_at`]).toBeUndefined();
          expect(pending[`${coll}:${REAL_A}:inbox_stashed_at`]).toBeUndefined();
          expect(pending[`${coll}:${REAL_A}:inbox_pinned_at`]).toBeUndefined();
        }

        // With the hidden acknowledgement retired, a later authoritative pin is
        // no longer overwritten by the old null tombstone on either twin.
        useInboxStore.getState().syncTable("sessions", [session(REAL_A, { is_pinned: true, [hiddenField]: 900, inbox_pinned_at: 1_000 } as any)]);
        useInboxStore.getState().syncRecord("conversations", REAL_A, { _id: REAL_A, [hiddenField]: 900, inbox_pinned_at: 1_000 });
        state = useInboxStore.getState();
        expect(state.sessions[REAL_A].is_pinned).toBe(true);
        expect(state.sessions[REAL_A].inbox_pinned_at).toBe(1_000);
        expect(state.conversations[REAL_A].inbox_pinned_at).toBe(1_000);
      }
    } finally {
      Date.now = originalNow;
    }
  });

  it("a local hide uses its visible timestamp as the hidden-reconcile acknowledgement anchor", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: true, inbox_pinned_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: 100 } },
    });
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => (++calls === 1 ? 1_001 : 1_002);
    try {
      // hideSessionInDraft samples 1001 for the durable dismiss value; the
      // middleware samples 1002 separately for local lock freshness.
      useInboxStore.getState().killSession(REAL_A);
      let state = useInboxStore.getState();
      expect(state.sessions[REAL_A].inbox_dismissed_at).toBe(1_001);
      expect(state.pending[`sessions:${REAL_A}:inbox_pinned_at`]).toMatchObject({
        type: "field", value: null, ts: 1_002, hideAck: 1_001,
      });
      expect(state.pending[`conversations:${REAL_A}:inbox_pinned_at`]).toMatchObject({
        type: "field", value: null, ts: 1_002, hideAck: 1_001,
      });

      useInboxStore.getState().applyDismissedReconcile([{ _id: REAL_A, inbox_dismissed_at: 1_000 }], false);
      expect(useInboxStore.getState().pending[`conversations:${REAL_A}:inbox_pinned_at`]).toBeDefined();

      // A newer hide supersedes the local transition. Its acknowledgement
      // anchor must not be retired by the older operation's eventual echo.
      useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 1_003 });
      useInboxStore.getState().applyDismissedReconcile([{ _id: REAL_A, inbox_dismissed_at: 1_001 }], false);
      expect(useInboxStore.getState().pending[`conversations:${REAL_A}:inbox_pinned_at`]).toMatchObject({ hideAck: 1_003 });

      useInboxStore.getState().applyDismissedReconcile([{ _id: REAL_A, inbox_dismissed_at: 1_003 }], false);
      state = useInboxStore.getState();
      for (const coll of ["sessions", "conversations"]) {
        expect(state.pending[`${coll}:${REAL_A}:inbox_dismissed_at`]).toBeUndefined();
        expect(state.pending[`${coll}:${REAL_A}:inbox_pinned_at`]).toBeUndefined();
      }
    } finally {
      Date.now = originalNow;
    }
  });

  it("an undo pin with an older pinnedAt still orders after delayed hide or stash", () => {
    for (const [mode, hiddenField] of [["kill", "inbox_dismissed_at"], ["stash", "inbox_stashed_at"]] as const) {
      seed({
        sessions: { [REAL_A]: session(REAL_A, { is_pinned: true, inbox_pinned_at: 100 } as any) },
        conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: 100 } },
      });

      // Undo restores the original pinnedAt value, while its fresh message ts
      // is the causal ordering stamp. This is visibly a no-op but not a
      // causally empty transition.
      useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: 100, ts: 900 });
      let state = useInboxStore.getState();
      expect(state.pending[`sessions:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: 100, ts: 900 });
      expect(state.pending[`conversations:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: 100, ts: 900 });

      useInboxStore.getState().applyGestureBridge({ kind: "hide", mode, ids: [REAL_A], ts: 500 });
      state = useInboxStore.getState();
      expect(state.sessions[REAL_A][hiddenField]).toBeUndefined();
      expect(state.sessions[REAL_A].is_pinned).toBe(true);
      expect(state.conversations[REAL_A].inbox_pinned_at).toBe(100);

      // The old payload is also the exact server echo value, so it retires the
      // fresh ordering lock rather than pinning the field indefinitely.
      useInboxStore.getState().syncTable("sessions", [session(REAL_A, { is_pinned: true, inbox_pinned_at: 100 } as any)]);
      useInboxStore.getState().syncRecord("conversations", REAL_A, { _id: REAL_A, inbox_pinned_at: 100 });
      expect(useInboxStore.getState().pending[`sessions:${REAL_A}:inbox_pinned_at`]).toBeUndefined();
      expect(useInboxStore.getState().pending[`conversations:${REAL_A}:inbox_pinned_at`]).toBeUndefined();

      useInboxStore.getState().applyGestureBridge({ kind: "hide", mode, ids: [REAL_A], ts: 1_000 });
      state = useInboxStore.getState();
      expect(state.sessions[REAL_A][hiddenField]).toBe(1_000);
      expect(state.sessions[REAL_A].is_pinned).toBe(false);
      expect(state.conversations[REAL_A][hiddenField]).toBe(1_000);
      expect(state.conversations[REAL_A].inbox_pinned_at).toBeNull();
    }
  });

  it("no-op undo fields plant twin tombstones that reject delayed hide and pin gestures", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: false, inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null } },
    });

    // This is undoableHideSession's real sibling payload when its snapshot was
    // already visible in this window.
    useInboxStore.getState().applyGestureBridge({
      kind: "fields",
      id: REAL_A,
      fields: { inbox_dismissed_at: null, inbox_stashed_at: null },
      ts: 900,
    });
    let locks = useInboxStore.getState().pending;
    expect(locks[`sessions:${REAL_A}:inbox_dismissed_at`]).toEqual({ type: "field", value: null, ts: 900 });
    expect(locks[`conversations:${REAL_A}:inbox_stashed_at`]).toEqual({ type: "field", value: null, ts: 900 });
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    // Generic pin patches also need their no-op ordering tombstone.
    useInboxStore.getState().applyGestureBridge({
      kind: "fields",
      id: REAL_A,
      fields: { inbox_pinned_at: null },
      ts: 900,
    });
    locks = useInboxStore.getState().pending;
    expect(locks[`sessions:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: null, ts: 900 });
    expect(locks[`conversations:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: null, ts: 900 });
    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: 500, ts: 500 });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.sessions[REAL_A].inbox_stashed_at).toBeNull();
    expect(state.sessions[REAL_A].is_pinned).toBe(false);
    expect(state.sessions[REAL_A].inbox_pinned_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_stashed_at).toBeNull();
    expect(state.conversations[REAL_A].inbox_pinned_at).toBeNull();
  });

  it("delayed pin and hide field writes cannot overwrite newer field locks", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 100, is_pinned: true, inbox_pinned_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 100, inbox_pinned_at: 100 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 900 });
    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: false, pinnedAt: null, ts: 900 });
    useInboxStore.getState().applyGestureBridge({
      kind: "fields",
      id: REAL_A,
      fields: { inbox_dismissed_at: 500, is_pinned: true, inbox_pinned_at: 500 },
      ts: 500,
    });

    const state = useInboxStore.getState();
    expect(state.sessions[REAL_A].inbox_dismissed_at).toBeNull();
    expect(state.sessions[REAL_A].is_pinned).toBe(false);
    expect(state.sessions[REAL_A].inbox_pinned_at).toBeNull();
  });

  it("an older unpin does not undo a newer local pin", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: true, inbox_pinned_at: 900 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: 900 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: false, pinnedAt: null, ts: 500 });

    expect(useInboxStore.getState().sessions[REAL_A].is_pinned).toBe(true);
    expect(useInboxStore.getState().sessions[REAL_A].inbox_pinned_at).toBe(900);
  });

  it("an older kill does not clear a newer local pin", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: true, inbox_pinned_at: 900 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_pinned_at: 900 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    expect(useInboxStore.getState().sessions[REAL_A].is_pinned).toBe(true);
  });

  it("a repeated hide is idempotent (same ts re-applied)", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });
    const msg: GestureMessage = { kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 };
    useInboxStore.getState().applyGestureBridge(msg);
    useInboxStore.getState().applyGestureBridge(msg);
    expect(useInboxStore.getState().sessions[REAL_A].inbox_dismissed_at).toBe(500);
  });
});

describe("gesture bridge delivery filters", () => {
  it("drops a window's own broadcast (source token)", () => {
    const seen: GestureMessage[] = [];
    const stop = subscribeGestures("user-1", () => "user-1", (m) => seen.push(m));
    // Same process, same source token — as if the window heard itself.
    broadcastGesture({ kind: "restore", ids: [REAL_A], ts: 1 }, "user-1");
    stop();
    expect(seen).toHaveLength(0);
  });

  it("drops a message stamped with a different user", () => {
    const seen: GestureMessage[] = [];
    // Subscribe on the "user-2" channel but with our account since switched.
    const stop = subscribeGestures("user-2", () => "user-1", (m) => seen.push(m));
    // A foreign sender: same channel, different source token and user id.
    hub.factory("codecast-gesture:user-2").postMessage({
      v: 1, source: "other-window", userId: "user-2",
      kind: "restore", ids: [REAL_A], ts: 1,
    });
    stop();
    expect(seen).toHaveLength(0);
  });

  it("delivers a sibling's message on the matching channel and user", () => {
    const seen: GestureMessage[] = [];
    const stop = subscribeGestures("user-1", () => "user-1", (m) => seen.push(m));
    hub.factory("codecast-gesture:user-1").postMessage({
      v: 1, source: "other-window", userId: "user-1",
      kind: "hide", mode: "kill", ids: [REAL_A], ts: 7,
    });
    stop();
    expect(seen).toEqual([{ kind: "hide", mode: "kill", ids: [REAL_A], ts: 7 }]);
  });

  it("ignores malformed and wrong-version payloads", () => {
    const seen: GestureMessage[] = [];
    const stop = subscribeGestures("user-1", () => "user-1", (m) => seen.push(m));
    const ch = hub.factory("codecast-gesture:user-1");
    ch.postMessage({ v: 2, source: "o", userId: "user-1", kind: "restore", ids: [], ts: 1 });
    ch.postMessage({ v: 1, source: "o", userId: "user-1", kind: "nope", ts: 1 });
    ch.postMessage({ v: 1, source: "o", userId: "user-1", kind: "pin", id: REAL_A, ts: 1 });
    ch.postMessage("garbage");
    stop();
    expect(seen).toHaveLength(0);
  });

  it("a stopped subscription receives nothing", () => {
    const seen: GestureMessage[] = [];
    subscribeGestures("user-1", () => "user-1", (m) => seen.push(m))();
    hub.factory("codecast-gesture:user-1").postMessage({
      v: 1, source: "other-window", userId: "user-1", kind: "restore", ids: [REAL_A], ts: 1,
    });
    expect(seen).toHaveLength(0);
  });
});

describe("gesture bridge receiver is local-only", () => {
  // sync() actions never dispatch and never enqueue an outbox entry — that is
  // the whole reason the receiver is a sync(): the ACTING window already owns
  // the single server write, and a receiver that re-dispatched would multiply
  // one gesture by the number of open windows.
  it("creates no outbox entry and no dispatch", () => {
    const enqueued: any[] = [];
    const dispatched: string[] = [];
    seed({
      sessions: { [REAL_A]: session(REAL_A), [STUB]: session(STUB) },
      conversations: { [REAL_A]: { _id: REAL_A }, [STUB]: { _id: STUB } },
    });
    const store = useInboxStore.getState() as any;
    store._setOutbox((e: any) => { enqueued.push(e); }, () => {}, async () => []);
    store._setDispatch((action: string) => { dispatched.push(action); return Promise.resolve(); });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], forget: [STUB], ts: 500 });
    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 600 });
    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: 700, ts: 700 });

    expect(enqueued).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("does not re-broadcast what it just applied (no echo storm)", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });
    expect(hub.posted).toHaveLength(0);
  });

  // NOTE: an earlier version of this test asserted `pending` stayed EMPTY after
  // a bridged hide. That assertion encoded the bug below — the field lock is
  // what keeps the bridged value alive against this window's own sync channels,
  // and {type:"field"} entries are consumed only by the local sync appliers, so
  // planting them does not reach the server.
  it("plants the same pending field locks the sender's action() gets", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A) },
      conversations: { [REAL_A]: { _id: REAL_A } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    const p = useInboxStore.getState().pending;
    expect(p[`sessions:${REAL_A}:inbox_dismissed_at`]).toEqual({ type: "field", value: 500, ts: 500, hideAck: 500 });
    expect(p[`conversations:${REAL_A}:inbox_dismissed_at`]).toEqual({ type: "field", value: 500, ts: 500, hideAck: 500 });
  });

  // THE regression test for the field-lock defect. A sessions crawl already in
  // flight in the receiving window (a wake reconcile pages for seconds) lands a
  // snapshot taken BEFORE the gesture. Without the planted lock, applySyncTable
  // replaces the row wholesale, the bridged hide silently vanishes here, and
  // this window's next whole-row put writes the un-hidden row over the acting
  // window's in the shared principal IDB store.
  it("a stale server row mid-crawl does NOT revert the bridged hide", () => {
    const serverRow = session(REAL_A); // pre-gesture: no inbox_dismissed_at
    seed({ sessions: {}, conversations: {} });
    useInboxStore.getState().syncTable("sessions", [serverRow]);
    expect(useInboxStore.getState().sessions[REAL_A]).toBeDefined();

    // The user kills REAL_A in the OTHER window mid-crawl.
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });
    expect(useInboxStore.getState().sessions[REAL_A].inbox_dismissed_at).toBe(500);

    // The in-flight crawl now delivers its pre-kill snapshot.
    useInboxStore.getState().syncTable("sessions", [serverRow]);

    expect(useInboxStore.getState().sessions[REAL_A].inbox_dismissed_at).toBe(500);
  });

  it("the lock retires once the server echoes the gesture back", () => {
    seed({ sessions: {}, conversations: {} });
    useInboxStore.getState().syncTable("sessions", [session(REAL_A)]);
    useInboxStore.getState().applyGestureBridge({ kind: "hide", mode: "kill", ids: [REAL_A], ts: 500 });

    // The acting window's server write lands; the crawl now carries the hide.
    useInboxStore.getState().syncTable("sessions", [session(REAL_A, { inbox_dismissed_at: 500 } as any)]);

    expect(useInboxStore.getState().sessions[REAL_A].inbox_dismissed_at).toBe(500);
    // Self-clearing: the lock exists to bridge the gap until the echo, and
    // applyFieldOverrides drops it once the server agrees. A lock that never
    // retired would pin the row against every later server change.
    expect(useInboxStore.getState().pending[`sessions:${REAL_A}:inbox_dismissed_at`]).toBeUndefined();
  });

  it("locks the cleared fields on restore, and the pin fields on pin", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: 100 } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: 100 } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 500 });
    expect(useInboxStore.getState().pending[`sessions:${REAL_A}:inbox_dismissed_at`])
      .toEqual({ type: "field", value: null, ts: 500 });

    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: true, pinnedAt: 600, ts: 600 });
    const p = useInboxStore.getState().pending;
    expect(p[`sessions:${REAL_A}:is_pinned`]).toEqual({ type: "field", value: true, ts: 600 });
    // The locked value must equal what the SENDER dispatched — the lock retires
    // only when the server echo matches it, so a re-derived timestamp would
    // stick forever.
    expect(p[`sessions:${REAL_A}:inbox_pinned_at`]).toEqual({ type: "field", value: 600, ts: 600 });
  });

  it("retires no-op restore and unpin tombstones on matching server echoes", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { is_pinned: false, inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null } },
    });

    useInboxStore.getState().applyGestureBridge({ kind: "restore", ids: [REAL_A], ts: 900 });
    useInboxStore.getState().applyGestureBridge({ kind: "pin", id: REAL_A, pinned: false, pinnedAt: null, ts: 900 });
    useInboxStore.getState().syncTable("sessions", [
      session(REAL_A, { is_pinned: false, inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null } as any),
    ]);
    // Production conversation echoes omit clear optional inbox timestamps.
    useInboxStore.getState().syncRecord("conversations", REAL_A, { _id: REAL_A });

    const pending = useInboxStore.getState().pending;
    expect(pending[`sessions:${REAL_A}:inbox_dismissed_at`]).toBeUndefined();
    expect(pending[`sessions:${REAL_A}:inbox_stashed_at`]).toBeUndefined();
    expect(pending[`sessions:${REAL_A}:inbox_pinned_at`]).toBeUndefined();
    expect(pending[`conversations:${REAL_A}:inbox_dismissed_at`]).toBeUndefined();
    expect(pending[`conversations:${REAL_A}:inbox_stashed_at`]).toBeUndefined();
    expect(pending[`conversations:${REAL_A}:inbox_pinned_at`]).toBeUndefined();
  });

  it("retires no-op generic fields tombstones on matching server echoes", () => {
    seed({
      sessions: { [REAL_A]: session(REAL_A, { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null } as any) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null } },
    });

    useInboxStore.getState().applyGestureBridge({
      kind: "fields",
      id: REAL_A,
      fields: { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null },
      ts: 900,
    });
    useInboxStore.getState().syncTable("sessions", [
      session(REAL_A, { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_pinned_at: null } as any),
    ]);
    useInboxStore.getState().syncRecord("conversations", REAL_A, { _id: REAL_A });

    const pending = useInboxStore.getState().pending;
    expect(pending[`sessions:${REAL_A}:inbox_dismissed_at`]).toBeUndefined();
    expect(pending[`sessions:${REAL_A}:inbox_stashed_at`]).toBeUndefined();
    expect(pending[`sessions:${REAL_A}:inbox_pinned_at`]).toBeUndefined();
    expect(pending[`conversations:${REAL_A}:inbox_dismissed_at`]).toBeUndefined();
    expect(pending[`conversations:${REAL_A}:inbox_stashed_at`]).toBeUndefined();
    expect(pending[`conversations:${REAL_A}:inbox_pinned_at`]).toBeUndefined();
  });
});
