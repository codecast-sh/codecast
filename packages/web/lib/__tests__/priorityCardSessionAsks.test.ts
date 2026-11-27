import { describe, expect, test } from "bun:test";
import { pendingDecisionConvIds } from "../decisionQueue";
import { sessionAsk } from "../../hooks/useDecisionQueue";
import { assignDecisions, escalateDecisions, passDecisions } from "../decisions/decisionBulk";
import { useInboxStore } from "../../store/inboxStore";

// A priority card sits in one of its person's sessions without being that
// session's question (THE RULE on isPriorityCard, shared/contracts/priorityCard.ts):
// it neither lifts the session as asking nor docks in it, and no bulk hand-off takes it.
const row = (id: string, extra: Record<string, any> = {}) => ({
  _id: id, conversation_id: "c1", session_id: "s", question: id, options: [{ label: "A" }],
  blocking: true, status: "pending" as const, created_at: 1, asked_user_ids: ["me"], ...extra,
});

describe("a priority card is not its session's ask", () => {
  test("it lifts no session; the session's own ask still does", () => {
    expect([...pendingDecisionConvIds({ a: row("a", { priority_card: { v: 1 } }) } as any, "me")]).toEqual([]);
    expect([...pendingDecisionConvIds({ b: row("b") } as any, "me")]).toEqual(["c1"]);
  });

  test("it is not among the session's docked asks", () => {
    expect(sessionAsk(row("a", { priority_card: { v: 1 } }), "c1")).toBe(false);
    expect(sessionAsk(row("b"), "c1")).toBe(true);
  });

  test("a bulk pass, assign or escalate leaves it with its person", () => {
    const calls: string[] = [];
    const real = useInboxStore.getState();
    useInboxStore.setState({ passDecision: ((id: string) => calls.push(`pass:${id}`)) as any, escalateDecision: ((id: string) => calls.push(`up:${id}`)) as any });
    try {
      const rows = [row("card", { priority_card: { v: 1 } }), row("ask")] as any;
      expect(passDecisions(rows, { kind: "user", id: "u2" }, "note")).toBe(1);
      expect(assignDecisions(rows, { kind: "user", id: "u2" })).toBe(1);
      expect(escalateDecisions(rows, "why")).toBe(1);
      expect(calls).toEqual(["pass:ask", "pass:ask", "up:ask"]);
    } finally {
      useInboxStore.setState({ passDecision: real.passDecision, escalateDecision: real.escalateDecision });
    }
  });
});
