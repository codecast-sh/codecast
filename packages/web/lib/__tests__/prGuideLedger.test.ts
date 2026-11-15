import { describe, expect, it } from "bun:test";
import { estimateGuideCost, writeGuideLedger } from "../prGuideLedger";

const file = (chars: number) => ({ filename: "a.ts", additions: 10, deletions: 2, patch: "x".repeat(chars) });

describe("writeGuideLedger", () => {
  it("leads with the estimated cost, the files and the lines, names the model, and is a one-time act", () => {
    const l = writeGuideLedger({ number: 42, files: [file(2000), file(3000)] }, false);
    expect(l.subject).toBe("PR #42");
    expect(l.shift).toBeNull();
    expect(l.figures.map((f) => f.label)).toEqual(["estimated", "files", "lines changed"]);
    expect(l.figures[1].value).toBe("2");
    expect(l.figures[2].value).toBe("24");
    expect(l.rows.find((r) => r.k === "Model")?.v).toBe("Claude Sonnet 5.5");
    expect(l.confirm).toBe("Write guide");
    expect(writeGuideLedger({ number: 1, files: [file(10)] }, true).confirm).toBe("Rewrite guide");
  });
});

describe("estimateGuideCost", () => {
  it("grows with the diff and stops growing past what the request sends", () => {
    const small = estimateGuideCost([file(1_000)]);
    const big = estimateGuideCost([file(100_000)]);
    expect(big).toBeGreaterThan(small);
    expect(estimateGuideCost([file(1_000_000)])).toBe(estimateGuideCost([file(2_000_000)]));
    expect(small).toBeGreaterThan(0);
    expect(estimateGuideCost([file(1_000_000)])).toBeLessThan(1);
  });
});
