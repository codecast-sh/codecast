import { afterAll, beforeAll, expect, it } from "bun:test";
import { APPROVE_FOR_SESSION, DENY } from "@codecast/shared/contracts/secrets";
import { useInboxStore } from "../inboxStore";
import { applyDispatchFailure, makeDispatchBinding } from "../../lib/dispatchBinding";

// An Approve on an Ask first read tells the agent only once the server took
// it: a refused one (no Touch ID grant) must not post "Decision: Approve" into
// the session, or the agent goes ahead on a secret it still cannot read.
const s = () => useInboxStore.getState() as any;
const actions: string[] = [];
let refuse = true;
const owner = {};
const refusal = new Error("[CONVEX M(dispatch:dispatch)] Uncaught Error: presence_required: confirm with Touch ID or your security key to approve this decision");
beforeAll(() => s()._setDispatch(makeDispatchBinding(async ({ action }) => {
  actions.push(action);
  if (action === "answerDecision" && refuse) throw refusal;
  return null;
}), { owner }));
afterAll(() => s()._clearDispatch(owner));

const flush = () => new Promise((r) => setTimeout(r, 20));
const ask = (id: string) => ({ _id: id, conversation_id: "c1", status: "pending", category: "access", question: "Deploy asks to use convex-admin-key", options: [{ label: APPROVE_FOR_SESSION }, { label: DENY }], created_at: 1, blocking: true });

it("holds an Approve's message until the server takes the answer", async () => {
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  useInboxStore.setState({ currentUser: { _id: "u1" }, sessionDecisions: { [A]: ask(A), [B]: ask(B) }, pending: {} } as any);

  s().answerDecision(A, { index: 0 });
  await flush();
  applyDispatchFailure("answerDecision", refusal, [A, { index: 0 }]);
  await flush();
  expect(actions).toEqual(["answerDecision"]);

  refuse = false;
  actions.length = 0;
  s().answerDecision(B, { index: 0, presence: "grant" });
  await flush();
  expect(actions).toEqual(["answerDecision", "sendMessage"]);
});

it("posts a Deny at once", async () => {
  const C = "c".repeat(32);
  useInboxStore.setState({ sessionDecisions: { [C]: ask(C) } } as any);
  actions.length = 0;
  s().answerDecision(C, { index: 1 });
  await flush();
  expect(actions).toContain("sendMessage");
});
