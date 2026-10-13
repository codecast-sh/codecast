import { describe, expect, test } from "bun:test";
import { closeStoppedLedger, newApproachLedger } from "../trialStopLedgers";
import { failedAtStation } from "@codecast/shared/contracts/causeHistory";

describe("a stopped trial run's acts", () => {
  test("a new approach is one run from main that carries the station's report", () => {
    const l = newApproachLedger({ problem: "Callers keep pitching", station: "Build", cost: { avgUsd: 36.6, runs: 4, scope: "project" } });
    expect(l.confirm).toBe("Start the run");
    expect(l.figures.map((f) => f.value)).toEqual(["1", "~$37"]);
    expect(l.rows.find((r) => r.k === "Carries")?.v).toBe("Build's report: why it did not work");
    expect(l.rows.find((r) => r.k === "From")?.v).toBe("main");
  });

  test("past the trial's run limit nothing starts, and the confirm says why (ct-59445: 115 of 115 runs used)", () => {
    const l = newApproachLedger({ problem: "p", station: "Build", blocked: "115 of 115 runs used" });
    expect(l.blocked).toBe("115 of 115 runs used");
    expect(l.figures[0]).toEqual({ value: "0", label: "runs start now", tone: "warn" });
  });

  test("an unpriced new approach says so instead of a number", () => {
    expect(newApproachLedger({ problem: "p", station: "Build" }).figures[1]).toEqual({ value: "$?", label: "not priced", tone: "warn" });
  });

  test("closing names the findings that close with it, all and in 7d (ct-59445: 7 in all, 3 in 7d)", () => {
    const l = closeStoppedLedger({ problem: "Callers keep pitching", findings: 7, week: 3 });
    expect(l.shift).toEqual(["Open", "Dropped"]);
    expect(l.figures).toEqual([{ value: "7", label: "findings close with it", tone: "warn" }, { value: "3", label: "in 7d" }]);
    expect(closeStoppedLedger({ problem: "p", findings: 1, week: null }).figures).toEqual([{ value: "1", label: "finding closes with it", tone: "warn" }]);
  });

  test("the station a run gave up at is its last completed failure step", () => {
    // ct-59445's run th7a02x: build completed (no report), failed_at_build completed, exit.
    expect(failedAtStation([{ node_id: "build", status: "completed" }, { node_id: "failed_at_build", status: "completed" }, { node_id: "exit", status: "completed" }])).toBe("build");
    expect(failedAtStation([{ node_id: "failed_at_prove", status: "pending" }])).toBeNull();
    expect(failedAtStation(undefined)).toBeNull();
  });
});
