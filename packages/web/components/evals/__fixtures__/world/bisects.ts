// Part of the fixture world (../world.ts), which every caller imports. The
// bisects the pages show, each started on a pair of the world's own batches
// that the engine's Tier 0 attribution narrows, with the engine's plan.
// Nothing here is real data.

import type { Attribution, BisectPlan, BisectPlanRequest, Candidate } from "@codecast/shared/contracts/evalsApi";
import { attribute, planFrom } from "@platform/evals/analysis";
import { BadRequest } from "@platform/evals/query";
import { fixtureBisect, type FixtureBisectKind } from "../bisect";
import { type Batch, type FixtureState, fixtureVerdict, gradedBatches, sameFooting, surfaceDef } from "./model";
import type { FixtureSources } from "./sources";

type Reads = Pick<FixtureSources, "git" | "prompts">;

/** Tier 0 attribution between two ends, as GET /attribution weighs it. */
const attributionOf = (st: FixtureState, reads: Reads, req: Pick<BisectPlanRequest, "surface" | "good" | "bad" | "freezes" | "allCommits">): Attribution =>
  attribute({ surface: req.surface, rows: st.rows, good: req.good, bad: req.bad, freezes: req.freezes, allCommits: req.allCommits, git: reads.git.attribution, reader: reads.prompts }, reads.git.meta, fixtureVerdict);

/** POST /bisect/plan: the engine's plan over the world's records. A rep costs what the surface's route costs. */
export function bisectPlan(st: FixtureState, reads: Reads, req: BisectPlanRequest): BisectPlan {
  surfaceDef(st, req.surface);
  try {
    return planFrom(req, { rows: st.rows }, { verdict: fixtureVerdict, meta: reads.git.meta, perRepUsd: (surface) => (surfaceDef(st, surface).route === "agent" ? 0.42 : 0.006), toolHead: () => st.commits[st.commits.length - 1].sha }, () => attributionOf(st, reads, req));
  } catch (e) {
    throw new BadRequest(e instanceof Error ? e.message : String(e));
  }
}

/** The newest pair of batches on one surface whose attribution narrows to candidates that fit the case (flipped freezes preferred). */
function narrowedPair(st: FixtureState, reads: Reads, surface: string, fits: (candidates: Candidate[]) => boolean, before = Infinity): { good: Batch; bad: Batch } | null {
  // A bisect is started on batches that had already run: both ends sit before it began.
  const graded = gradedBatches(st, surface).filter((b) => b.at < before);
  let fallback: { good: Batch; bad: Batch } | null = null;
  for (let bi = graded.length - 1; bi >= Math.max(1, graded.length - 3); bi--) {
    for (let gap = 2; gap <= 6 && bi - gap >= 0; gap++) {
      const good = graded[bi - gap];
      const bad = graded[bi];
      if (!sameFooting(good, bad)) continue;
      const a = attributionOf(st, reads, { surface, good: good.name, bad: bad.name });
      if (a.answer.kind !== "source" || a.answer.confidence !== "narrowed" || !fits(a.answer.candidates)) continue;
      if (a.flipped.length) return { good, bad };
      fallback ??= { good, bad };
    }
  }
  return fallback;
}

/**
 * The bisects the pages show: settle running and finished, a stalled agent
 * run, an unsure range, drift and a control that crashed (__fixtures__/bisect.ts
 * plays each out).
 * Their clock is the real one, not the world's start of day: a page weighs a
 * bisect's elapsed time and its last write against Date.now, so a run that
 * began at the world's clock would read as hours old and never stalled. Their
 * ids are fixed, so nothing that names one moves.
 */
export function buildBisects(st: FixtureState, reads: Reads, clock = Math.max(st.now, Date.now())) {
  // A landed rep links to one of the world's own runs on its freeze with the same outcome, newest first; a crash (null) to a crashed run, on its freeze when one crashed there.
  const runIdOf = (freezeId: string, passed: boolean | null, n: number) => {
    const surface = st.rows.find((r) => r.freezeId === freezeId)?.surface;
    const crashes = st.rows.filter((r) => r.status === "crash" && r.freezeId === freezeId);
    const runs =
      passed === null
        ? crashes.length ? crashes : st.rows.filter((r) => r.status === "crash" && r.surface === surface)
        : st.rows.filter((r) => r.freezeId === freezeId && (r.status === "pass") === passed && (r.status === "pass" || r.status === "fail"));
    return runs.length ? runs[n % runs.length].id : null;
  };
  const cases: Array<{ id: string; surface: string; kind: FixtureBisectKind; ageMin: number }> = [
    { id: "b-settle-1003", surface: "settle", kind: "running", ageMin: 18 },
    { id: "b-anchor-brief-1003", surface: "anchor-brief", kind: "stalled", ageMin: 50 },
    { id: "b-settle-0927", surface: "settle", kind: "culprit", ageMin: 60 * 26 },
    { id: "b-call-summary-0929", surface: "call-summary", kind: "range", ageMin: 90 },
    { id: "b-handoff-0930", surface: "handoff", kind: "drift", ageMin: 60 * 22 },
    { id: "b-title-1002", surface: "title", kind: "crashed", ageMin: 60 * 30 },
  ];
  // What each case needs of its range. A search needs a class between its ends, so three candidates (the patch
  // counts); an unsure range needs two commits that render alike, which the fixture's Tier 1 folds only among four or
  // more; a control that crashes never searches, so any narrowed range does.
  const fits = (kind: FixtureBisectKind) => (candidates: Candidate[]) =>
    kind === "range" ? candidates.filter((x) => x.kind === "commit").length >= 4 : candidates.length >= (kind === "crashed" ? 2 : 3);
  for (const c of cases) {
    // Picked against the world clock, which the real one never trails, so the ends sit before startedAt whatever the hour.
    const pair = narrowedPair(st, reads, c.surface, fits(c.kind), st.now - c.ageMin * 60_000);
    if (!pair) continue;
    const plan = bisectPlan(st, reads, { surface: c.surface, good: pair.good.name, bad: pair.bad.name });
    const b = fixtureBisect(c.kind, plan, { id: c.id, now: clock, ageMin: c.ageMin, runIdOf });
    st.bisects.push(b.state);
    if (c.kind === "running") st.running.add(c.id);
    st.stepsByBisect.set(c.id, b.steps);
    st.tailByBisect.set(c.id, b.logTail);
  }
}
