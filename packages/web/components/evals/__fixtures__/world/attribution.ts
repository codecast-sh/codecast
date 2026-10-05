// Part of the fixture world (../world.ts), which every caller imports.
// Attribution and bisect: the Tier 0 answer from the world's records, the plan
// and the bisects it plays out. Nothing here is real data.

import { type Attribution, type AttributionAnswer, type BisectPlan, type BisectPlanRequest, type BisectState, type BisectSummary, type Candidate, type CostBound, type Endpoint, type RecordedProbe, type RunRow, flipReading, largestDrops, narrowByRecords, sourceConfidence } from "@codecast/shared/contracts/evalsApi";
import { fixtureBisect, type FixtureBisectKind } from "../bisect";
import { type Batch, EvalsFixtureMiss, type FixtureState, JUDGE_MODEL, batchOf, epochsOf, fixtureSeparate, flipsOf, footingOf, gradedBatches, iso, round, rowsIn, sameFooting, scoredOf, sum, surfaceDef, verdict } from "./model";
import { examplesOf, promptPair } from "./runText";

// ── Attribution and bisect ──────────────────────────────────────────────────

function endpointOf(st: FixtureState, surface: string, ref: string): { endpoint: Endpoint; batch: Batch | null } {
  const b = st.batches.get(surface)?.find((x) => x.name === ref) ?? null;
  if (b) {
    const rows = rowsIn(st, b);
    const dirty = rows.some((r) => r.dirty);
    return { batch: b, endpoint: { batch: b.name, sha: b.gitHead, mainSha: st.commits.find((c) => c.sha === b.gitHead)?.mainSha ?? b.gitHead, dirty, treePatch: rows.find((r) => r.treePatch)?.treePatch ?? null, footing: footingOf(b), at: iso(b.at) } };
  }
  const c = st.commits.find((x) => x.sha.startsWith(ref));
  if (!c) throw new EvalsFixtureMiss(`no batch or commit ${ref}`);
  return { batch: null, endpoint: { batch: null, sha: c.sha, mainSha: c.mainSha, dirty: false, treePatch: null, footing: { model: surfaceDef(st, surface).model, ruler: `${JUDGE_MODEL}#r2` }, at: c.at } };
}

/**
 * The ends Tier 0 finds when one is left out (section 5): bad is the newest
 * red batch (separated worse, or a freeze broke), good the newest batch of
 * bad's own baseline.
 */
function defaultEnds(st: FixtureState, surface: string, goodRef?: string, badRef?: string): { good: string; bad: string } {
  const list = gradedBatches(st, surface);
  const red = (x: Batch) => {
    const v = verdict(st, x);
    return v.separation.kind === "worse" || v.flips.some((f) => f.direction === "broke");
  };
  const bad = badRef ?? [...list].reverse().find(red)?.name;
  if (!bad) throw new EvalsFixtureMiss(`no red batch on ${surface} to attribute`);
  if (goodRef) return { good: goodRef, bad };
  const bb = list.find((x) => x.name === bad);
  const base = bb ? (verdict(st, bb).baseline?.batches ?? []) : [];
  const good = list.filter((x) => base.includes(x.name)).sort((x, y) => y.at - x.at)[0]?.name ?? list.filter((x) => !bb || x.at < bb.at).at(-1)?.name;
  if (!good) throw new EvalsFixtureMiss(`no batch before ${bad} on ${surface}`);
  return { good, bad };
}

