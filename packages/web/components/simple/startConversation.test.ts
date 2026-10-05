// The simple lane's start goes through the store's createSession action, so
// the hosted create rides the outbox like every other new session and its
// server half is the classified CREATE (storeActionMutations.guard).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { useInboxStore } from "../../store/inboxStore";
import { startConversationWith } from "./startConversation";

const owner = {};
const calls: Array<{ action: string; args: any[] }> = [];
beforeAll(() => useInboxStore.getState()._setDispatch(async (action, args) => {
  calls.push({ action, args });
  return action === "createSession" ? "conv_hosted_1" : null;
}, { owner }));
afterAll(() => useInboxStore.getState()._clearDispatch(owner));

test("a start dispatches createSession with the hosted agent and the first message", async () => {
  const stubId = startConversationWith("What's on tomorrow?");
  await new Promise((r) => setTimeout(r, 20));
  const create = calls.find((c) => c.action === "createSession");
  expect(create?.args[0]).toMatchObject({
    agent_type: HOSTED_AGENT_TYPE,
    session_id: stubId,
    first_message: "What's on tomorrow?",
  });
  expect(typeof create?.args[0].first_message_client_id).toBe("string");
  expect(create?.args[0].first_message_client_id.length).toBeGreaterThan(0);
});
