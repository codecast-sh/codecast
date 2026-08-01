// What's worth testing in a force layout isn't where nodes land — that's the
// physics' business — but the contract around it: that the same vault lays out
// the same way twice, that ticks stream and then stop, that cancelling really
// cancels, and that a caller-supplied starting picture is honored.

import { test, expect, describe } from "bun:test";
import { runGraphLayout, seedPosition, type LayoutTick } from "../graphLayout";

/** Run a layout to completion, collecting every tick. */
function layout(input: Parameters<typeof runGraphLayout>[0]): Promise<LayoutTick[]> {
  return new Promise((resolve) => {
    const ticks: LayoutTick[] = [];
    runGraphLayout(input, (tick) => {
      ticks.push(tick);
      if (tick.done) resolve(ticks);
    });
  });
}

const chain = (n: number) => ({
  nodes: Array.from({ length: n }, (_, i) => `n${i}`),
  edges: Array.from({ length: n - 1 }, (_, i) => [`n${i}`, `n${i + 1}`] as [string, string]),
});

describe("seedPosition", () => {
  test("is deterministic and spreads nodes around a circle", () => {
    const first = seedPosition(0, 4);
    expect(seedPosition(0, 4)).toEqual(first);
    expect(first.y).toBeCloseTo(0);
    expect(first.x).toBeGreaterThan(0);

    const quarter = seedPosition(1, 4);
    expect(quarter.x).toBeCloseTo(0);
    expect(quarter.y).toBeGreaterThan(0);
  });

  test("radius grows with the node count so big vaults start spread out", () => {
    const small = seedPosition(0, 100);
    const large = seedPosition(0, 400);
    expect(large.x).toBeGreaterThan(small.x);
  });

  test("never places two nodes on the same point", () => {
    const seen = new Set(
      Array.from({ length: 50 }, (_, i) => {
        const p = seedPosition(i, 50);
        return `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
      }),
    );
    expect(seen.size).toBe(50);
  });
});

describe("runGraphLayout", () => {
  test("streams ticks and ends with exactly one done", async () => {
    const ticks = await layout({ ...chain(20), iterations: 60 });

    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.filter((t) => t.done)).toHaveLength(1);
    expect(ticks[ticks.length - 1].done).toBe(true);
    // Iterations advance monotonically and reach the total.
    expect(ticks.map((t) => t.iteration)).toEqual([15, 30, 45, 60]);
    expect(ticks[ticks.length - 1].positions).toHaveLength(40);
  });

  test("the same graph lays out identically twice", async () => {
    const [first, second] = await Promise.all([
      layout({ ...chain(25), iterations: 45 }),
      layout({ ...chain(25), iterations: 45 }),
    ]);

    expect([...first[first.length - 1].positions]).toEqual([...second[second.length - 1].positions]);
  });

  test("an empty graph completes immediately", async () => {
    const ticks = await layout({ nodes: [], edges: [] });

    expect(ticks).toHaveLength(1);
    expect(ticks[0].positions).toHaveLength(0);
  });

  test("a single node lands at the origin instead of dividing by zero", async () => {
    const ticks = await layout({ nodes: ["only"], edges: [] });

    expect([...ticks[0].positions]).toEqual([0, 0]);
    expect(ticks[0].done).toBe(true);
  });

  test("edges naming unknown nodes are skipped, not thrown on", async () => {
    const ticks = await layout({
      nodes: ["a", "b"],
      edges: [
        ["a", "b"],
        ["a", "ghost"],
        ["a", "a"],
      ],
      iterations: 15,
    });

    expect(ticks[ticks.length - 1].done).toBe(true);
  });

  test("cancelling stops further ticks", async () => {
    const seen: LayoutTick[] = [];
    const cancel = runGraphLayout({ ...chain(30), iterations: 300 }, (tick) => seen.push(tick));
    cancel();

    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toHaveLength(0);
  });

  test("supplied positions are used as the starting point", async () => {
    // Zero iterations means the first tick IS the seed, so this reads the
    // seeding decision directly.
    const given = new Float32Array([100, 200, -100, -200]);
    const ticks = await layout({ nodes: ["a", "b"], edges: [], iterations: 0, positions: given });

    expect([...ticks[0].positions]).toEqual([100, 200, -100, -200]);
  });

  test("without supplied positions the seed is the deterministic circle", async () => {
    const ticks = await layout({ nodes: ["a", "b"], edges: [], iterations: 0 });
    const a = seedPosition(0, 2);

    expect(ticks[0].positions[0]).toBeCloseTo(a.x, 3);
    expect(ticks[0].positions[1]).toBeCloseTo(a.y, 3);
  });

  test("a node missing from supplied positions falls back to the circle", async () => {
    // Only 'a' has a position; 'b' is left as NaN.
    const given = new Float32Array([50, 50, NaN, NaN]);
    const ticks = await layout({ nodes: ["a", "b"], edges: [], iterations: 0, positions: given });
    const b = seedPosition(1, 2);

    expect(ticks[0].positions[0]).toBe(50);
    expect(ticks[0].positions[2]).toBeCloseTo(b.x, 3);
  });
});
