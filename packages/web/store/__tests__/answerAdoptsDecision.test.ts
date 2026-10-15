import { afterAll, beforeAll, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// A decision opened from its document (For you shows a trial's practice answer in its own session, which no queue row
// holds): answering it adopts the document's copy as the row, so the answer flips the card and reaches the server.
const s = () => useInboxStore.getState() as any;
const D = "e".repeat(32);
const sent: unknown[] = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (...args: unknown[]) => { sent.push(args); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));

it("answering a decision held only as its document adopts it and records the answer", () => {
  useInboxStore.setState({ currentUser: { _id: "u1" }, sessionDecisions: {}, pending: {} } as any);
  const decision = { _id: D, short_id: "sd-9", conversation_id: "c1", status: "pending", question: "What should the note say?", options: [{ label: "Name what waits" }, { label: "Keep it" }], created_at: 1, blocking: false, trial: true };
  s().syncTable("decisionDetails", [{ _id: D, decision, ladder: [], asked_users: [{ _id: "u1", name: "Ashot" }] }]);
  s().answerDecision(D, { index: 0 });
  expect(s().sessionDecisions[D]?.status).toBe("answered");
  expect(s().sessionDecisions[D]?.answer_index).toBe(0);
});
