// Bisect states for the fixture world and the bisect pages' tests: one plan
// played out as a live ruler mid-run, a stalled run, controls that did not
// reproduce (drift), a control whose every rep crashed, a confirmed culprit,
// and an unsure range. The search is
// the real one from section 5 (a binary search over render classes whose
// newest is known bad), so the brackets in a fixture close in the way they
// will on a real bisect. Nothing here is real data.

import type { BisectAnswer, BisectPlan, BisectProbe, BisectRep, BisectState, BisectStep, Candidate, RenderClass } from "@codecast/shared/contracts/evalsApi";
import { candidateSha, orderCandidates } from "@platform/evals/client";

export type FixtureBisectKind = "running" | "stalled" | "drift" | "crashed" | "culprit" | "range";

export interface FixtureBisect {
  state: BisectState;
  steps: BisectStep[];
  logTail: string[];
}

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const round2 = (v: number) => Math.round(v * 100) / 100;

function hex(text: string, len = 64): string {
  let out = "";
  let h = 0x811c9dc5;
  for (let r = 0; out.length < len; r++) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ r, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}

/**
 * Tier 1 as the fixture plays it: the two oldest commits render alike when
 * there are four or more (a replay cannot tell them apart), every other
 * candidate is its own class, and the patch is always its own.
 */
export function fixtureRenderClasses(plan: BisectPlan): { candidates: Candidate[]; classes: RenderClass[] } {
  const ordered = orderCandidates(plan.candidates);
  const commits = ordered.filter((c) => c.kind === "commit").length;
  let n = 0;
  const candidates = ordered.map((c, i) => {
    if (!(commits >= 4 && i === 1)) n++;
    return { ...c, renderClass: n } as Candidate;
  });
  const classes: RenderClass[] = [];
  for (const c of candidates) {
    const k = classes.find((x) => x.n === c.renderClass);
    const sha = candidateSha(c);
    if (k) {
      k.shas.push(sha);
      k.representative = sha;
    } else classes.push({ n: c.renderClass!, shas: [sha], representative: sha, promptShas: Object.fromEntries(plan.freezes.map((f) => [f.id, hex(`render:${c.renderClass}:${f.id}`)])), skip: null });
  }
  return { candidates, classes };
}

/**
 * `runIdOf` names a recorded run for a landed rep (the world passes one of its
 * own runs on that freeze with the same outcome, `null` asking for a crash), so
 * a ruler's wells link to a run page; without it a rep has no run, and a
 * crashed rep gets a made-up id, since a crash is a run with no score.
 */
