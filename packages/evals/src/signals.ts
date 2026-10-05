import { spawnSync } from 'node:child_process';

import { EVALS_SHA_RE, evalsBatchRef, type BisectState, type Candidate } from '@codecast/shared/contracts/evalsApi';
import { evalsSignalFingerprint } from '@codecast/shared/contracts/signalFingerprint';

// The eval finder (docs/architecture/the-line-end-to-end.md LE3): what `check
// --signal` files through `cast signal add` once a run set is graded. A
// separated-worse verdict and every failed gate are regressions on the
// surface; a freeze its reps fail by majority is a prompt miss on that moment.
// The fingerprint names the surface and the check or the freeze's id prefix
// (the 8 characters every run folder name carries), so the same failure on
// the next night lands on the same cause. A finished bisect files
// one more regression naming what it traced the drop to.
//
// A signal leaves this laptop, so its detail names only the surface, the
// verdict lines, freeze id prefixes, shas, the bisect id and the in-app path
// to the Evals area (evals-ui.md section 5): never a reply or a moment.

export interface SurfaceVerdict {
  surface: string;
  /** The scores separated worse than the previous run set. */
  regression: boolean;
  gatesFailed: string[];
  /** Freezes whose reps failed by majority. */
  failingFreezes: string[];
  /** Plain lines that describe the run set: pass rate, mean, separation. */
  summary: string[];
  /** The batch the verdict weighed, pinned in the signal's in-app path. */
  batch?: string;
}

export interface EvalSignal {
  kind: 'regression' | 'prompt_miss';
  fingerprint: string;
  title: string;
  detail: string;
  subject: string;
  url?: string;
}

/**
 * The Evals area's address for a surface, with a batch pinned when there is
 * one: the same form the web's evalsHref.surface builds. The area reads the
 * laptop that ran the evals, so the path is relative and opens in the app.
 */
export function evalsSurfacePath(surface: string, batch?: string | null): string {
  // A labelled batch rides as its hash, as in the web's addresses: a signal's url reaches Convex.
  const ref = evalsBatchRef(batch);
  const q = ref ? `?${new URLSearchParams({ batch: ref })}` : '';
  return `/evals/s/${encodeURIComponent(surface)}${q}`;
}

const inApp = (path: string) => `In the Evals area on the laptop that ran it: ${path}`;

/** The signals one surface's verdict files; none when it held. */
export function evalSignals(v: SurfaceVerdict, evidenceUrl?: string): EvalSignal[] {
  const detail = (lead: string) => [lead, '', ...v.summary.map((l) => `    ${l}`), '', inApp(evalsSurfacePath(v.surface, v.batch))].join('\n');
  const base = { subject: v.surface, ...(evidenceUrl ? { url: evidenceUrl } : {}) };
  const out: EvalSignal[] = [];
  if (v.regression) {
    out.push({
      ...base,
      kind: 'regression',
      fingerprint: evalsSignalFingerprint(v.surface, 'separated-worse'),
      title: `${v.surface} eval scores fell below the previous run set`,
      detail: detail(`./evals check scored ${v.surface} separated worse than its previous run set.`),
    });
  }
  for (const gate of v.gatesFailed) {
    out.push({
      ...base,
      kind: 'regression',
      fingerprint: evalsSignalFingerprint(v.surface, gate),
      title: `${v.surface} eval failed the ${gate} gate`,
      detail: detail(`At least one rep of ${v.surface} failed the ${gate} gate, which scores the run zero.`),
    });
  }
  for (const freeze of v.failingFreezes.map((f) => f.slice(0, 8))) {
    out.push({
      ...base,
      kind: 'prompt_miss',
      fingerprint: evalsSignalFingerprint(v.surface, freeze),
      title: `${v.surface} misses frozen moment ${freeze}`,
      detail: detail(`Most reps of freeze ${freeze} failed. Read them: ./evals freeze results ${freeze}`),
    });
  }
  return out;
}

const sha9 = (s: string) => s.slice(0, 9);
const candidateRef = (c: Candidate) => (c.kind === 'commit' ? sha9(c.commit.sha) : `uncommitted edits ${c.treePatch.slice(0, 8)} on ${sha9(c.base)}`);
const candidateKey = (c: Candidate) => (c.kind === 'commit' ? sha9(c.commit.sha) : `patch:${c.treePatch.slice(0, 8)}`);

