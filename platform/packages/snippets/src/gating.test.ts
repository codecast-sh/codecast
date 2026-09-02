// Ported from codecast packages/cli/src/gatedSnippets.test.ts. The donor
// resolved slugs against its catalog to read the machine's enabled flag; here
// that lookup is the injected predicate.

import { describe, expect, test } from "bun:test";
import { planGatedSnippets } from "./gating";

const machine = (flags: Record<string, boolean>) => (slug: string) =>
  slug in flags ? flags[slug] : undefined;

describe("planGatedSnippets", () => {
  test("first observation applies every reported slug that disagrees with the machine", () => {
    const plan = planGatedSnippets(undefined, { chat: false, calls: true }, machine({ chat: true, calls: false }));
    expect(plan.actions).toEqual([
      { slug: "chat", enable: false },
      { slug: "calls", enable: true },
    ]);
    expect(plan.next).toEqual({ chat: false, calls: true });
  });

  test("a report identical to the last one is a no-op, even when the local flag disagrees", () => {
    // Human hand-disabled chat after the team turned it on: leave it alone.
    const plan = planGatedSnippets(
      { chat: true, calls: false },
      { chat: true, calls: false },
      machine({ chat: false, calls: false }),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.next).toEqual({ chat: true, calls: false });
  });

  test("a flip acts, and a slug already in the wanted state is recorded without an action", () => {
    const plan = planGatedSnippets(
      { chat: true, calls: false },
      { chat: false, calls: true },
      machine({ chat: false, calls: false }),
    );
    expect(plan.actions).toEqual([{ slug: "calls", enable: true }]);
    expect(plan.next).toEqual({ chat: false, calls: true });
  });

  test("an unknown slug is recorded but never acted on", () => {
    const plan = planGatedSnippets({}, { future: true }, machine({}));
    expect(plan.actions).toEqual([]);
    expect(plan.next).toEqual({ future: true });
  });
});
