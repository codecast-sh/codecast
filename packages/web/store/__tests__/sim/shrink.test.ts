// shrink.ts on synthetic predicates: no store, no subprocess.
import { describe, expect, test } from "bun:test";
import { SCRIPTED_ORDER_MARK, shrinkOrder, splitOrderLine } from "./shrink";

// Fails when the candidate holds every one of `need`, in order (as a delivery
// order bug needs its racing deliveries, and nothing else).
const needs = (need: number[]) => async (kept: number[]) => {
  let at = 0;
  for (const i of kept) if (i === need[at]) at++;
  return at === need.length;
};

describe("shrinkOrder", () => {
  test("ddmin finds exactly the entries the failure needs, and the result is 1-minimal", async () => {
    const seen: string[] = [];
    const r = await shrinkOrder(60, async (kept) => {
      seen.push(kept.join(","));
      return needs([3, 17, 42])(kept);
    });
    expect(r).toMatchObject({ reproduced: true, kept: [3, 17, 42], oneMinimal: true });
    expect(r.removed).toHaveLength(57);
    expect(r.removed).not.toContain(17);
    // Memoized: no candidate ran twice, and the count is every distinct one.
    expect(new Set(seen).size).toBe(seen.length);
    expect(r.attempts).toBe(seen.length);
    for (const i of r.kept) expect(await needs([3, 17, 42])(r.kept.filter((k) => k !== i))).toBe(false);
  });

  test("the prefix phase cuts the tail before ddmin starts", async () => {
    const progress: string[] = [];
    const r = await shrinkOrder(200, needs([0, 1, 2, 9]), { onProgress: (p) => progress.push(`${p.phase}:${p.best}`) });
    expect(r.kept).toEqual([0, 1, 2, 9]);
    // The first ddmin attempt already works on the 10-entry prefix.
    const firstDdmin = progress.findIndex((p) => p.startsWith("ddmin"));
    expect(progress[firstDdmin - 1]).toBe("prefix:10");
    expect(progress.at(-1)).toBe("ddmin:4");
  });

  test("an order the failure does not depend on shrinks to nothing", async () => {
    const r = await shrinkOrder(30, async () => true);
    expect(r).toMatchObject({ reproduced: true, kept: [], oneMinimal: true, attempts: 2 });
    expect(r.removed).toHaveLength(30);
  });

  test("a recorded order that does not fail again stops after one attempt", async () => {
    const r = await shrinkOrder(30, async () => false);
    expect(r).toMatchObject({ reproduced: false, attempts: 1, oneMinimal: false, removed: [] });
    expect(r.kept).toHaveLength(30);
  });

  test("the attempt cap stops with the best order so far, not 1-minimal", async () => {
    const r = await shrinkOrder(500, needs([10, 250, 251, 400]), { maxAttempts: 12 });
    expect(r.attempts).toBe(12);
    expect(r.oneMinimal).toBe(false);
    expect(r.reproduced).toBe(true);
    expect(await needs([10, 250, 251, 400])(r.kept)).toBe(true);
    expect(r.kept.length).toBeLessThan(500);
  });

  test("the time cap stops the same way", async () => {
    let t = 0;
    const r = await shrinkOrder(100, needs([5, 50]), { maxMs: 30, now: () => (t += 10) });
    expect(r.oneMinimal).toBe(false);
    expect(await needs([5, 50])(r.kept)).toBe(true);
  });
});

describe("splitOrderLine", () => {
  test("keeps a scripted run's drain mark apart from its channels", () => {
    expect(splitOrderLine([SCRIPTED_ORDER_MARK, "actor:ada", "conn:A"])).toEqual({ mark: SCRIPTED_ORDER_MARK, channels: ["actor:ada", "conn:A"] });
    expect(splitOrderLine(["actor:ada", "conn:A"])).toEqual({ mark: null, channels: ["actor:ada", "conn:A"] });
  });
});
