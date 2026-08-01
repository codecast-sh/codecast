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
import { undoablePinSession } from "../undoActions";
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

  it("a prune that removes nothing broadcasts nothing", () => {
    seed({ sessions: {}, conversations: {} });
    useInboxStore.getState().pruneGhostSessions([]);
    expect(hub.posted).toHaveLength(0);
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
    expect(p[`sessions:${REAL_A}:inbox_dismissed_at`]).toEqual({ type: "field", value: 500, ts: 500 });
    expect(p[`conversations:${REAL_A}:inbox_dismissed_at`]).toEqual({ type: "field", value: 500, ts: 500 });
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
});
