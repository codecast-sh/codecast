import { describe, expect, test } from "bun:test";
import { CLIMB_DEFAULT_BUDGET, changedCases, hypothesisVerdict, commandPaths, detectableAt, experimentWeeks, globMatch, halve, levelCanSee, levelNoise, protectedTouches, readClimbCard, separates } from "./climb";

const goal = { short_id: "in-9", levels: [{ env: "u/unit", level: "L0" as const }, { env: "u/replay", level: "L2" as const }, { env: "u/exp", level: "L4" as const }] };
const card = (over: Record<string, unknown> = {}) => ({ goal: "in-9", target: "matched to opted in", levels: [{ env: "u/replay", plausible_effect: 0.03 }], ...over });

describe("readClimbCard", () => {
  test("the budget and candidate count are held to the goal's or the default, whatever the card asks", () => {
    const r = readClimbCard(card({ budget: { usd: 900, runs: 9000 }, candidates: 40 }), goal);
    if (!r.ok) throw new Error(r.error);
    expect(r.card.budget).toEqual(CLIMB_DEFAULT_BUDGET);
    expect(r.card.candidates).toBe(8);
    expect(r.notes.join(" ")).toContain("budget held to the default");
    const g = readClimbCard(card({ budget: { usd: 900 } }), { ...goal, budget: { usd: 400, runs: 100 } });
    expect(g.ok && g.card.budget).toEqual({ usd: 400, runs: 100 });
    const lower = readClimbCard(card({ budget: { usd: 5, runs: 10 } }), goal);
    expect(lower.ok && lower.card.budget).toEqual({ usd: 5, runs: 10 });
  });

  test("nonsense numbers fall back to the cap, never past it", () => {
    for (const b of [{ usd: NaN, runs: -3 }, { usd: "1e9", runs: "lots" }, { usd: Infinity, runs: 0 }, null]) {
      const r = readClimbCard(card({ budget: b, candidates: -1 }), goal);
      expect(r.ok && r.card.budget).toEqual(CLIMB_DEFAULT_BUDGET);
      expect(r.ok && r.card.candidates).toBe(5);
    }
  });

  test("only the goal's own L0..L3 environments, each scoring one with a plausible effect", () => {
    expect(readClimbCard(card({ levels: [{ env: "u/other", plausible_effect: 0.03 }] }), goal)).toMatchObject({ ok: false, error: expect.stringContaining("not one of in-9's") });
    expect(readClimbCard(card({ levels: [{ env: "u/exp", plausible_effect: 0.03 }] }), goal)).toMatchObject({ ok: false, error: expect.stringContaining("L4") });
    expect(readClimbCard(card({ levels: [{ env: "u/replay" }] }), goal)).toMatchObject({ ok: false, error: expect.stringContaining("plausible effect") });
    expect(readClimbCard(card({ levels: [{ env: "u/unit" }] }), goal)).toMatchObject({ ok: false, error: expect.stringContaining("only L0") });
    expect(readClimbCard(card({ levels: [{ env: "u/replay", level: "L1", plausible_effect: 0.03 }] }), goal)).toMatchObject({ ok: false });
    expect(readClimbCard(card({ target: " " }), goal)).toMatchObject({ ok: false });
  });
});

describe("what a level can see", () => {
  const run = (shift: number, wide: number) => Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, score: 0.5 + ((((i * 7 + shift * 13) % 9) - 4) * wide) }));
  test("a quiet level sees a small change; a noisy one is refused, and a claimed big effect cannot argue it back in", () => {
    const quiet = levelNoise("L2", [run(1, 0.005), run(2, 0.005), run(3, 0.005)]);
    const loud = levelNoise("L2", [run(1, 0.1), run(2, 0.1), run(3, 0.1)]);
    if ("error" in quiet || "error" in loud) throw new Error("noise");
    expect(levelCanSee("L2", quiet, 0.03).ok).toBe(true);
    expect(levelCanSee("L2", loud, 0.03).ok).toBe(false);
    expect(levelCanSee("L2", loud, 5).ok).toBe(false);
    expect(levelCanSee("L2", loud, 5).why).toContain("held to 0.100");
  });
  test("one base run cannot show the spread unless the runner reports it; L0 needs none", () => {
    expect(levelNoise("L2", [run(1, 0.01)])).toHaveProperty("error");
    expect(levelNoise("L2", [run(1, 0.01)], 0.004)).toMatchObject({ runs: 1 });
    expect(levelNoise("L0", [run(1, 0)])).toEqual({ runs: 1, se: 0, mde: 0 });
  });
});

