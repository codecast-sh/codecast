import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BisectPlanRequest, BisectResponse, BisectStartRequest } from '@codecast/shared/contracts/evalsApi';

import { BISECT_ID_RE, bisectPaths, bisectsDir, LIVE_STATUSES, readBisectState, readSteps, requestStop } from '../bisect/state';
import { readJsonFile } from './files';

// The api child's side of EVALS_HOME/bisects/<id>/ (evals-ui.md section 5,
// "Process and state"). The runner (`./evals bisect start`) owns the folder
// and bisect/state.ts reads it; this adds what the page needs on top: the
// response with its stall flag, whether a bisect holds the machine, and the
// argv that plans or starts one.

/** No new step for this long while running: the page shows "stalled?". */
export const STALL_MS = 5 * 60_000;

/** One bisect: its state, the steps after `since`, the log's tail, and whether it looks stalled. Null when there is no such bisect. */
export function readBisect(id: string, since: number, now = Date.now()): BisectResponse | null {
  if (!BISECT_ID_RE.test(id)) return null;
  const state = readBisectState(id);
  if (!state) return null;
  const all = readSteps(id);
  const log = bisectPaths(id).log;
  const logTail = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(-20) : [];
  const lastAt = Math.max(Date.parse(all.at(-1)?.at ?? '') || 0, Date.parse(state.updatedAt) || 0);
  return { state, steps: all.filter((s) => s.seq > since), cursor: Math.max(since, ...all.map((s) => s.seq)), logTail, stalled: LIVE_STATUSES.has(state.status) && now - lastAt > STALL_MS };
}

/** Asks a running bisect to stop between reps; a finished one is left as it is. Null when there is no such bisect. */
export function stopBisect(id: string): { id: string; stopping: boolean } | null {
  const state = BISECT_ID_RE.test(id) ? readBisectState(id) : null;
  if (!state) return null;
  return { id, stopping: LIVE_STATUSES.has(state.status) && requestStop(id) };
}

/** The bisect that holds the machine (bisect/state.ts acquireRunLock's running.json) while its process lives, else null. */
export function runningBisect(): string | null {
  const held = readJsonFile<{ id?: string; pid?: number }>(join(bisectsDir(), 'running.json'));
  if (!held?.id || !held.pid) return null;
  try {
    process.kill(held.pid, 0);
    return held.id;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? held.id : null;
  }
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
