// The paired floor (climb/noise.ts, contracts/climb.ts levelNoise), from
// ct-97276's fifth run: "MDE 0.019 over 3 base runs (the case-level floor) is
// larger than the plausible 0.008". A climb compares paired; on a reproducible
// base the difference varies only on the cases a change moves. ct-97125's
// third climb read +0.0037 with a paired 95% interval of ±0.0021, moving 19
// of 691 cases by about 0.17.
import { describe, expect, test } from "bun:test";
import { levelCanSee, levelNoise } from "@codecast/shared/contracts/climb";
import { movedHistory, pairedTerms } from "./noise";

// 691 cases spread like real moments (a P(yes) from 0.25 to 0.75), each base run identical, as a cached grader makes them.
const score = (i: number) => Math.min(1, Math.max(0, 0.5 + ((((i * 37) % 100) - 50) / 100) * 0.5 + (((i * 7) % 9) - 4) * 0.005));
const base = Array.from({ length: 691 }, (_, k) => ({ id: `d${k + 1}`, score: score(k + 1) }));
const runs = [base, base, base];
// The earlier climb's change: 19 of 691 cases moved by 0.17.
const moved = base.map((c, k) => (k % 36 === 0 && k < 36 * 19 ? { ...c, score: Math.min(1, c.score + 0.17) } : c));

/** The registry as `/cli/envs/list` and `/cli/envs/get` serve it, for one env. */
const registry = (rows: Array<{ short_id: string; label: string; at: number; cases: unknown[]; version?: string; split?: string }>) => async (url: string, body: any) => {
  const all = rows.map((r) => ({ short_id: r.short_id, env: "u/replay", split: r.split ?? "dev", env_version: r.version ?? "v1", candidate: { label: r.label }, finished_at: r.at, cases: r.cases }));
  if (url === "/cli/envs/list") return all;
  if (url === "/cli/envs/get") return all.find((a) => a.short_id === body.id) ?? null;
  throw new Error(`unexpected ${url}`);
};

describe("a paired level's floor", () => {
  test("with nothing to say what share a change moves, the unpaired floor cannot see 0.008, and says the card's moved_share would pair it", () => {
    const noise = levelNoise("L2", runs);
    if ("error" in noise) throw new Error(noise.error);
    expect(noise.by).toBe("cases");
    expect(noise.mde).toBeGreaterThan(0.012);
    const see = levelCanSee("L2", noise, 0.008);
    expect(see.ok).toBe(false);
    expect(see.why).toContain("the card's moved_share would pair it");
  });

  test("an earlier climb filed in the registry gives the share and the moved change, and the level sees 0.008", async () => {
    const post = registry([
      { short_id: "ea-80", label: "base", at: 100, cases: base },
      { short_id: "ea-81", label: "cand-2", at: 200, cases: moved },
      // Another env version, and the held split, are not this level's history.
      { short_id: "ea-82", label: "cand-3", at: 300, cases: base.map((c) => ({ ...c, score: 0 })), version: "v0" },
      { short_id: "ea-83", label: "cand-4", at: 300, cases: base.map((c) => ({ ...c, score: 0 })), split: "held" },
    ]);
    const history = await movedHistory(post, "in-9", "u/replay", "v1");
    expect(history!.share).toBeCloseTo(19 / 691, 4);
    expect(history!.rms).toBeCloseTo(0.17, 6);
    const paired = pairedTerms({}, history);
    expect(paired).toMatchObject({ from: "history" });
    const noise = levelNoise("L2", runs, undefined, undefined, paired);
    if ("error" in noise) throw new Error(noise.error);
    expect(noise.by).toBe("paired");
    // 0.17 x sqrt(0.0275 / 691) x 2.8: about 0.003, in line with the ±0.0021 interval the third climb read.
    expect(noise.mde).toBeGreaterThan(0.0025);
    expect(noise.mde).toBeLessThan(0.0035);
    const see = levelCanSee("L2", noise, 0.008);
    expect(see.ok).toBe(true);
    expect(see.why).toContain("2.7% of cases moving by ±0.170, as this level's earlier climbs moved them");
  });

  test("the card's own share wins over the history, and with no history the base cases' spread stands in for the moved change", async () => {
    expect(pairedTerms({ moved_share: 0.02 }, { share: 0.3, rms: 0.17 })).toEqual({ share: 0.02, rms: 0.17, from: "card" });
    const paired = pairedTerms({ moved_share: 0.02 }, await movedHistory(registry([]), "in-9", "u/replay", "v1"));
    expect(paired).toEqual({ share: 0.02, from: "card" });
    const noise = levelNoise("L2", runs, undefined, undefined, paired);
    if ("error" in noise) throw new Error(noise.error);
    expect(noise.by).toBe("paired");
    expect(noise.mde).toBeLessThan(0.008);
    expect(pairedTerms({}, null)).toBeUndefined();
  });
});
