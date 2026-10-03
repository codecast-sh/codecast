import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetUndoStacks } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { setGestureChannelFactory } from "../gestureBridge";
import { applyUpdatesToStore, buildMutUpdates } from "../syncReplication";
import { declareViewNav } from "../viewNav";
import { performUndo } from "../undoStack";

// A stash or kill of a teammate's row deletes it (it cannot be hidden
// durably), and every sibling window applies that forget with excludes that
// drop each later push of the row. Undo puts the row back whole, so it must
// reach the siblings too: over the gesture bridge, and over the follower's
// mut to the sync host, which owns IndexedDB write-through.
const TEAM = "t".repeat(32);
const ME = "m".repeat(32);
const posted: any[] = [];
const factory = (_name: string) =>
  ({
    postMessage(data: any) { posted.push(structuredClone(data)); },
    addEventListener() {},
    removeEventListener() {},
    close() {},
  }) as unknown as BroadcastChannel;

const row = () => ({ _id: TEAM, session_id: "s", updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false, user_id: "other" });
const s = () => useInboxStore.getState() as any;
const excludes = () => Object.entries(s().pending).filter(([k, v]: any) => k.includes(TEAM) && v.type === "exclude").map(([k]) => k);

function seed(opts: { meta?: boolean } = {}) {
  declareViewNav("gesture");
  useInboxStore.setState({
    sessions: { [TEAM]: row() },
    conversations: opts.meta === false ? {} : { [TEAM]: { _id: TEAM, is_own: false } },
    messages: {}, pendingMessages: {}, pagination: {}, pendingSessionCreates: {}, pending: {},
    currentSessionId: null, viewingDismissedId: null, currentUser: { _id: ME }, clientState: {},
  } as any);
}

beforeEach(() => { _resetUndoStacks(); posted.length = 0; setGestureChannelFactory(factory); seed(); });
afterEach(() => { setGestureChannelFactory(null); s()._setActionTee(null); });

test("a sibling that applied the forget gets the row back, and keeps later pushes of it", () => {
  s().stashSession(TEAM);
  expect(s().sessions[TEAM]).toBeUndefined();
  const forward = posted.slice();
  expect(performUndo()).toBe(true);
  const undo = posted.slice(forward.length);
  expect(undo.map((m) => m.kind)).toContain("unforget");

  // The sibling: same start, then exactly what was broadcast.
  seed();
  for (const m of forward) s().applyGestureBridge(m);
  expect(s().sessions[TEAM]).toBeUndefined();
  expect(excludes().sort()).toEqual([`conversations:${TEAM}`, `sessions:${TEAM}`]);
  for (const m of undo) s().applyGestureBridge(m);
  expect(s().sessions[TEAM]?._id).toBe(TEAM);
  expect(s().conversations[TEAM]?._id).toBe(TEAM);
  expect(excludes()).toEqual([]);
  // The server's restoreSession un-hid it; its next push still lands.
  s().syncTable("sessions", [{ ...row(), updated_at: 2 }], { isDelta: true });
  expect(s().sessions[TEAM]?.updated_at).toBe(2);
});

test("a sibling that hid the row again after the undo keeps it hidden", () => {
  s().stashSession(TEAM);
  const forward = posted.slice();
  performUndo();
  const undo = posted.slice(forward.length).map((m) => ({ ...m, ts: 1 }));
  seed();
  for (const m of forward) s().applyGestureBridge(m);
  for (const m of undo) s().applyGestureBridge(m);
  expect(s().sessions[TEAM]).toBeUndefined();
});

test("the host lifts its forget's excludes for the follower's undo mut", () => {
  let teed: any[] = [];
  s()._setActionTee((_n: string, patches: any[], state: any) => { teed.push(...buildMutUpdates(patches, state)); });
  s().stashSession(TEAM);
  const forward = posted.slice();
  teed = [];
  expect(performUndo()).toBe(true);
  const undoMut = teed;
  s()._setActionTee(null);

  // The host: the forward gesture over the bridge, then only the mut.
  seed();
  for (const m of forward) s().applyGestureBridge(m);
  applyUpdatesToStore(undoMut, { optimistic: true });
  expect(s().sessions[TEAM]?._id).toBe(TEAM);
  expect(excludes().filter((k) => k.startsWith("sessions:"))).toEqual([]);
});

// The common case: a teammate session this window never opened holds no
// conversations row, so the undo puts back only the sessions row. The
// sibling's forget still planted the conversations exclude, and nothing else
// would ever lift it: the conversation's meta could never sync in again.
test("without a conversations row, the sibling's conversations exclude lifts and the meta lands", () => {
  seed({ meta: false });
  s().stashSession(TEAM);
  const forward = posted.slice();
  performUndo();
  const undo = posted.slice(forward.length);
  seed({ meta: false });
  for (const m of forward) s().applyGestureBridge(m);
  expect(excludes().sort()).toEqual([`conversations:${TEAM}`, `sessions:${TEAM}`]);
  for (const m of undo) s().applyGestureBridge(m);
  expect(s().sessions[TEAM]?._id).toBe(TEAM);
  expect(excludes()).toEqual([]);
  s().syncRecord("conversations", TEAM, { _id: TEAM, is_own: false, title: "meta" });
  expect(s().conversations[TEAM]?.title).toBe("meta");
});

test("without a conversations row, the host lifts the conversations exclude for the follower's undo mut", () => {
  seed({ meta: false });
  let teed: any[] = [];
  s()._setActionTee((_n: string, patches: any[], state: any) => { teed.push(...buildMutUpdates(patches, state)); });
  s().stashSession(TEAM);
  const forward = posted.slice();
  teed = [];
  performUndo();
  const undoMut = teed;
  s()._setActionTee(null);
  seed({ meta: false });
  for (const m of forward) s().applyGestureBridge(m);
  applyUpdatesToStore(undoMut, { optimistic: true });
  expect(s().sessions[TEAM]?._id).toBe(TEAM);
  expect(excludes()).toEqual([]);
  s().syncRecord("conversations", TEAM, { _id: TEAM, is_own: false, title: "meta" });
  expect(s().conversations[TEAM]?.title).toBe("meta");
});