/**
 * The regression a finished bisect files: the commit it traced the drop to,
 * or the candidates it narrowed to. A bisect that answered drift, footing,
 * a freeze change, live reads or noise found no source change, and the
 * check's own signal already stands for the drop, so it files nothing.
 */
export function bisectSignal(s: BisectState): EvalSignal | null {
  if (s.status !== 'done' || !s.answer) return null;
  const a = s.answer;
  let traced: Candidate[];
  if (a.kind === 'culprit') traced = [{ kind: 'commit', commit: a.commit, renderClass: null }];
  else if (a.kind === 'range') traced = a.candidates;
  else if (a.kind === 'attribution' && a.answer.kind === 'source' && a.answer.confidence !== 'unattributable') traced = a.answer.candidates;
  else return null;
  // A drop is what a bisect traces: with no flipped freeze nothing fell, and every candidate renders alike, so nothing is filed.
  const freezes = s.plan.freezes.filter((f) => f.role === 'flipped').map((f) => f.id.slice(0, 8));
  if (!traced.length || !freezes.length) return null;
  const refs = traced.map(candidateRef);
  const one = traced.length === 1;
  const badBatch = EVALS_SHA_RE.test(s.range.bad) ? null : s.range.bad;
  const how = a.kind === 'culprit' ? `confirmed by replay (tier ${a.tier})` : a.kind === 'range' ? `tier ${a.tier}` : 'from the records, before any replay';
  return {
    kind: 'regression',
    fingerprint: evalsSignalFingerprint(s.surface, `bisect:${candidateKey(traced[0]!)}${one ? '' : `..${candidateKey(traced[traced.length - 1]!)}`}`),
    title: one ? `${s.surface} eval regression traced to ${refs[0]}` : `${s.surface} eval regression traced to ${traced.length} candidates, ${refs[0]} to ${refs[refs.length - 1]}`,
    subject: s.surface,
    detail: [
      `Bisect ${s.id} took ${s.surface} from good ${s.range.good} to bad ${s.range.bad} and traced the drop, ${how}, to:`,
      '',
      ...refs.map((r) => `    ${r}`),
      '',
      `Broken freezes: ${freezes.join(', ')}`,
      `Read it: ./evals bisect status ${s.id}`,
      inApp(`/evals/bisect/${encodeURIComponent(s.id)}`),
      inApp(evalsSurfacePath(s.surface, badBatch)),
    ].join('\n'),
  };
}

/** The `cast` argv that files one signal. */
export function signalArgv(s: EvalSignal): string[] {
  return ['signal', 'add', '--source', 'evals', '--kind', s.kind, '--fingerprint', s.fingerprint, '--title', s.title, '--subject', s.subject, '--detail', s.detail, ...(s.url ? ['--url', s.url] : []), '--json'];
}

export type CastRunner = (argv: string[]) => { status: number | null; stdout: string; stderr: string };

const castRunner: CastRunner = (argv) => {
  const r = spawnSync('cast', argv, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * File every signal through `cast signal add` and return one line each: the
 * signal and the cause it reached, or why it was not filed. A failure to file
 * never fails the check; the check's own exit code already says it failed.
 */
export function reportSignals(signals: EvalSignal[], opts: { dry?: boolean; run?: CastRunner } = {}): string[] {
  const run = opts.run ?? castRunner;
  return signals.map((s) => {
    if (opts.dry) return `would file ${s.kind} ${s.fingerprint}: cast ${signalArgv(s).slice(0, 8).join(' ')} ...`;
    const r = run(signalArgv(s));
    if (r.status !== 0) return `not filed ${s.fingerprint}: ${(r.stderr || r.stdout).trim().split('\n').pop() || `cast exited ${r.status}`}`;
    try {
      const res = JSON.parse(r.stdout) as { short_id?: string; task_short_id?: string; attach?: string };
      return `filed ${res.short_id} ${s.fingerprint} -> ${res.task_short_id} (${res.attach})`;
    } catch {
      return `filed ${s.fingerprint}`;
    }
  });
}
