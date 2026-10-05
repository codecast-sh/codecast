import { describe, expect, test } from "bun:test";
import { answerView, buildDecisionAnswer, moveInOrder, togglePicked } from "../decisionAnswer";

const opts = [{ label: "A" }, { label: "B" }, { label: "C" }] as any;

describe("decisionAnswer", () => {
  test("view drops picks past an edited option list and defaults the order", () => {
    const v = answerView({ options: opts.slice(0, 2), kind: "multi" }, { picked: [0, 2], order: [2, 1, 0] });
    expect(v.picked).toEqual([0]);
    expect(v.order).toEqual([0, 1]);
  });

  test("multi needs a pick and sends sorted indexes", () => {
    const d = { options: opts, kind: "multi" as const };
    expect(buildDecisionAnswer(d, answerView(d, {}))).toEqual({ error: "Pick at least one option." });
    const draft = togglePicked(togglePicked({}, 2), 0);
    expect(buildDecisionAnswer(d, answerView(d, draft))).toEqual({ input: { json: [0, 2] } });
    expect(togglePicked(draft, 2)).toEqual({ picked: [0] });
  });

  test("rank sends the reader's order; moves stop at the edges", () => {
    const d = { options: opts, kind: "rank" as const };
    const order = moveInOrder([0, 1, 2], 2, -1)!;
    expect(order).toEqual([0, 2, 1]);
    expect(moveInOrder(order, 0, -1)).toBeNull();
    expect(buildDecisionAnswer(d, answerView(d, { order }))).toEqual({ input: { json: [0, 2, 1] } });
  });

  test("form validates required and numeric fields", () => {
    const d = {
      options: [],
      kind: "form" as const,
      form: { fields: [{ key: "n", label: "Count", type: "number" as const }, { key: "ok", label: "OK", type: "bool" as const }] },
    };
    expect(buildDecisionAnswer(d, answerView(d, {}))).toEqual({ error: "Count is required." });
    expect(buildDecisionAnswer(d, answerView(d, { values: { n: "x" } }))).toEqual({ error: "Count must be a number." });
    expect(buildDecisionAnswer(d, answerView(d, { values: { n: "3" } }))).toEqual({ input: { json: { n: 3, ok: false } } });
  });

  test("single has no submit", () => {
    expect(buildDecisionAnswer({ options: opts }, answerView({ options: opts }, {}))).toBeNull();
  });
});