describe("separates", () => {
  const base = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, score: 0.5 + (i % 3) * 0.01 }));
  test("keeps a delta whose lower bound clears 0 and the A/A band; refuses noise, losses and lost cases", () => {
    const better = base.map((c, i) => ({ ...c, score: c.score + 0.05 + (i % 2) * 0.004 }));
    expect(separates("L2", base, better, { se: 0.005 }).keep).toBe(true);
    expect(separates("L2", base, better, { se: 0.05 }).why).toContain("A/A band");
    expect(separates("L2", base, better.slice(1), { se: 0.005 }).why).toContain("missing");
    expect(separates("L2", base, base.map((c, i) => ({ ...c, score: c.score + (i % 2 ? 0.01 : -0.01) })), { se: 0.001 }).keep).toBe(false);
  });
  test("L0: any case worse or lost fails", () => {
    const ok = base.map((c) => ({ ...c, score: 1 }));
    expect(separates("L0", ok, ok, { se: 0 }).keep).toBe(true);
    expect(separates("L0", ok, ok.map((c, i) => (i === 3 ? { ...c, score: 0 } : c)), { se: 0 }).keep).toBe(false);
    expect(separates("L0", ok, ok.slice(1), { se: 0 }).keep).toBe(false);
  });
  test("halving keeps the better half, at least one", () => {
    expect(halve([{ delta: 1 }, { delta: 3 }, { delta: 2 }]).map((x) => x.delta)).toEqual([3, 2]);
    expect(halve([{ delta: 1 }])).toHaveLength(1);
  });
});

describe("what a candidate may touch", () => {
  test("globs, the env's protects and .codecast always", () => {
    expect(globMatch("evals/**", "evals/graders/pitch.ts")).toBe(true);
    expect(globMatch("evals/*.ts", "evals/graders/pitch.ts")).toBe(false);
    expect(protectedTouches([".codecast/envs.toml", "src/prompt.md", "evals/held/x.json"], ["evals/held/**"])).toEqual([".codecast/envs.toml", "evals/held/x.json"]);
  });
});

describe("commandPaths", () => {
  test("the repo files a command starts, under any cd it makes, and nothing that is a flag, a variable or a placeholder", () => {
    expect(commandPaths("bun {root}/evals/run.mjs fake/floor {split} {out}")).toEqual(["evals/run.mjs", "fake/floor"]);
    expect(commandPaths("cd outreach && bun run scripts/env.ts --out {out}")).toEqual(["scripts/env.ts", "outreach/scripts/env.ts"]);
    expect(commandPaths("echo $HOME/x /abs/y")).toEqual([]);
    expect(commandPaths("cd web && bun run eval")).toEqual(["package.json", "web/package.json"]);
    expect(commandPaths("npm test && make gate")).toEqual(["package.json", "Makefile"]);
    expect(commandPaths("bash /repo/backend/scripts/proof.sh -- x", "/repo")).toEqual(["backend/scripts/proof.sh"]);
  });
});

describe("common-mode noise", () => {
  test("runs that shift every case together widen the level's MDE even when pairing cancels the shift", () => {
    const run = (shift: number) => Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, score: 0.5 + shift + (i % 3) * 0.001 }));
    const still = levelNoise("L2", [run(0), run(0), run(0)]);
    const drift = levelNoise("L2", [run(0.03), run(-0.03), run(0.03)]);
    if ("error" in still || "error" in drift) throw new Error("noise");
    expect(still.mde).toBeLessThan(0.001);
    expect(drift.mde).toBeGreaterThan(0.05);
  });
});

