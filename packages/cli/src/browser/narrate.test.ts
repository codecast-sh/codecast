import { describe, expect, test } from "bun:test";
import { narrated } from "./narrate";

const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("narrated", () => {
  test("a fast step says nothing", async () => {
    const lines: string[] = [];
    const v = await narrated("loading the page", after(5, 42), { afterMs: 50, everyMs: 50, write: (l) => lines.push(l) });
    expect(v).toBe(42);
    expect(lines).toEqual([]);
  });

  test("a slow step names what it waits on, repeats with the time so far, and closes with the total", async () => {
    const lines: string[] = [];
    await narrated("attaching to the tab", after(130, null), { afterMs: 20, everyMs: 40, hint: "--no-wait skips this", write: (l) => lines.push(l) });
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toMatch(/^  still attaching to the tab \(\d+\.\d s\); --no-wait skips this$/);
    expect(lines[1]).toMatch(/^  still attaching to the tab \(\d+\.\d s\)$/);
    expect(lines[lines.length - 1]).toMatch(/^  finished attaching to the tab after \d+\.\d s$/);
  });

  test("a step that ends soon after its first line gets no closing line", async () => {
    const lines: string[] = [];
    // One tick at 100 ms, the step ends at 130 ms, and the closing line needs
    // twice afterMs: a wide gap either side, so a loaded machine cannot
    // reorder the three.
    await narrated("loading the page", after(130, null), { afterMs: 100, everyMs: 2000, write: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("  still loading the page");
  });

  test("a step that fails propagates its error and does not claim to have finished", async () => {
    const lines: string[] = [];
    const failing = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("tab gone")), 60));
    await expect(narrated("loading the page", failing, { afterMs: 20, everyMs: 20, write: (l) => lines.push(l) })).rejects.toThrow("tab gone");
    expect(lines.some((l) => l.startsWith("  still "))).toBe(true);
    expect(lines.some((l) => l.startsWith("  finished"))).toBe(false);
    // The clock stops with the failure: whatever it had said by then is all
    // it ever says.
    const spokenAtFailure = lines.length;
    await after(120, null);
    expect(lines).toHaveLength(spokenAtFailure);
  });
});
