import { describe, expect, test } from "bun:test";
import { percentile, summarizeLatency, histogram } from "./stats.js";

describe("percentile (nearest rank)", () => {
  test("empty returns null", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  test("single sample answers every quantile", () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.99)).toBe(7);
  });

  test("1..100 gives p50 50, p90 90, p99 99, max 100", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 0.5)).toBe(50);
    expect(percentile(s, 0.9)).toBe(90);
    expect(percentile(s, 0.99)).toBe(99);
    expect(percentile(s, 1)).toBe(100);
  });
});

describe("summarizeLatency", () => {
  test("counts over1s at the 1000ms boundary and sorts unsorted input", () => {
    const s = summarizeLatency([999, 1000, 5, 1500, 20]);
    expect(s.n).toBe(5);
    expect(s.over1s).toBe(2);
    expect(s.max).toBe(1500);
    expect(s.p50).toBe(999);
  });

  test("empty input has null quantiles", () => {
    const s = summarizeLatency([]);
    expect(s).toEqual({ n: 0, p50: null, p90: null, p99: null, max: null, over1s: 0 });
  });
});

describe("histogram", () => {
  test("buckets by edges and reports mean and max per bucket", () => {
    const h = histogram([100, 2000, 2500, 7000, 30000], [2000, 5000, 10000, 20000]);
    expect(h.map((b) => b.label)).toEqual(["<2000ms", "2000-5000ms", "5000-10000ms", "10000-20000ms", ">=20000ms"]);
    expect(h.map((b) => b.count)).toEqual([1, 2, 1, 0, 1]);
    expect(h[1].meanMs).toBe(2250);
    expect(h[1].maxMs).toBe(2500);
    expect(h[3].meanMs).toBeNull();
    expect(h[3].maxMs).toBeNull();
  });
});
