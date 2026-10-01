import { spawnSync } from 'node:child_process';

import { evalsSignalFingerprint } from '@codecast/shared/contracts/signalFingerprint';

// The eval finder (docs/architecture/the-line-end-to-end.md LE3): what `check
// --signal` files through `cast signal add` once a run set is graded. A
// separated-worse verdict and every failed gate are regressions on the
// surface; a freeze its reps fail by majority is a prompt miss on that moment.
// The fingerprint names the surface and the check or freeze, so the same
// failure on the next night lands on the same cause.

export interface SurfaceVerdict {
  surface: string;
  /** The scores separated worse than the previous run set. */
  regression: boolean;
  gatesFailed: string[];
  /** Freezes whose reps failed by majority. */
  failingFreezes: string[];
  /** Plain lines that describe the run set: pass rate, mean, separation. */
  summary: string[];
}

export interface EvalSignal {
  kind: 'regression' | 'prompt_miss';
  fingerprint: string;
  title: string;
  detail: string;
  subject: string;
  url?: string;
}

/** The signals one surface's verdict files; none when it held. */
export function evalSignals(v: SurfaceVerdict, evidenceUrl?: string): EvalSignal[] {
  const detail = (lead: string) => [lead, '', ...v.summary.map((l) => `    ${l}`)].join('\n');
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
  for (const freeze of v.failingFreezes) {
    out.push({
      ...base,
      kind: 'prompt_miss',
      fingerprint: evalsSignalFingerprint(v.surface, freeze),
      title: `${v.surface} misses frozen moment ${freeze.slice(0, 8)}`,
      detail: detail(`Most reps of freeze ${freeze} failed. Read them: ./evals freeze results ${freeze.slice(0, 8)}`),
    });
  }
  return out;
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
