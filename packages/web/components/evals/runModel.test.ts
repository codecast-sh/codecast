import { describe, expect, it } from "bun:test";
import type { RunRow } from "@codecast/shared/contracts/evalsApi";
import { samePromptSpread } from "./runModel";

const rep = (id: string, batch: string, score: number | null, extra: Partial<RunRow> = {}): RunRow =>
  ({ id, freezeId: "f1", batch, score, status: score === null ? "crash" : score >= 0.7 ? "pass" : "fail", promptSha: "p1", cadence: "nightly", ...extra }) as RunRow;

describe("samePromptSpread", () => {
  // The title freeze of 2026-10-04: one promptSha on four nights, scores 0.45 to 0.85.
  const runs = [
    rep("a1", "n1", 0.85),
    rep("a2", "n1", 0.75),
    rep("b1", "n2", 0.45),
    rep("c1", "n3", 0.8),
    rep("d1", "n4", 0.55),
    rep("d2", "n4", null),
    rep("x1", "n4", 0.1, { promptSha: "p2" }),
    rep("y1", "probe", 0.0, { cadence: "bisect" }),
    rep("z1", "n2", 0.2, { freezeId: "f2" }),
  ];

  it("weighs a rep against its freeze's graded reps under the same prompt, across batches", () => {
    expect(samePromptSpread(runs[5 - 1]!, runs)).toEqual({ batches: 4, reps: 5, passed: 3, min: 0.45, max: 0.85 });
  });

  it("says nothing for an unknown prompt or a prompt seen in one batch only", () => {
    expect(samePromptSpread({ id: "q", freezeId: "f1", promptSha: null }, runs)).toBeNull();
    expect(samePromptSpread({ id: "q", freezeId: "f1", promptSha: "p2" }, runs)).toBeNull();
  });
});
