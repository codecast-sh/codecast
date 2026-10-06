// A hosted start goes through the store's createSessionFromStub and
// createSession action, so the hosted create rides the outbox like every other
// new session and its server half is the classified CREATE
// (storeActionMutations.guard). The hosted branch sends no project, machine,
// model or placement, and the first message rides the create.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { useInboxStore } from "../store/inboxStore";
import { DispatchNotWiredError, StaleDispatchBindingError } from "../store/mutativeMiddleware";
import { settleHostedStart, startHostedConversation } from "./startHostedConversation";

const owner = {};
const calls: Array<{ action: string; args: any[] }> = [];
beforeAll(() => useInboxStore.getState()._setDispatch(async (action, args) => {
  calls.push({ action, args });
  return action === "createSession" ? "conv_hosted_1" : null;
}, { owner }));
afterAll(() => useInboxStore.getState()._clearDispatch(owner));
beforeEach(() => { calls.length = 0; });

const settle = () => new Promise((r) => setTimeout(r, 20));

test("a start dispatches createSession with the hosted agent and the first message", async () => {
  const stubId = startHostedConversation("What's on tomorrow?");
  await settle();
  const create = calls.find((c) => c.action === "createSession");
  expect(create?.args[0]).toMatchObject({
    agent_type: HOSTED_AGENT_TYPE,
    session_id: stubId,
    first_message: "What's on tomorrow?",
  });
  expect(typeof create?.args[0].first_message_client_id).toBe("string");
  expect(create?.args[0].first_message_client_id.length).toBeGreaterThan(0);
});

test("a hosted stub creates with no project, machine, model or placement", async () => {
  const store = useInboxStore.getState();
  const { stubId, materialize } = store.beginOptimisticSession({
    agentType: HOSTED_AGENT_TYPE,
    projectPath: "/Users/me/repo",
    gitRoot: "/Users/me/repo",
    deferCreate: true,
    create: (sid) => useInboxStore.getState().createSessionFromStub(sid, { firstMessage: { content: "Plan my week", clientId: "c1" } }),
  });
  useInboxStore.getState().syncRecord("sessions", stubId, { target_device_id: "dev_1", model: "claude-opus-4-8", effort: "high" });
  await materialize();
  const create = calls.find((c) => c.action === "createSession");
  expect(create?.args[0]).toEqual({
    agent_type: HOSTED_AGENT_TYPE,
    session_id: stubId,
    first_message: "Plan my week",
    first_message_client_id: "c1",
  });
});

test("a pathless hosted stub may be created by the send path", async () => {
  const store = useInboxStore.getState();
  const { stubId } = store.beginOptimisticSession({
    agentType: HOSTED_AGENT_TYPE,
    deferCreate: true,
    create: (sid) => useInboxStore.getState().createSessionFromStub(sid),
  });
  await useInboxStore.getState().ensureSessionCreated(stubId);
  const create = calls.find((c) => c.action === "createSession");
  expect(create?.args[0]).toEqual({ agent_type: HOSTED_AGENT_TYPE, session_id: stubId });
});

// One rule for a hosted create that did not land, shared by the compose popup,
// the palette, the context composer and the phone: only a refused create (the
// server said no for good) marks its bubble failed (the retry affordance) and
// reports the reason. A parked create, and one rejected by the dispatch
// binding changing under it (every cold start on the phone), is still queued
// and delivers on its own, so its bubble stays as it is.
test("a hosted create still on its way leaves the bubble; a refused one marks it and reports", async () => {
  const store = useInboxStore.getState();
  const convId = "stub_settle_case";
  const parkedId = store.addOptimisticMessage(convId, "parked start");
  const staleId = store.addOptimisticMessage(convId, "stale binding start");
  const refusedId = store.addOptimisticMessage(convId, "refused start");
  const reports: string[] = [];
  settleHostedStart(Promise.reject(new DispatchNotWiredError("createSession", true)), convId, parkedId, (m) => reports.push(m));
  settleHostedStart(Promise.reject(new StaleDispatchBindingError()), convId, staleId, (m) => reports.push(m));
  settleHostedStart(Promise.reject(new Error("Uncaught Error: over the plan")), convId, refusedId, (m) => reports.push(m));
  await settle();
  const failed = (id: string) => (useInboxStore.getState().pendingMessages[convId] ?? []).find((m: any) => m._clientId === id)?._isFailed === true;
  expect(failed(parkedId)).toBe(false);
  expect(failed(staleId)).toBe(false);
  expect(failed(refusedId)).toBe(true);
  expect(reports).toEqual(["Uncaught Error: over the plan"]);
});
