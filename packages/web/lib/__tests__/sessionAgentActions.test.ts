import { expect, test, afterEach } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { forkSessionAsAgent, switchSessionAgent } from "../sessionAgentActions";

const original = useInboxStore.getState();
afterEach(() => useInboxStore.setState(original, true));
const session = { _id: "jx700000000000000000000000000001", agent_type: "claude_code", title: "Example" };

test("switching changes the agent immediately and restores it when the command fails", async () => {
  const updates: string[] = [];
  let reject: (error: Error) => void = () => {};
  useInboxStore.setState({ getConvexId: id => id, setConversationAgent: (_, agent) => { updates.push(agent); }, convCommand: (() => new Promise((_, fail) => { reject = fail; })) as any });
  const result = switchSessionAgent(session, "codex");
  expect(updates).toEqual(["codex"]);
  reject(new Error("Device offline"));
  await expect(result).rejects.toThrow("Device offline");
  expect(updates).toEqual(["codex", "claude_code"]);
});

test("switching a fork still being created waits for its real id and switches the process", async () => {
  const stubId = "2109dc9b-aabb-4928-b627-426a663be342";
  const calls: any[] = [];
  let resolveCreate!: (id: string) => void;
  const created = new Promise<string>(resolve => { resolveCreate = resolve; });
  useInboxStore.setState({
    getConvexId: () => undefined,
    sessions: { [stubId]: { ...session, _id: stubId, forked_from: session._id } } as any,
    awaitConvexId: () => created,
    setConversationAgent: (id, agent) => { calls.push(["agent", id, agent]); },
    convCommand: (async (id, command, args) => { calls.push([command, id, args]); }) as any,
  });
  const switched = switchSessionAgent({ ...session, _id: stubId }, "codex");
  expect(calls).toEqual([["agent", stubId, "codex"]]);
  resolveCreate(session._id);
  await switched;
  expect(calls).toContainEqual(["switchSessionAgent", session._id, { agent_type: "codex" }]);
});

test("a failed switch after fork creation restores the real row", async () => {
  const stubId = "2109dc9b-aabb-4928-b627-426a663be342";
  const updates: any[] = [];
  useInboxStore.setState({
    getConvexId: () => undefined,
    sessions: { [stubId]: { ...session, _id: stubId, forked_from: session._id } } as any,
    awaitConvexId: async () => session._id,
    setConversationAgent: (id, agent) => { updates.push([id, agent]); },
    convCommand: (() => Promise.reject(new Error("Switch failed"))) as any,
  });
  await expect(switchSessionAgent({ ...session, _id: stubId }, "codex")).rejects.toThrow("Switch failed");
  expect(updates.at(-1)).toEqual([session._id, "claude_code"]);
});

test("choosing an agent on an unstarted blank session only updates its launch preference", async () => {
  const stubId = "blank-session";
  const updates: string[] = [];
  useInboxStore.setState({
    getConvexId: () => undefined,
    sessions: { [stubId]: { ...session, _id: stubId, message_count: 0 } } as any,
    setConversationAgent: (_, agent) => { updates.push(agent); },
    awaitConvexId: async () => { throw new Error("Blank sessions must not be launched by this picker"); },
  });
  await switchSessionAgent({ ...session, _id: stubId }, "codex");
  expect(updates).toEqual(["codex"]);
});

test("forking seeds and tracks a child before the server responds", async () => {
  const calls: any[] = [];
  useInboxStore.setState({ getConvexId: id => id, syncRecord: ((...args: any[]) => calls.push(["sync", ...args])) as any, injectSession: row => { calls.push(["inject", row]); }, moveDraft: (...args) => { calls.push(["draft", ...args]); }, trackSessionCreate: () => {}, resolveForkSessionId: (...args) => { calls.push(["resolve", ...args]); }, convCommand: ((id: string, command: string, args: any) => { calls.push([command, id, args]); return Promise.resolve({ conversation_id: "jx700000000000000000000000000002" }); }) as any });
  const fork = forkSessionAsAgent(session, "codex");
  expect(calls.find(c => c[0] === "inject")[1]).toMatchObject({ _id: fork.sessionId, agent_type: "codex", parent_conversation_id: session._id, fork_status: "copying" });
  expect(calls.find(c => c[0] === "forkFromMessage")[2]).toEqual({ target_agent_type: "codex", session_id: fork.sessionId });
  await fork.ready;
  expect(calls.at(-1)).toEqual(["resolve", fork.sessionId, "jx700000000000000000000000000002"]);
});

test("forking refuses a parent that has not been created on the server", () => {
  useInboxStore.setState({ getConvexId: () => null });
  expect(() => forkSessionAsAgent({ ...session, _id: "temporary-parent" }, "codex")).toThrow("still being created");
});

test("a failed fork restores the parent draft and removes the optimistic child", async () => {
  const calls: any[] = [];
  useInboxStore.setState({
    getConvexId: id => id,
    syncRecord: (() => {}) as any,
    injectSession: () => {},
    moveDraft: (...args) => { calls.push(["draft", ...args]); },
    trackSessionCreate: () => {},
    discardForkStub: (...args) => { calls.push(["discard", ...args]); },
    convCommand: (() => Promise.reject(new Error("Fork failed"))) as any,
  });
  const fork = forkSessionAsAgent(session, "codex");
  await expect(fork.ready).rejects.toThrow("Fork failed");
  expect(calls).toContainEqual(["draft", session._id, fork.sessionId]);
  expect(calls).toContainEqual(["draft", fork.sessionId, session._id]);
  expect(calls).toContainEqual(["discard", fork.sessionId, session._id]);
});
