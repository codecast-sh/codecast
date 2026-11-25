import { afterAll, beforeAll, expect, it } from "bun:test";
import { parseDecisionAnswer } from "@codecast/shared/contracts";
import { useInboxStore } from "../inboxStore";

// A person goes back to a decision they answered and picks again: the row takes
// the new answer and the session gets one more message naming the answer it
// replaces. Picking the answer already on record sends nothing, and what a
// later message cannot change (a gate on a run) stays as it was.
const s = () => useInboxStore.getState() as any;
const D = "f".repeat(32);
const owner = {};
const messages: Array<{ conv: string; content: string }> = [];
beforeAll(() => s()._setDispatch(async () => null, { owner }));
afterAll(() => s()._clearDispatch(owner));

const answered = (extra: Record<string, unknown> = {}) => ({
  _id: D, short_id: "sd-7", conversation_id: "c1", session_id: "s1", status: "answered", question: "Which store?",
  options: [{ label: "Postgres" }, { label: "SQLite" }], answer_index: 0, resolved_at: 1, created_at: 1, blocking: true,
  answered_by: { kind: "user", id: "u1" }, ...extra,
});

function seed(row: Record<string, unknown>) {
  messages.length = 0;
  useInboxStore.setState({
    currentUser: { _id: "u1" }, sessionDecisions: { [D]: row }, pending: {},
    addOptimisticMessage: () => "client-1",
    sendMessage: (conv: string, content: string) => { messages.push({ conv, content }); },
  } as any);
}
const flush = () => new Promise((r) => setTimeout(r, 0));

it("changing a blocking answer records it and tells the session what it replaces", async () => {
  seed(answered());
  s().answerDecision(D, { index: 1 });
  await flush();
  expect(s().sessionDecisions[D].answer_index).toBe(1);
  expect(messages).toHaveLength(1);
  const parsed = parseDecisionAnswer(messages[0].content);
  expect(parsed?.answer).toBe("SQLite");
  expect(parsed?.detail).toContain("Postgres");
});

it("picking the answer already on record sends nothing", async () => {
  seed(answered());
  s().answerDecision(D, { index: 0 });
  await flush();
  expect(messages).toHaveLength(0);
});

it("a gate on a run keeps its answer", async () => {
  seed(answered({ workflow_run_id: "run1" }));
  s().answerDecision(D, { index: 1 });
  await flush();
  expect(s().sessionDecisions[D].answer_index).toBe(0);
  expect(messages).toHaveLength(0);
});