export function attribution(st: FixtureState, surface: string, goodRef: string | undefined, badRef: string | undefined, allCommits = false, freeze?: string): Attribution {
  const ends = defaultEnds(st, surface, goodRef, badRef);
  const good = endpointOf(st, surface, ends.good);
  const bad = endpointOf(st, surface, ends.bad);
  const gb = good.batch;
  const bb = bad.batch;
  // A freeze limit (`?freeze=`) narrows every class to that freeze, as attribution.ts's `freezes` does.
  const only = (f: string) => !freeze || f.startsWith(freeze);
  const flipped = gb && bb && sameFooting(gb, bb) ? flipsOf(st, gb, bb).filter((f) => f.direction === "broke" && only(f.freezeId)) : [];
  const footingDiffers = good.endpoint.footing.model !== bad.endpoint.footing.model || good.endpoint.footing.ruler !== bad.endpoint.footing.ruler;
  const freezeShas = (b: Batch | null) => new Set(b ? rowsIn(st, b).map((r) => `${r.freezeId}:${r.freezeSha}`) : []);
  const fa = freezeShas(gb);
  const changedFreezes = bb ? [...new Set(rowsIn(st, bb).filter((r) => only(r.freezeId) && !fa.has(`${r.freezeId}:${r.freezeSha}`) && gb && rowsIn(st, gb).some((g) => g.freezeId === r.freezeId)).map((r) => r.freezeId))] : [];
  const badRows = bb ? rowsIn(st, bb).filter((r) => only(r.freezeId)) : [];
  const live = badRows.filter((r) => r.liveReads > 0);
  // The focus freezes, as attribution.ts weighs them: the flips, or in score mode the largest median drops among freezes both
  // ends graded. With none weighed nothing fell, so a moved commit alone is not a source answer.
  const graded = (b: Batch | null) => (b ? rowsIn(st, b).filter((r) => r.status !== "crash" && r.status !== "dry") : []);
  const gs = graded(gb);
  const bs = graded(bb);
  const focusIds = flipped.length ? flipped.map((f) => f.freezeId) : largestDrops(gs, bs);
  const sourceDiffers = focusIds.length > 0 && (good.endpoint.sha !== bad.endpoint.sha || (gb && bb ? gb.epoch !== bb.epoch : false));
  const checklist: Attribution["checklist"] = [
    { class: "footing", differs: footingDiffers, detail: footingDiffers ? `Model ${good.endpoint.footing.model} then ${bad.endpoint.footing.model}; ruler ${good.endpoint.footing.ruler} then ${bad.endpoint.footing.ruler}.` : "Same model and judge ruler on both ends." },
    { class: "freeze", differs: changedFreezes.length > 0, detail: changedFreezes.length ? `${changedFreezes.length} freeze was captured again between the two batches.` : "Every freeze is byte-identical on both ends." },
    { class: "live-reads", differs: live.length > 0, detail: live.length ? `${live.length} reps on the bad end read live workspace state.` : "No rep read the live workspace." },
    { class: "source", differs: sourceDiffers, detail: sourceDiffers ? "The rendered prompt and the declared sources differ." : focusIds.length ? "Same sources and the same rendered prompt." : "No freeze graded on both ends fell: nothing for a commit to explain." },
    { class: "noise", differs: false, detail: "Reached only when nothing above differs." },
  ];
  const lo = Date.parse(good.endpoint.at ?? "");
  const hi = Date.parse(bad.endpoint.at ?? "");
  const inRange = st.commits.filter((c) => Date.parse(c.at) > lo && Date.parse(c.at) <= hi);
  const surfaceWord = surface.split("-")[0];
  const touching = inRange.filter((c) => c.subject.startsWith(surfaceWord) || c.subject.startsWith("evals"));
  let answer: AttributionAnswer;
  let candidates: Candidate[] = [];
  if (footingDiffers) answer = { kind: "footing", change: good.endpoint.footing.model !== bad.endpoint.footing.model ? "model" : "judge", from: good.endpoint.footing.model !== bad.endpoint.footing.model ? good.endpoint.footing.model : good.endpoint.footing.ruler, to: good.endpoint.footing.model !== bad.endpoint.footing.model ? bad.endpoint.footing.model : bad.endpoint.footing.ruler };
  else if (changedFreezes.length) answer = { kind: "freeze", freezeIds: changedFreezes };
  else if (live.length) answer = { kind: "live-reads", reps: live.length, reads: sum(live.map((r) => r.liveReads)) };
  else if (sourceDiffers) {
    // The search set, as attribution.ts walks it: the commits touching declared sources, or every commit with --all-commits.
    const searched = allCommits ? inRange : touching;
    const patch: Candidate | null = bad.endpoint.dirty && bad.endpoint.treePatch ? { kind: "patch", base: bad.endpoint.sha, treePatch: bad.endpoint.treePatch, renderClass: null } : null;
    // Either end on edits nothing kept cannot stand for one commit (attribution.ts unreplayable).
    const unkept = (["good", "bad"] as const).filter((k) => { const e = (k === "good" ? good : bad).endpoint; return e.dirty && !e.treePatch; });
    const unattributable = unkept.length > 0;
    // Every recorded batch inside the range, on the same footing, that ran a flipped freeze and can be replayed (clean, or
    // carrying a patch), placed at its commit's index and read by the probe rule: majority per flipped freeze.
    const focus = new Set(flipped.map((f) => f.freezeId));
    const probeVerdict = (rows: RunRow[]): RecordedProbe["verdict"] => {
      const reading = flipReading(rows.map((r) => ({ freezeId: r.freezeId, passed: r.status === "pass" })), [...focus]);
      return reading === "split" ? "unsure" : reading;
    };
    const recorded = gb && bb && !unattributable
      ? gradedBatches(st, surface)
          .filter((b) => b.at > gb.at && b.at < bb.at && sameFooting(b, gb))
          .flatMap((b) => {
            const all = rowsIn(st, b);
            const ran = all.filter((r) => focus.has(r.freezeId) && (r.status === "pass" || r.status === "fail"));
            const dirty = all.some((r) => r.dirty);
            const at = inRange.findIndex((c) => c.sha === b.gitHead);
            if (!ran.length || at < 0 || (dirty && !all.some((r) => r.treePatch))) return [];
            return [{ batch: b.name, sha: b.gitHead, verdict: probeVerdict(ran), reps: ran.length, at, clean: !dirty }];
          })
      : [];
    const { goodAt, badAt, keepPatch } = narrowByRecords(inRange.length, recorded);
    candidates = [
      ...searched.filter((c) => { const i = inRange.indexOf(c); return unattributable || (i > goodAt && i <= badAt); }).map((commit) => ({ kind: "commit" as const, commit, renderClass: null })),
      ...(patch && (unattributable || keepPatch) ? [patch] : []),
    ];
    answer = {
      kind: "source",
      confidence: unattributable ? "unattributable" : sourceConfidence(candidates.length),
      candidates,
      narrowedBy: recorded.map(({ at: _, clean: __, ...r }) => r),
      epochs: epochsOf(st, surface).filter((e) => Date.parse(e.firstBatchAt) > lo && Date.parse(e.firstBatchAt) <= hi),
      noDeclaredSourceMoved: !allCommits && !touching.length && !patch,
      rangeCommits: inRange.length,
      reason: unattributable ? unkept.map((k) => `the ${k} batch ran uncommitted edits and kept no patch; nothing recorded can replay them`).join("; ") : null,
    };
  } else answer = { kind: "noise", separation: gb && bb ? fixtureSeparate(scoredOf(rowsIn(st, gb).filter((r) => only(r.freezeId))).map((r) => r.score as number), scoredOf(badRows).map((r) => r.score as number)) : { kind: "too-few" } };
  // The rendered prompt whatever the answer, as attribution.ts takes it: per focus freeze, a flip's own lead reps (each
  // side's reps that agree with its verdict), else for the largest drops the good side's newest graded rep against the bad side's first.
  const promptDiffs = focusIds.flatMap((f) => {
    const flip = flipped.find((x) => x.freezeId === f);
    const ra = flip ? st.byId.get(flip.before[0]) : gs.filter((r) => r.freezeId === f).sort((x, y) => (x.stamp < y.stamp ? 1 : -1))[0];
    const rb = flip ? st.byId.get(flip.after[0]) : bs.filter((r) => r.freezeId === f).sort((x, y) => (x.stamp < y.stamp ? -1 : 1))[0];
    return ra && rb ? promptPair(st, ra, rb) : [];
  });
  return {
    surface,
    good: good.endpoint,
    bad: bad.endpoint,
    mode: flipped.length ? "flip" : "score",
    flipped,
    checklist,
    answer,
    promptDiffs,
    examples: examplesOf(st, flipped),
  };
}