export function fixtureBisect(kind: FixtureBisectKind, plan: BisectPlan, opts: { id: string; now: number; ageMin: number; runIdOf?: (freezeId: string, passed: boolean | null, n: number) => string | null }): FixtureBisect {
  const { id, now } = opts;
  const startedAt = now - opts.ageMin * MIN;
  const { candidates, classes } = fixtureRenderClasses(plan);
  const perRep = plan.bound.perRepUsd + plan.bound.judgePerRepUsd;
  const sha8 = (s: string) => s.slice(0, 8);
  const flipped = plan.freezes.filter((f) => f.role === "flipped");

  // The culprit's class: the middle one for a culprit, the shared two-commit class for an unsure range.
  const culpritClass = kind === "range" ? classes.find((k) => k.shas.length > 1) ?? classes[0] : classes[Math.min(classes.length - 1, Math.floor(classes.length / 2))];
  const K = classes.indexOf(culpritClass);

  /**
   * n reps per freeze; `landed` of them have landed. Controls pass; flipped
   * freezes pass only on a good tree, and every one crashes on a crashing tree,
   * as the runner records a crash: its run, no pass or fail, no score.
   */
  let landedReps = 0;
  const reps = (tag: string, good: boolean, n: number, landed = n, crashing = false): BisectRep[] =>
    plan.freezes.flatMap((f) =>
      Array.from({ length: n }, (_, i): BisectRep => {
        if (i >= landed) return { freezeId: f.id, runId: null, passed: null, score: null };
        if (crashing && f.role === "flipped") return { freezeId: f.id, runId: opts.runIdOf?.(f.id, null, landedReps++) ?? `${id}~${f.id.slice(0, 8)}-crash-${i + 1}`, passed: null, score: null };
        const jit = (parseInt(hex(`${tag}:${f.id}:${i}`, 4), 16) / 0xffff) * 0.08;
        const pass = f.role === "control" ? true : good;
        return { freezeId: f.id, runId: opts.runIdOf?.(f.id, pass, landedReps++) ?? null, passed: pass, score: Math.round((pass ? 0.78 + jit : 0.38 + jit) * 100) / 100 };
      }),
    );
  const landedOf = (r: BisectRep[]) => r.filter((x) => x.passed !== null).length;
  const probe = (p: Omit<BisectProbe, "costUsd" | "skipReason"> & { skipReason?: string | null }): BisectProbe => ({ skipReason: null, ...p, costUsd: p.recorded ? 0 : round2(landedOf(p.reps) * perRep) });

  const probes: BisectProbe[] = [];
  const steps: BisectStep[] = [];
  let at = startedAt;
  const step = (kind: BisectStep["kind"], sha: string | null, text: string) => steps.push({ seq: steps.length + 1, at: iso(at), kind, sha, text });

  step("plan", null, plan.summary);
  at += 2 * MIN;
  step("render", null, `Tier 1 dry render: ${candidates.length} candidates in ${classes.length} render classes.`);

  const drift = kind === "drift";
  const crashed = kind === "crashed";
  at += 4 * MIN;
  const cgReps = reps(`cg:${id}`, !drift, plan.reps, plan.reps, crashed);
  // A crashed control keeps its pending verdict: the runner answers before it reads one (runner.ts crashedControl).
  probes.push(probe({ sha: plan.good.sha, kind: "control-good", renderClass: null, batch: `${id}~${sha8(plan.good.sha)}`, recorded: false, reps: cgReps, verdict: crashed ? "pending" : drift ? "bad" : "good" }));

  let answer: BisectAnswer | null = null;
  let status: BisectState["status"] = "probing";
  let tail: string[] = [];

  if (crashed) {
    // The runner answers on the good control alone and never runs the bad one.
    // Each crashed rep is its own run folder; the world reuses its few crashed runs across reps, so name each once.
    const crashedReps = cgReps.filter((r) => r.passed === null && r.runId);
    const runIds = [...new Set(crashedReps.map((r) => r.runId!))];
    step("control", plan.good.sha, `Good control at ${sha8(plan.good.sha)}: every rep on ${flipped.length === 1 ? "its flipped freeze" : `all ${flipped.length} flipped freezes`} crashed.`);
    answer = { kind: "crashed", detail: `every good control rep at ${plan.good.sha.slice(0, 9)} crashed on ${flipped.map((f) => f.id.slice(0, 8)).join(", ")}; read call1/harness.log in ${runIds[0] ?? "its run folder"}`, runIds };
    status = "done";
    at += MIN;
    step("answer", null, "crashed: the good control could not run a rep");
    tail = [`control-good ${sha8(plan.good.sha)}: ${crashedReps.length} of ${crashedReps.length} reps on the flipped freezes crashed`, "error: the model returned an empty stream", "stopping before the search: a control could not run a rep"];
  } else {
    step("control", plan.good.sha, drift ? `Good control at ${sha8(plan.good.sha)} failed ${flipped.length === 1 ? "its flipped freeze" : `all ${flipped.length} flipped freezes`} on today's tool and judge.` : `Good control at ${sha8(plan.good.sha)} reads good.`);
    at += 4 * MIN;
    probes.push(probe({ sha: plan.bad.sha, kind: "control-bad", renderClass: null, batch: `${id}~${sha8(plan.bad.sha)}`, recorded: false, reps: reps(`cb:${id}`, false, plan.reps), verdict: "bad" }));
    step("control", plan.bad.sha, `Bad control at ${sha8(plan.bad.sha)} reads bad.`);
  }

  if (drift) {
    answer = { kind: "drift", detail: `The good end (${sha8(plan.good.sha)}) no longer passes ${flipped.map((f) => f.name).join(" or ")} on today's tool and judge, so no commit in the range can be blamed.` };
    status = "done";
    at += MIN;
    step("answer", null, "Does not reproduce on today's tool and judge: drift, not source.");
    tail = [`control-good ${sha8(plan.good.sha)}: ${flipped.length} of ${flipped.length} flipped freezes fail`, "stopping before the search: drift, not source"];
  } else if (!crashed) {
    // A recorded batch inside the range reads the oldest class for free.
    let lo = -1;
    let hi = classes.length - 1;
    // The recorded batch inside what is left of the range, by preference the one on the oldest class's commit.
    const inRange = plan.attribution.answer.kind === "source" ? plan.attribution.answer.narrowedBy : [];
    const recorded = inRange.find((r) => classes[0]?.shas.includes(r.sha)) ?? inRange.find((r) => candidates.some((c) => candidateSha(c) === r.sha)) ?? inRange.find((r) => r.verdict === "good");
    if (K > 0) {
      const k = classes[0];
      probes.push(probe({ sha: k.representative, kind: "probe", renderClass: k.n, batch: recorded?.batch ?? `recorded~${sha8(k.representative)}`, recorded: true, reps: reps(`rec:${k.n}`, true, 2), verdict: "good" }));
      step("narrow", k.representative, `Recorded batch ${recorded?.batch ?? "in range"} reads class ${k.n} good for free.`);
      lo = 0;
    }
    const live = kind === "running" || kind === "stalled";
    let done = 0;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const k = classes[mid];
      const good = mid < K;
      at += 5 * MIN;
      // A live bisect is caught on its second probe, or on its only one when the range leaves just that.
      if (live && (done === 1 || hi - lo <= 2)) {
        const landed = kind === "stalled" ? 0 : 1;
        probes.push(probe({ sha: k.representative, kind: "probe", renderClass: k.n, batch: `${id}~${sha8(k.representative)}`, recorded: false, reps: reps(`p:${id}:${k.n}`, good, plan.reps, landed), verdict: "pending" }));
        step("probe", k.representative, `Probe ${done + 1} at class ${k.n} (${sha8(k.representative)}): ${landed} of ${plan.reps} reps landed per freeze.`);
        tail = kind === "stalled"
          ? [`probe ${done + 1} at ${sha8(k.representative)}: worktree ready, starting rep 1 of ${plan.reps}`, `waiting on claude -p (8m 52s)`]
          : [`probe ${done + 1} at ${sha8(k.representative)}: rep 1 of ${plan.reps} landed on ${plan.freezes[0]?.name ?? "a freeze"}`, "waiting on claude -p (41s)"];
        break;
      }
      probes.push(probe({ sha: k.representative, kind: "probe", renderClass: k.n, batch: `${id}~${sha8(k.representative)}`, recorded: false, reps: reps(`p:${id}:${k.n}`, good, plan.reps), verdict: good ? "good" : "bad" }));
      step("probe", k.representative, `Probe ${done + 1} at class ${k.n} (${sha8(k.representative)}): ${good ? "good" : "bad"}.`);
      if (good) lo = mid;
      else hi = mid;
      done++;
    }
    if (!live) {
      const culprit = candidates.find((c) => c.renderClass === culpritClass.n && c.kind === "commit") as Extract<Candidate, { kind: "commit" }> | undefined;
      const parentIdx = candidates.findIndex((c) => c.renderClass === culpritClass.n) - 1;
      const parentSha = parentIdx >= 0 ? candidateSha(candidates[parentIdx]) : plan.good.sha;
      if (kind === "culprit" && culprit) {
        status = "done";
        at += 6 * MIN;
        probes.push(probe({ sha: culprit.commit.sha, kind: "confirm-culprit", renderClass: culpritClass.n, batch: `${id}~${sha8(culprit.commit.sha)}`, recorded: false, reps: reps(`cc:${id}`, false, 5), verdict: "bad" }));
        probes.push(probe({ sha: parentSha, kind: "confirm-parent", renderClass: null, batch: `${id}~${sha8(parentSha)}`, recorded: false, reps: reps(`cp:${id}`, true, 5), verdict: "good" }));
        step("confirm", culprit.commit.sha, `Confirmation: ${sha8(culprit.commit.sha)} against its parent ${sha8(parentSha)} at 5 reps a side.`);
        answer = { kind: "culprit", commit: culprit.commit, separation: { kind: "worse", p: 0.004 }, tier: 2 };
        at += MIN;
        step("answer", culprit.commit.sha, `Culprit ${sha8(culprit.commit.sha)}: separated worse, p 0.004.`);
        tail = ["confirm: separated worse, p 0.004", "answer written to state.json"];
      } else {
        status = "done";
        at += 6 * MIN;
        const inClass = candidates.filter((c) => c.renderClass === culpritClass.n);
        answer = { kind: "range", candidates: inClass, separation: { kind: "not-separated", p: 0.21 }, tier: 2 };
        // runner.ts's own range line, which the result card prints as it is.
        step("answer", null, `range of ${inClass.length} candidate(s): the confirmation did not separate worse (not-separated, p=0.2100)`);
        tail = ["confirm: not separated, p 0.21", "answer written to state.json"];
      }
    }
  }

  const finished = status === "done";
  const updatedAt = kind === "stalled" ? now - 9 * MIN : kind === "running" ? now - MIN : at;
  const state: BisectState = {
    id,
    surface: plan.surface,
    seq: steps.length,
    status,
    tier: 2,
    // As the runner records it: the ends as they were given, batch names when the bisect started from batches.
    range: { good: plan.good.batch ?? plan.good.sha, bad: plan.bad.batch ?? plan.bad.sha },
    candidates,
    classes,
    probes,
    spentUsd: round2(probes.reduce((s, p) => s + p.costUsd, 0)),
    budgetUsd: plan.budgetUsd,
    startedAt: iso(startedAt),
    updatedAt: iso(Math.min(updatedAt, now)),
    finishedAt: finished ? iso(Math.min(at, now)) : null,
    tmux: finished ? null : `evals-bisect-${id}`,
    answer,
    plan: { ...plan, candidates, classes },
  };
  return { state, steps, logTail: tail };
}

