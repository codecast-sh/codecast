import { expect, test } from "bun:test";
import { reconcilePendingSendForSession, useInboxStore } from "../inboxStore";

const pending = () => ({ _id: "outgoing", _clientId: "outgoing", role: "user" as const, content: "Please preserve my message", timestamp: Date.now() - 86_400_000, _sentBaselineTs: 100, _isOptimistic: true as const });

for (const agent_status of ["working", "idle", "stopped"] as const) {
  for (const warm of [false, true]) {
    test(`unconfirmed input survives ${agent_status} with ${warm ? "warm" : "cold"} history`, () => {
      const input = pending();
      const state = { c: [input] };
      const history: any[] = warm ? [{ _id: "old", role: "assistant", content: "An older response", timestamp: 50 }] : [];
      expect(reconcilePendingSendForSession(state, "c", { agent_status, is_idle: agent_status !== "working", has_pending: false, updated_at: 200 }, "elsewhere", history)).toBe(false);
      expect(state.c).toEqual([input]);
    });
  }
}

test("a working status from the previous turn cannot erase a queued message", () => {
  const input = pending();
  const state = { c: [input] };
  reconcilePendingSendForSession(state, "c", { agent_status: "working", is_idle: false, has_pending: true, updated_at: 100 }, "elsewhere", []);
  expect(state.c).toEqual([input]);
});

test("matching authoritative user echo retires only the matching input", () => {
  const input = pending();
  const other = { ...input, _id: "other", _clientId: "other" };
  useInboxStore.setState({ pendingMessages: { c: [input, other] }, messages: {} } as any);
  useInboxStore.getState().setMessages("c", [{ _id: "server", role: "user", client_id: "outgoing", content: input.content, timestamp: Date.now() }] as any);
  expect(useInboxStore.getState().pendingMessages.c).toEqual([other]);
});

test("queue draining preserves the original durable message id", () => {
  useInboxStore.setState({ pendingMessages: {}, queuedMessages: {} } as any);
  const store = useInboxStore.getState();
  store.setQueuedMessagesFor("queued", ["first", "second"]);
  const original = useInboxStore.getState().pendingMessages.queued[0];
  const send = store.takeQueuedMessage("queued");
  expect(send).toEqual({ content: "first", clientId: original._clientId! });
  expect(useInboxStore.getState().pendingMessages.queued[0]._isLocalQueue).toBeUndefined();
  expect(store.getQueuedMessages("queued")).toEqual(["second"]);
});

test("queue editing preserves repeated texts and retires only the removed row", () => {
  useInboxStore.setState({ pendingMessages: {}, queuedMessages: {} } as any);
  const store = useInboxStore.getState();
  store.setQueuedMessagesFor("queued", ["same", "same", "third"]);
  const before = useInboxStore.getState().pendingMessages.queued;
  expect(new Set(before.map(message => message._id)).size).toBe(3);
  store.setQueuedMessagesFor("queued", ["same", "third"]);
  expect(useInboxStore.getState().pendingMessages.queued.map(message => message._id)).toEqual([before[0]._id, before[2]._id]);
});

test("rekey keeps queued input from both the stub and the resolved conversation", () => {
  useInboxStore.setState({ pendingMessages: {}, queuedMessages: {}, sessions: {}, conversations: {} } as any);
  const store = useInboxStore.getState();
  store.setQueuedMessagesFor("stub", ["from stub"]);
  store.setQueuedMessagesFor("real", ["already here"]);
  store._rekeySession("stub", "real");
  expect(store.getQueuedMessages("real")).toHaveLength(2);
  expect(store.getQueuedMessages("stub")).toEqual([]);
  expect(useInboxStore.getState().pendingMessages.real.map(message => message.content).sort()).toEqual(["already here", "from stub"]);
});

test("hiding a local session cannot discard the input waiting for its creation", () => {
  useInboxStore.setState({ pendingMessages: {}, sessions: {}, conversations: {}, currentUser: null } as any);
  const store = useInboxStore.getState();
  const clientId = store.addOptimisticMessage("stub-awaiting-create", "keep my input when I leave");
  store.stashSession("stub-awaiting-create");
  expect(useInboxStore.getState().pendingMessages["stub-awaiting-create"]).toMatchObject([{ _clientId: clientId, content: "keep my input when I leave" }]);
});
