import { describe, expect, test } from "bun:test";
import { closeStoppedLedger, limitsHit, newApproachLedger, raiseLimitsLedger, raisedLimits, trialRunLimit } from "../trialStopLedgers";
import { failedAtStation } from "@codecast/shared/contracts/causeHistory";

describe("a stopped trial run's acts", () => {
  test("a new approach is one run from main that carries the station's report", () => {
    const l = newApproachLedger({ problem: "Callers keep pitching", station: "Build", cost: { billedUsd: 36.6, listUsd: 0, runs: 4, scope: "project" } });
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

describe("raising a held trial's limits", () => {
  // A trial whose runs bill an API key: 115 of 115 runs, $1,480 billed against a $1,350 cap, a run ~$5.72 billed.
  const held = { runs: 115, maxRuns: 115, spent: 1480.23, cap: 1350, perRun: 657.74 / 115 };
  // Its runs on subscription accounts bill nothing: billed money under the cap holds nothing, however many runs it starts.
  const onLogins = { runs: 176, maxRuns: 200, spent: 511, cap: 1900, perRun: 0 };

  test("both limits hold it, so a raise of runs alone would start nothing", () => {
    expect(limitsHit(held)).toEqual({ runs: true, spend: true });
    expect(limitsHit({ ...held, maxRuns: 200, cap: 5000 })).toEqual({ runs: false, spend: false });
    expect(limitsHit(onLogins)).toEqual({ runs: false, spend: false });
  });

  test("the picked runs set the run limit and a spend cap with room for them", () => {
    expect(raisedLimits(held, 10)).toEqual({ maxRuns: 125, cap: 1550 });
    expect(raisedLimits({ ...held, cap: 9000 }, 25)).toEqual({ maxRuns: 140, cap: 9000 });
  });

  test("the review names both changes, what a run costs, and that it merges nothing", () => {
    const l = raiseLimitsLedger({ project: "AgentWatch Trial", limits: held, pick: "10" });
    const row = (k: string) => l.rows.find((r) => r.k === k)?.v;
    expect(row("Run limit")).toBe("115 → 125");
    expect(row("Billed cap")).toBe("$1,350 → $1,550");
    expect(row("A run bills")).toContain("$6");
    expect(row("Runs spend")).toBe("Subscription quota");
    expect(l.pick?.options).toEqual(["10", "25", "50"]);
    expect(l.figures[0]).toEqual({ value: "10", label: "more runs it may start" });
    expect(l.blocked).toBeUndefined();
  });
});

test("a rerun from main goes through the same review, and the trial's limit refuses it there", () => {
  const l = newApproachLedger({ problem: "p", station: "Build", blocked: "115 of 115 runs used", rerun: true });
  expect(l.name).toBe("Rerun from main");
  expect(l.blocked).toBe("115 of 115 runs used");
  expect(l.rows.map((r) => r.k)).not.toContain("Asks for");
  expect(trialRunLimit("115 of 115 runs used: the trial starts no more")).toBe("115 of 115 runs used");
  expect(trialRunLimit("billed $1900 of $1900: the cap is reached")).toBe("billed $1900 of $1900");
  expect(trialRunLimit("quota 91% on work (claude): runs wait for its reset in 1h")).toBe("quota 91% on work (claude)");
  expect(trialRunLimit("no dispatcher")).toBeNull();
});
