import { describe, expect, test } from "bun:test";
import { planGatedSnippets } from "./gatedSnippets";

describe("planGatedSnippets", () => {
  test("first observation applies every reported slug that disagrees with the machine", () => {
    const plan = planGatedSnippets(undefined, { chat: false, calls: true }, { chat_enabled: true });
    expect(plan.actions).toEqual([
      { slug: "chat", enable: false },
      { slug: "calls", enable: true },
    ]);
    expect(plan.next).toEqual({ chat: false, calls: true });
  });

  test("a report identical to the last one is a no-op, even when the local flag disagrees", () => {
    // Human hand-disabled chat after the team turned it on: leave it alone.
    const plan = planGatedSnippets({ chat: true, calls: false }, { chat: true, calls: false }, { chat_enabled: false });
    expect(plan.actions).toEqual([]);
    expect(plan.next).toEqual({ chat: true, calls: false });
  });

  test("a flip acts, and a slug already in the wanted state is recorded without an action", () => {
    const plan = planGatedSnippets({ chat: true, calls: false }, { chat: false, calls: true }, { chat_enabled: false, calls_enabled: false });
    expect(plan.actions).toEqual([{ slug: "calls", enable: true }]);
    expect(plan.next).toEqual({ chat: false, calls: true });
  });

  test("an unknown slug is recorded but never acted on", () => {
    const plan = planGatedSnippets({}, { future: true }, {});
    expect(plan.actions).toEqual([]);
    expect(plan.next).toEqual({ future: true });
  });
});
