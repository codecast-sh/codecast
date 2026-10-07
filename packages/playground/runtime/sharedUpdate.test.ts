import { describe, expect, test } from "bun:test";
import type { SetSharedResult } from "../convex/runtime";
import { updateShared } from "./sharedUpdate";

/** A backend holding one shared value, with writes others make in between. */
function backend(start: { value: number; rev: number } | null, othersWrite: number[] = []) {
  let state = start;
  const calls: { value: number; base: number }[] = [];
  const write = async (value: number, base: number): Promise<SetSharedResult> => {
    const other = othersWrite.shift();
    if (other !== undefined) state = { value: other, rev: (state?.rev ?? 0) + 1 };
    calls.push({ value, base });
    const rev = state?.rev ?? 0;
    if (base !== rev) return { ok: false, value: state?.value ?? null, rev };
    state = { value, rev: rev + 1 };
    return { ok: true, rev: rev + 1 };
  };
  return { write, calls, get: () => state };
}

describe("updateShared", () => {
  test("applies the updater to the value as seen and writes it at that rev", async () => {
    const b = backend({ value: 4, rev: 2 });
    expect(await updateShared<number>({ value: 4, rev: 2 }, 0, (n) => n + 1, b.write, 8)).toBe(5);
    expect(b.calls).toEqual([{ value: 5, base: 2 }]);
  });

  test("starts from the initial value when nobody set it yet", async () => {
    const b = backend(null);
    expect(await updateShared<number>(null, 10, (n) => n * 2, b.write, 8)).toBe(20);
    expect(b.calls).toEqual([{ value: 20, base: 0 }]);
  });

  test("a conflict reruns the updater on what the other person wrote", async () => {
    const b = backend({ value: 1, rev: 1 }, [7]);
    expect(await updateShared<number>({ value: 1, rev: 1 }, 0, (n) => n + 1, b.write, 8)).toBe(8);
    expect(b.calls).toEqual([{ value: 2, base: 1 }, { value: 8, base: 2 }]);
    expect(b.get()).toEqual({ value: 8, rev: 3 });
  });

  test("gives up after the attempts run out", async () => {
    const b = backend({ value: 0, rev: 0 }, [1, 2, 3]);
    await expect(updateShared<number>({ value: 0, rev: 0 }, 0, (n) => n + 1, b.write, 3)).rejects.toThrow(/at once/);
    expect(b.calls).toHaveLength(3);
  });
});