export function bisectPlan(st: FixtureState, req: BisectPlanRequest): BisectPlan {
  const def = surfaceDef(st, req.surface);
  const attr = attribution(st, req.surface, req.good, req.bad, req.allCommits);
  const candidates = attr.answer.kind === "source" ? attr.answer.candidates : [];
  // The focus freezes, as the engine's planFrom picks them: the flips, or in score mode the largest median drops (contract's largestDrops).
  const batchOf = (batch: string | null) => (batch ? (st.batches.get(req.surface)?.find((b) => b.name === batch) ?? null) : null);
  const gradedRows = (batch: string | null) => { const b = batchOf(batch); return b ? rowsIn(st, b).filter((r) => r.status !== "crash" && r.status !== "dry") : []; };
  const focusIds = attr.flipped.length ? attr.flipped.map((f) => f.freezeId) : largestDrops(gradedRows(attr.good.batch), gradedRows(attr.bad.batch));
  const flipped = focusIds.map((id) => ({ id, name: attr.flipped.find((f) => f.freezeId === id)?.name ?? st.freezes.get(id)?.name ?? id.slice(0, 8), role: "flipped" as const }));
  const controls = [...st.freezes.values()].filter((f) => f.surface === req.surface && !flipped.some((x) => x.id === f.id)).slice(0, 2).map((f) => ({ id: f.id, name: f.name, role: "control" as const }));
  const freezes = req.freezes?.length ? [...flipped, ...controls].filter((f) => req.freezes!.includes(f.id)) : [...flipped, ...controls];
  const reps = req.reps ?? 3;
  // The api child plans with --no-render, so every candidate (the patch included) counts as its own class until start renders them.
  const classes = candidates.length;
  const probes = Math.ceil(Math.log2(classes + 1));
  const F = freezes.length;
  const maxReps = (2 + probes) * F * (reps + 2) + 2 * (F + 2) * 5;
  const perRepUsd = def.route === "agent" ? 0.42 : 0.006;
  const judgePerRepUsd = def.route === "agent" ? 0.03 : 0.004;
  const maxUsd = round(maxReps * (perRepUsd + judgePerRepUsd), 2);
  const bound: CostBound = { classes, probes, freezes: F, reps, maxReps, perRepUsd, judgePerRepUsd, maxUsd };
  const budgetUsd = req.budgetUsd ?? round(maxUsd * 1.2, 2);
  return {
    surface: req.surface,
    good: attr.good,
    bad: attr.bad,
    attribution: attr,
    freezes,
    reps,
    candidates,
    classes: null,
    bound,
    budgetUsd,
    maxMinutes: req.maxMinutes ?? 45,
    allCommits: req.allCommits ?? false,
    needsConfirm: def.route === "agent",
    // plan.ts costLine, word for word.
    summary: `2 controls + up to ${probes} probe${probes === 1 ? "" : "s"} + confirmation, ${F} freeze${F === 1 ? "" : "s"}, ${reps} to ${reps + 2} reps: at most ${maxReps} reps, about $${maxUsd.toFixed(2)}, budget $${budgetUsd.toFixed(2)}`,
  };
}

