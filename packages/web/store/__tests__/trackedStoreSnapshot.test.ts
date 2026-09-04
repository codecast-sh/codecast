import { describe, expect, it } from "bun:test";
import { resolveTrackedStoreSnapshot } from "../inboxStore";

describe("resolveTrackedStoreSnapshot", () => {
  it("reuses the prior snapshot when every watched value is unchanged", () => {
    let calls = 0;
    const deps = [
      (state: { a: number; b: number }) => { calls++; return state.a; },
      (state: { a: number; b: number }) => { calls++; return state.b; },
    ];
    const first = resolveTrackedStoreSnapshot({ a: 1, b: 2 }, deps, null);
    calls = 0;

    const second = resolveTrackedStoreSnapshot({ a: 1, b: 2 }, deps, first);

    expect(second).toBe(first);
    expect(calls).toBe(2);
  });

  it("returns the new state and values when a watched dependency changes", () => {
    const deps = [(state: { a: number; b: number }) => state.a, (state: { a: number; b: number }) => state.b];
    const first = resolveTrackedStoreSnapshot({ a: 1, b: 2 }, deps, null);
    const state = { a: 1, b: 3 };

    const second = resolveTrackedStoreSnapshot(state, deps, first);

    expect(second).not.toBe(first);
    expect(second).toEqual({ deps: [1, 3], state });
  });

  it("recomputes when the dependency count changes", () => {
    const state = { a: 1, b: 2 };
    const first = resolveTrackedStoreSnapshot(state, [(s) => s.a], null);

    const second = resolveTrackedStoreSnapshot(state, [(s) => s.a, (s) => s.b], first);

    expect(second).toEqual({ deps: [1, 2], state });
  });
});
