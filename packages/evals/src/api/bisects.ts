import { join } from 'node:path';

import type { BisectPlanRequest, BisectResponse, BisectStartRequest, BisectState } from '@codecast/shared/contracts/evalsApi';

import { BISECT_ID_RE, bisectPaths, bisectsDir, LIVE_STATUSES, listBisects, readBisectState, readSteps, requestStop } from '../bisect/state';
import { writeJsonAtomic } from '../paths';
import { separate } from '../stats';
import { readJsonFile, tailLines } from './files';
import { stillRunning, type Launched } from './spawn';

// The api child's side of EVALS_HOME/bisects/<id>/ (evals-ui.md section 5,
// "Process and state"). The runner (`./evals bisect start`) owns the folder
// and bisect/state.ts reads it; this adds what the page needs on top: the
// response with its stall flag, whether a bisect holds the machine, and the
// argv that plans or starts one.

/** No new step for this long while running: the page shows "stalled?". */
export const STALL_MS = 5 * 60_000;

/** Where the api child records how it launched a bisect (spawn.ts Launched), beside the bisect's own files. */
export const launchPath = (id: string): string => join(bisectPaths(id).dir, 'launch.json');

/** A pending placeholder whose job is still alive (or not launched yet): the runner has not taken over. */
function pendingAlive(state: BisectState): boolean {
  const launched = readJsonFile<Launched>(launchPath(state.id));
  return !launched || stillRunning(launched);
}

/**
 * Settles the api child's own placeholders: one whose job ended before the
 * runner wrote a state of its own is rewritten as failed (still pending, so
 * its tail is the job's output), which moves its updatedAt and so reaches a
 * page polling /changes. Run before anything lists or reads bisects.
 */
export function settlePendingBisects(): void {
  for (const b of listBisects()) {
    if (b.status !== 'planning') continue;
    const state = readBisectState(b.id);
    if (!state?.pending || pendingAlive(state)) continue;
    const at = new Date().toISOString();
    writeJsonAtomic(bisectPaths(b.id).state, { ...state, status: 'failed', finishedAt: at, updatedAt: at } satisfies BisectState);
  }
}

/**
 * One bisect: its state, the steps after `since`, the log's tail, and whether
 * it looks stalled. The tail is the journal's log.txt, except for a bisect
 * the runner never took over or that failed: then it is job.log, everything
 * the process printed, which holds the reason. Null when there is no such bisect.
 */
export function readBisect(id: string, since: number, now = Date.now()): BisectResponse | null {
  if (!BISECT_ID_RE.test(id)) return null;
  settlePendingBisects();
  const state = readBisectState(id);
  if (!state) return null;
  const all = readSteps(id);
  const paths = bisectPaths(id);
  const job = state.pending || state.status === 'failed' ? tailLines(paths.job) : [];
  const logTail = job.length ? job : tailLines(paths.log);
  const lastAt = Math.max(Date.parse(all.at(-1)?.at ?? '') || 0, Date.parse(state.updatedAt) || 0);
  return { state, steps: all.filter((s) => s.seq > since), cursor: Math.max(since, ...all.map((s) => s.seq)), logTail, stalled: LIVE_STATUSES.has(state.status) && now - lastAt > STALL_MS, controls: controlsOf(state) };
}

/** The controls' reps on the flipped freezes, and whether the bad end separated from the good (BisectResponse.controls). */
export function controlsOf(state: BisectState): BisectResponse['controls'] {
  const focus = new Set(state.plan.freezes?.filter((f) => f.role === 'flipped').map((f) => f.id) ?? []);
  const side = (kind: 'control-good' | 'control-bad') => state.probes.filter((p) => p.kind === kind).flatMap((p) => p.reps).filter((r) => (!focus.size || focus.has(r.freezeId)) && r.passed !== null);
  const good = side('control-good');
  const bad = side('control-bad');
  if (!good.length && !bad.length) return null;
  const tally = (reps: typeof good) => ({ passed: reps.filter((r) => r.passed).length, reps: reps.length });
  const scores = (reps: typeof good) => reps.map((r) => r.score ?? (r.passed ? 1 : 0));
  return { good: tally(good), bad: tally(bad), separation: separate(scores(bad), scores(good)) };
}

/** Asks a running bisect to stop between reps; a finished one is left as it is. Null when there is no such bisect. */
export function stopBisect(id: string): { id: string; stopping: boolean } | null {
  const state = BISECT_ID_RE.test(id) ? readBisectState(id) : null;
  if (!state) return null;
  return { id, stopping: LIVE_STATUSES.has(state.status) && requestStop(id) };
}

/**
 * The bisect that holds the machine (bisect/state.ts acquireRunLock's
 * running.json) while its process lives, else one the api child just started
 * whose runner has not taken the lock yet, else null.
 */
export function runningBisect(): string | null {
  const held = readJsonFile<{ id?: string; pid?: number }>(join(bisectsDir(), 'running.json'));
  if (held?.id && held.pid) {
    try {
      process.kill(held.pid, 0);
      return held.id;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return held.id;
    }
  }
  return (
    listBisects()
      .filter((b) => b.status === 'planning')
      .map((b) => readBisectState(b.id))
      .find((s): s is BisectState => !!s?.pending && pendingAlive(s))?.id ?? null
  );
}

/** The flags `bisect plan` and `bisect start` share (commands/bisect.ts planOptions), each its own argument. */
const planFlags = (req: BisectPlanRequest): string[] => [
  req.surface,
  '--good',
  req.good,
  '--bad',
  req.bad,
  ...(req.freezes?.length ? ['--freeze', req.freezes.join(',')] : []),
  ...(req.reps ? ['--reps', String(req.reps)] : []),
  ...(req.budgetUsd ? ['--budget', String(req.budgetUsd)] : []),
  ...(req.maxMinutes ? ['--max-minutes', String(req.maxMinutes)] : []),
  ...(req.allCommits ? ['--all-commits'] : []),
];

/**
 * `./evals bisect plan … --no-render --json` argv, after the tool's own
 * entry. The Tier 1 renders build a worktree per candidate and can take
 * minutes under load, past the bridge's 120 s answer limit, so the page's
 * plan is the free answer and the bound with every candidate its own class;
 * `start` renders (and keeps the renders for any later bisect) before it
 * spends anything, and its state carries the classes.
 */
export const bisectPlanArgs = (req: BisectPlanRequest): string[] => ['bisect', 'plan', ...planFlags(req), '--no-render', '--json'];

/** `./evals bisect start … --id <id>` argv: --yes only on an explicit confirm. */
export const bisectStartArgs = (req: BisectStartRequest, id: string): string[] => ['bisect', 'start', ...planFlags(req), ...(req.confirm ? ['--yes'] : []), '--id', id];