/** The newest pair of batches on one surface whose attribution narrows to `minCommits` or more candidates, the patch included (flipped freezes preferred). */
function narrowedPair(st: FixtureState, surface: string, minCommits: number, before = Infinity): { good: Batch; bad: Batch } | null {
  // A bisect is started on batches that had already run: both ends sit before it began.
  const graded = gradedBatches(st, surface).filter((b) => b.at < before);
  let fallback: { good: Batch; bad: Batch } | null = null;
  for (let bi = graded.length - 1; bi >= Math.max(1, graded.length - 3); bi--) {
    for (let gap = 2; gap <= 6 && bi - gap >= 0; gap++) {
      const good = graded[bi - gap];
      const bad = graded[bi];
      if (!sameFooting(good, bad)) continue;
      const a = attribution(st, surface, good.name, bad.name);
      if (a.answer.kind !== "source" || a.answer.confidence !== "narrowed" || a.answer.candidates.length < minCommits) continue;
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
export function buildBisects(st: FixtureState, clock = Math.max(st.now, Date.now())) {
  // A landed rep links to one of the world's own runs on its freeze with the same outcome; a crash (null) to a crashed run, on its freeze when one crashed there.
  const runIdOf = (freezeId: string, passed: boolean | null, n: number) => {
    const surface = st.rows.find((r) => r.freezeId === freezeId)?.surface;
    const crashes = st.rows.filter((r) => r.status === "crash" && r.freezeId === freezeId);
    const runs =
      passed === null
        ? crashes.length ? crashes : st.rows.filter((r) => r.status === "crash" && r.surface === surface)
        : st.rows.filter((r) => r.freezeId === freezeId && (r.status === "pass") === passed && (r.status === "pass" || r.status === "fail"));
    return runs.length ? runs[runs.length - 1 - (n % runs.length)].id : null;
  };
  const cases: Array<{ id: string; surface: string; kind: FixtureBisectKind; ageMin: number }> = [
    { id: "b-settle-1003", surface: "settle", kind: "running", ageMin: 18 },
    { id: "b-anchor-brief-1003", surface: "anchor-brief", kind: "stalled", ageMin: 50 },
    { id: "b-settle-0927", surface: "settle", kind: "culprit", ageMin: 60 * 26 },
    { id: "b-call-summary-0929", surface: "call-summary", kind: "range", ageMin: 90 },
    { id: "b-handoff-0930", surface: "handoff", kind: "drift", ageMin: 60 * 22 },
    { id: "b-title-1002", surface: "title", kind: "crashed", ageMin: 60 * 30 },
  ];
  for (const c of cases) {
    // An unsure range needs two commits that render alike, which the fixture's Tier 1 folds only among four or more.
    // Picked against the world clock, which the real one never trails, so the ends sit before startedAt whatever the hour.
    const pair = narrowedPair(st, c.surface, c.kind === "range" ? 5 : 3, st.now - c.ageMin * 60_000);
    if (!pair) continue;
    const plan = bisectPlan(st, { surface: c.surface, good: pair.good.name, bad: pair.bad.name });
    const b = fixtureBisect(c.kind, plan, { id: c.id, now: clock, ageMin: c.ageMin, runIdOf });
    st.bisects.push(b.state);
    if (c.kind === "running") st.running.add(c.id);
    st.stepsByBisect.set(c.id, b.steps);
    st.tailByBisect.set(c.id, b.logTail);
  }
}

/**
 * A bisect as a page sees it. The world's clock is the start of the day, but
 * a page weighs a bisect's last write against the real clock, so the running
 * one is shown as having written within the last half minute: otherwise every
 * page would flag it "stalled?" a few minutes into the day.
 */
export const liveBisect = (st: FixtureState, b: BisectState): BisectState => (st.running.has(b.id) ? { ...b, updatedAt: iso(Math.max(Date.parse(b.updatedAt), Date.now() - 30_000)) } : b);

export const bisectSummary = (b: BisectState): BisectSummary => ({
  id: b.id,
  surface: b.surface,
  good: b.range.good,
  bad: b.range.bad,
  status: b.status,
  outcome: b.answer?.kind ?? null,
  culprit: b.answer?.kind === "culprit" ? b.answer.commit.sha : null,
  spentUsd: b.spentUsd,
  budgetUsd: b.budgetUsd,
  startedAt: b.startedAt,
  updatedAt: b.updatedAt,
  finishedAt: b.finishedAt,
});
