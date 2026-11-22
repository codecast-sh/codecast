import { afterAll, beforeAll, expect, it } from "bun:test";
import { parseDecisionAnswer } from "@codecast/shared/contracts";
import { useInboxStore } from "../inboxStore";
import { answerTimeline } from "../../lib/decisions/decisionHistory";

// A settled decision a person changes: the row takes the new answer as the next revision (the dispatch guard reads it),
// and the agent hears the new answer with the one it replaces.
const s = () => useInboxStore.getState() as any;
const D = "f".repeat(32);
const sent: unknown[] = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (...args: unknown[]) => { sent.push(args); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));

const row = (over: Record<string, unknown>) => ({ _id: D, short_id: "sd-7", conversation_id: "c1", question: "Name sessions by the first message?", options: [{ label: "Yes" }, { label: "No" }], created_at: 1, blocking: true, ...over });

it("changing a blocking answer bumps the revision and tells the agent what it replaces", async () => {
  useInboxStore.setState({ currentUser: { _id: "u1" }, sessionDecisions: { [D]: row({ status: "answered", answer_index: 0, resolved_at: 5, answered_by: { kind: "role", id: "r1" } }) }, pending: {} } as any);
  let content = "";
  const realSend = s().sendMessage;
  useInboxStore.setState({ sendMessage: (_c: string, text: string) => { content = text; } } as any);
  s().answerDecision(D, { index: 1 });
  await new Promise((r) => setTimeout(r, 0));
  useInboxStore.setState({ sendMessage: realSend } as any);
  expect(s().sessionDecisions[D].answer_index).toBe(1);
  expect(s().sessionDecisions[D].answer_revision).toBe(1);
  const parsed = parseDecisionAnswer(content);
  expect(parsed?.answer).toBe("No");
  expect(parsed?.detail).toContain("(Yes)");
});

it("a decision a run gate settled stays settled", () => {
  useInboxStore.setState({ sessionDecisions: { [D]: row({ status: "answered", answer_index: 0, workflow_run_id: "w1" }) } } as any);
  s().answerDecision(D, { index: 1 });
  expect(s().sessionDecisions[D].answer_index).toBe(0);
  expect(s().sessionDecisions[D].answer_revision).toBeUndefined();
});

it("the timeline lists the answer on record first, then each it replaced", () => {
  const t = answerTimeline(row({ status: "answered", answer_index: 1, resolved_at: 9, answer_history: [
    { status: "dismissed", resolved_at: 2, replaced_at: 3, replaced_by: "u1" },
    { status: "answered", answer_index: 0, resolved_at: 3, replaced_at: 9, replaced_by: "u2" },
  ] }) as any);
  expect(t.map((e) => e.label)).toEqual(["No", "Yes", "Dismissed"]);
  expect(t[0].replacedAt).toBeNull();
  expect(t[1].replacedBy).toBe("u2");
});