// ── Attribution cases ───────────────────────────────────────────────────────

/** Every Tier 0 answer the pages draw, plus the agent surface's confirm. `empty` is a source answer with no candidate left. */
export const ATTRIBUTION_CASES = ["footing", "freeze", "live-reads", "noise", "pinned", "narrowed", "empty", "unattributable", "agent"] as const;
export type AttributionCase = (typeof ATTRIBUTION_CASES)[number];

export interface AttributionPair {
  surface: string;
  good: string;
  bad: string;
}

type WorldLike = { rows: readonly { surface: string; batch: string | null; status: string }[]; answer: (key: "GET /attribution", p: Record<string, string>, q: Record<string, string>) => unknown };

type AnswerLike = { answer: { kind: string; confidence?: string; candidates?: Array<{ kind: string }> } };

/**
 * The case a pair stands for. A pinned answer counts only when it names a
 * commit (the page then shows its CommitPanel), and an unattributable one only
 * when it still lists candidates (the page then offers the plan).
 */
const caseOf = (a: AnswerLike, surface: string): AttributionCase | null => {
  const x = a.answer;
  if (x.kind !== "source") return x.kind as AttributionCase;
  if (x.confidence === "narrowed" && surface === "anchor-brief") return "agent";
  if (x.confidence === "pinned" && x.candidates?.[0]?.kind !== "commit") return null;
  if (x.confidence === "unattributable" && !x.candidates?.length) return null;
  return x.confidence as AttributionCase;
};

/** A pair of batches in the world for each case: the newest pairs first, adjacent and a few apart. */
export function attributionPairs(world: WorldLike): Partial<Record<AttributionCase, AttributionPair>> {
  const out: Partial<Record<AttributionCase, AttributionPair>> = {};
  const surfaces = [...new Set(world.rows.map((r) => r.surface))];
  for (const surface of surfaces) {
    const batches = [...new Set(world.rows.filter((r) => r.surface === surface && r.status !== "dry").map((r) => r.batch!))];
    for (let i = batches.length - 1; i > 0; i--) {
      for (const gap of [1, 2, 4]) {
        if (i - gap < 0) continue;
        const pair = { surface, good: batches[i - gap], bad: batches[i] };
        const a = world.answer("GET /attribution", {}, pair) as AnswerLike;
        const k = caseOf(a, surface);
        if (k && !out[k]) out[k] = pair;
      }
      if (ATTRIBUTION_CASES.every((k) => out[k])) return out;
    }
  }
  return out;
}
