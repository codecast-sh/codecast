import type {
  EvalFlip,
  EvalRep,
  EvalRepsFile,
  EvalRepsFreeze,
  EvalRepsSurface,
  EvalResult,
  EvalRunSet,
  EvalSurfaceResult,
} from '@codecast/shared/contracts/evalResult';

import { median, separate } from './stats';

// reps.json to eval-result.json (line-profile.md LP4): the one place the eval
// station's verdict is decided, for every project. A project's eval command
// writes the reps and does no statistics; `cast line eval-result` and
// codecast's own `./evals line` both call buildEvalResult. Pure: no files, no
// processes.
//
// Per surface: the branch's scores against the base's by the one separation
// rule (stats.ts), each proven freeze's majority verdict on both sides (it
// must fail on the base and pass on the branch), the freezes whose verdict
// flipped with a reply from each side and the judge's note, and the gates
// that failed. The station passes only when every surface does and no suite
// gate failed.

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const scored = (reps: EvalRep[]): EvalRep[] => reps.filter((r) => !r.error);
/** A rep's score; a verdict-only rep scores 1 when passed, else 0. */
export const repScore = (r: EvalRep): number => r.score ?? (r.passed ? 1 : 0);

/** A freeze's verdict on one side: passed by majority of its scored reps (a tie is no pass); undefined when none scored. */
export function majorityOf(reps: EvalRep[] | undefined): boolean | undefined {
  const s = scored(reps ?? []);
  if (!s.length) return undefined;
  return s.filter((r) => r.passed).length * 2 > s.length;
}

function runSet(sides: Array<EvalRepsFreeze['base']>): EvalRunSet | null {
  const present = sides.filter((s): s is NonNullable<typeof s> => !!s);
  const reps = present.flatMap((s) => s.reps);
  if (!reps.length) return null;
  const scores = scored(reps).map(repScore);
  return {
    batch: [...new Set(present.map((s) => s.batch))].join(','),
    reps: reps.length,
    passed: reps.filter((r) => r.passed && !r.error).length,
    median: scores.length ? median(scores) : null,
    mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    costUsd: reps.reduce((a, r) => a + r.cost_usd, 0),
  };
}

/**
 * Each proven freeze with its majority verdict on both sides, and why it fails
 * the station. A proven freeze is the miss shown first: one that already
 * passes on the base proves nothing, since the bug is not where the change
 * looks.
 */
export function provenVerdicts(freezes: EvalRepsFreeze[]): { proven: EvalSurfaceResult['proven']; reasons: string[] } {
  const proven = freezes
    .filter((f) => f.proven)
    .map((f) => ({ freeze: f.freeze, basePasses: majorityOf(f.base?.reps) ?? null, passes: majorityOf(f.branch?.reps) === true }));
  const reasons = proven.flatMap((p) => [
    ...(p.basePasses === true ? [`proven freeze ${p.freeze.slice(0, 8)} already passes on the base, so it shows no miss; find where the bug is before changing this surface`] : []),
    ...(p.passes ? [] : [`proven freeze ${p.freeze.slice(0, 8)} still fails`]),
  ]);
  return { proven, reasons };
}

/** A freeze whose verdict differs between the sides, with one rep from each side that matches its side's verdict. */
export function flipOf(f: EvalRepsFreeze): EvalFlip | null {
  const before = majorityOf(f.base?.reps);
  const after = majorityOf(f.branch?.reps);
  if (before === undefined || after === undefined || before === after) return null;
  const pick = (reps: EvalRep[], pass: boolean) => scored(reps).find((r) => r.passed === pass) ?? reps[0];
  const b = pick(f.base!.reps, before);
  const a = pick(f.branch!.reps, after);
  const reply = (r: EvalRep | undefined) => clip(r?.reply || r?.error || '(no reply)', 600);
  const gates = a?.gates_failed?.length ? `gates failed: ${a.gates_failed.join(', ')}` : '';
  return {
    freeze: f.freeze,
    name: f.name,
    direction: after ? 'fixed' : 'broke',
    input: clip(f.input ? `${f.name}: ${f.input}` : f.name, 400),
    before: reply(b),
    after: reply(a),
    note: clip(gates || a?.judge_note || (a?.score != null ? `score ${a.score.toFixed(2)}` : 'no verdict'), 400),
  };
}

