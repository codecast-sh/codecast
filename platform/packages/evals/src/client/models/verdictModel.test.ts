import { describe, expect, it } from "bun:test";
import type { BatchVerdict } from "../../contract";
import { baselineWords, separationTitle } from "./verdictModel";
import { cadenceItems } from "./wallModel";

const base = (cadence: string, n: number, reps = 6): NonNullable<BatchVerdict["baseline"]> => ({
  kind: "pooled",
  batches: Array.from({ length: n }, (_, i) => `2026-10-0${i + 1}T00:00:00.000Z`),
  reps,
  cadence,
  skipped: [],
});

describe("a cadence baseline in words", () => {
  it("counts a nightly cadence in nights", () => {
    const words = baselineWords(base("nightly", 3))!;
    expect(words.short).toBe("vs 3 nights");
    expect(words.long).toStartWith("3 nightly batches, night by night per freeze: ");
    expect(baselineWords(base("nightly", 1))!.short).toBe("vs 1 night");
    expect(baselineWords(base("nightly", 2, 0))).toEqual({ short: "nightly baseline building", long: "the nightly baseline has no graded reps yet" });
  });

  it("counts any other cadence in its own batches, never in nights", () => {
    const words = baselineWords(base("scenario", 2))!;
    expect(words.short).toBe("vs 2 scenario batches");
    expect(words.long).toStartWith("2 scenario batches, batch by batch per freeze: ");
    expect(baselineWords(base("full", 1))!.short).toBe("vs 1 full batch");
    expect(baselineWords(base("full", 2, 0))).toEqual({ short: "full baseline building", long: "the full baseline has no graded reps yet" });
    const title = separationTitle({ baseline: base("full", 2), separation: { kind: "not-separated", p: 0.4 } })!;
    expect(title).toStartWith("Batch by batch per freeze: ");
    expect(title).not.toContain("ight");
  });
});

describe("the cadence toggle's items", () => {
  it("offers codecast's filters by default, a host's own in their place, and none for a host with none", () => {
    expect(cadenceItems("All").map((c) => c.key)).toEqual(["all", "nightly", "named"]);
    expect(cadenceItems("All batches", [{ key: "full", label: "Full runs" }])).toEqual([
      { key: "all", label: "All batches" },
      { key: "full", label: "Full runs" },
    ]);
    expect(cadenceItems("All", [])).toEqual([]);
  });
});