describe("sizing a production test from the reading's own MDE", () => {
  test("at the reading's own four weeks a count reads back its MDE, and longer tests detect less", () => {
    for (const noise of ["poisson:1.75", "ratio:mw-14"]) {
      expect(detectableAt(1.747, noise, 4)!).toBeCloseTo(1.747, 3);
      expect(detectableAt(1.747, noise, 16)!).toBeLessThan(detectableAt(1.747, noise, 8)!);
    }
    // A measured spread scales with the square root of the time.
    expect(detectableAt(0.4, "aa:77", 16)!).toBeCloseTo(0.2, 6);
    expect(detectableAt(null, "poisson", 4)).toBeNull();
  });
  test("weeks for a lift: the fewest that detect it, null past half a year", () => {
    const w = experimentWeeks(0.52, "poisson", 0.52);
    expect(w).toBe(4);
    expect(experimentWeeks(0.52, "poisson", 0.3)!).toBeGreaterThan(4);
    expect(experimentWeeks(1.747, "poisson:1.75", 0.15)).toBeNull();
    expect(experimentWeeks(null, "poisson", 0.5)).toBeNull();
  });
});

describe("what a climb learned about its card", () => {
  test("a case moved only past the base's own run-to-run spread", () => {
    const runs = [[{ id: "a", score: 0.5 }, { id: "b", score: 0.5 }], [{ id: "a", score: 0.52 }, { id: "b", score: 0.5 }]];
    expect(changedCases(runs, [{ id: "a", score: 0.53 }, { id: "b", score: 0.6 }, { id: "z", score: 1 }])).toEqual({ changed: 1, of: 2 });
  });
  test("held at half the plausible effect or more, weaker down to a sixth, refuted under that or with nothing separated", () => {
    expect(hypothesisVerdict(0.02, 0.03)).toBe("held");
    expect(hypothesisVerdict(0.006, 0.03)).toBe("weaker");
    expect(hypothesisVerdict(0.0037, 0.03)).toBe("refuted");
    expect(hypothesisVerdict(null, 0.03)).toBe("refuted");
  });
});

describe("the paired floor", () => {
  test("on runs that agree, a paired level's floor is the moved change times sqrt(share / n), far under the unpaired SE", () => {
    const run = Array.from({ length: 691 }, (_, i) => ({ id: `d${i}`, score: 0.25 + ((i * 37) % 100) / 200 }));
    const unpaired = levelNoise("L2", [run, run, run]);
    const paired = levelNoise("L2", [run, run, run], undefined, undefined, { share: 19 / 691, rms: 0.17, from: "history" });
    if ("error" in unpaired || "error" in paired) throw new Error("noise");
    expect(unpaired.by).toBe("cases");
    expect(unpaired.mde).toBeGreaterThan(0.01);
    expect(paired.by).toBe("paired");
    expect(paired.mde).toBeCloseTo(2.8 * 0.17 * Math.sqrt(19 / 691 / 691), 3);
    // A declared MDE above both still rules.
    const declared = levelNoise("L2", [run, run, run], undefined, 0.02, { share: 0.02, from: "card" });
    expect(!("error" in declared) && declared.by).toBe("declared");
  });
  test("the card's moved_share is a share", () => {
    expect(readClimbCard(card({ levels: [{ env: "u/replay", plausible_effect: 0.03, moved_share: 0.02 }] }), goal)).toMatchObject({ ok: true });
    expect(readClimbCard(card({ levels: [{ env: "u/replay", plausible_effect: 0.03, moved_share: 2 }] }), goal)).toMatchObject({ ok: false });
  });
});

describe("the card's stack", () => {
  test("names a pending change by ref or patch, with its task id", () => {
    expect(readClimbCard(card({ stack: { ref: "pending/refill", task: "CT-96939" } }), goal)).toMatchObject({ ok: true, card: { stack: { ref: "pending/refill", task: "ct-96939" } } });
    expect(readClimbCard(card({ stack: { patch: "/tmp/refill.patch" } }), goal)).toMatchObject({ ok: true, card: { stack: { patch: "/tmp/refill.patch" } } });
    expect(readClimbCard(card({ stack: {} }), goal)).toMatchObject({ ok: false });
    expect(readClimbCard(card({ stack: { ref: "x", task: "in-9" } }), goal)).toMatchObject({ ok: false });
  });
});