/** One surface's verdict from its reps. */
export function surfaceResult(s: EvalRepsSurface): EvalSurfaceResult {
  if (s.skipped) {
    return { surface: s.surface, title: s.title, separation: 'too-few', p: null, base: null, branch: null, gatesFailed: [], crashes: 0, proven: [], flips: [], ok: true, reasons: [], skipped: s.skipped };
  }
  const baseReps = s.freezes.flatMap((f) => f.base?.reps ?? []);
  const branchReps = s.freezes.flatMap((f) => f.branch?.reps ?? []);
  const sep = separate(scored(branchReps).map(repScore), scored(baseReps).map(repScore));
  const gatesFailed = [...new Set(branchReps.flatMap((r) => r.gates_failed ?? []))];
  const crashes = branchReps.filter((r) => r.error).length;
  const proven = provenVerdicts(s.freezes);
  const reasons = [
    // Without a base nothing can be called worse and no miss was shown: fail closed.
    ...(scored(baseReps).length ? [] : [s.base_failure ?? 'no base reps were scored']),
    ...(scored(branchReps).length ? [] : ['no branch reps were scored']),
    ...proven.reasons,
    ...(gatesFailed.length ? [`gates failed: ${gatesFailed.join(', ')}`] : []),
    ...(crashes ? [`${crashes} rep(s) crashed`] : []),
    ...(sep.kind === 'worse' ? [`separated worse than the base (p=${sep.p.toFixed(4)})`] : []),
  ];
  return {
    surface: s.surface,
    title: s.title,
    separation: sep.kind,
    p: 'p' in sep ? sep.p : null,
    base: runSet(s.freezes.map((f) => f.base)),
    branch: runSet(s.freezes.map((f) => f.branch)),
    gatesFailed,
    crashes,
    proven: proven.proven,
    flips: s.freezes.map(flipOf).filter((x): x is EvalFlip => !!x),
    ok: reasons.length === 0,
    reasons,
  };
}

/** reps.json, as the change card reads it. `ok` is the eval station's verdict. */
export function buildEvalResult(reps: EvalRepsFile): EvalResult {
  const surfaces = reps.surfaces.map(surfaceResult);
  const gatesFailed = [...new Set(reps.gates_failed ?? [])];
  const repCost = reps.surfaces.flatMap((s) => s.freezes).flatMap((f) => [...(f.base?.reps ?? []), ...(f.branch?.reps ?? [])]).reduce((a, r) => a + r.cost_usd, 0);
  return {
    version: 1,
    base: reps.base,
    head: reps.head,
    createdAt: reps.created_at,
    dry: reps.dry,
    reps: reps.reps,
    surfaces,
    ...(gatesFailed.length ? { gatesFailed } : {}),
    ok: surfaces.every((s) => s.ok) && gatesFailed.length === 0,
    costUsd: typeof reps.cost_usd === 'number' ? reps.cost_usd : repCost,
  };
}

/** Why reps.json cannot be read, or null when its shape holds. Checks what the builder reads, not every field. */
export function repsFileProblem(raw: unknown): string | null {
  const r = raw as Partial<EvalRepsFile> | null;
  if (!r || typeof r !== 'object') return 'reps.json is not a JSON object';
  if (r.version !== 1) return `reps.json version must be 1 (got ${JSON.stringify(r.version)})`;
  if (!r.base?.sha || !r.head?.sha) return 'reps.json needs base {ref, sha} and head {sha, dirty}';
  if (!Array.isArray(r.surfaces)) return 'reps.json needs a surfaces array';
  if (!Array.isArray(r.gates_failed)) return 'reps.json needs gates_failed (an empty array when no gate failed)';
  for (const [i, s] of r.surfaces.entries()) {
    if (!s?.surface) return `surfaces[${i}] needs a surface id`;
    if (!Array.isArray(s.freezes)) return `surface ${s.surface} needs a freezes array`;
    for (const f of s.freezes) {
      for (const side of [f.base, f.branch]) {
        if (side && !Array.isArray(side.reps)) return `surface ${s.surface} freeze ${f.freeze}: a side needs a reps array`;
        for (const rep of side?.reps ?? []) {
          if (typeof rep.passed !== 'boolean' || typeof rep.cost_usd !== 'number') return `surface ${s.surface} freeze ${f.freeze}: each rep needs passed (boolean) and cost_usd (number)`;
        }
      }
    }
  }
  return null;
}

export interface EvalResultPaint {
  ok?: (s: string) => string;
  fail?: (s: string) => string;
  skip?: (s: string) => string;
}

/** The station's report, one surface a line with its reasons under it, then the suite gates; `./evals line` and `cast line eval-result` print it. */
export function evalResultLines(result: EvalResult, paint: EvalResultPaint = {}): string[] {
  const id = (s: string) => s;
  const { ok = id, fail = id, skip = id } = paint;
  const lines: string[] = [];
  for (const s of result.surfaces) {
    if (s.skipped) {
      lines.push(`${skip('skip')} ${s.surface}  ${s.skipped}`);
      continue;
    }
    const sep = s.separation === 'too-few' ? 'too few reps to separate' : `${s.separation}${s.p != null ? ` (p=${s.p.toFixed(4)})` : ''}`;
    lines.push(`${s.ok ? ok('ok  ') : fail('FAIL')} ${s.surface}  ${sep}  medians ${s.base?.median?.toFixed(2) ?? '-'} -> ${s.branch?.median?.toFixed(2) ?? '-'}  flips ${s.flips.length}`);
    for (const r of s.reasons) lines.push(`       ${r}`);
  }
  if (result.gatesFailed?.length) lines.push(`${fail('FAIL')} suite gates failed: ${result.gatesFailed.join(', ')}`);
  return lines;
}
