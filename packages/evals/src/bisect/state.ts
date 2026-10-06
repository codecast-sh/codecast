import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BisectPlan, BisectState, BisectStep, BisectSummary } from '@codecast/shared/contracts/evalsApi';
import { bisectSummaryOf } from '@platform/evals/analysis';

import { evalsHome, writeJsonAtomic } from '../paths';

// A bisect's folder, EVALS_HOME/bisects/<id>/: plan.json (what it set out to
// do), state.json (rewritten atomically after each step and rep), steps.jsonl
// (one line per step, numbered by seq), log.txt (the steps and every check's
// output, for a tail), job.log (everything the process printed, when the api
// child started it), and `stop`, which cancels it between reps. Everything
// a page shows is read back from these files, so a bisect started in a
// terminal is watched the same way as one the page started.

/** A bisect id: lowercase words and digits, safe as a folder and inside a tmux session name (`evals-bisect-<id>`). */
export const BISECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export const bisectsDir = (home = evalsHome()): string => join(home, 'bisects');

export function bisectPaths(id: string, home = evalsHome()) {
  if (!BISECT_ID_RE.test(id)) throw new Error(`${id} is not a bisect id`);
  const dir = join(bisectsDir(home), id);
  return { dir, plan: join(dir, 'plan.json'), state: join(dir, 'state.json'), steps: join(dir, 'steps.jsonl'), log: join(dir, 'log.txt'), job: join(dir, 'job.log'), stop: join(dir, 'stop') };
}

/** `<surface>-<yyyymmdd>-<hhmmss>`, with a counter when that second is taken. */
export function newBisectId(surface: string, now = new Date(), home = evalsHome()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const base = `${surface}-${stamp}`;
  let id = base;
  for (let n = 2; existsSync(join(bisectsDir(home), id)); n++) id = `${base}-${n}`;
  return id;
}

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

export const readBisectState = (id: string, home = evalsHome()): BisectState | null => readJson<BisectState>(bisectPaths(id, home).state);

/** The state a runner goes on from: what is on disk, unless it is the api child's pending placeholder. */
export const recordedState = (id: string, home = evalsHome()): BisectState | null => {
  const s = readBisectState(id, home);
  return s && !s.pending ? s : null;
};

/** A bisect's first state, from its plan: planning, nothing spent. */
function freshState(id: string, plan: BisectPlan, now: string, tmux: string | null): BisectState {
  return {
    id,
    surface: plan.surface,
    seq: 0,
    status: 'planning',
    tier: 0,
    range: { good: plan.good.batch ?? plan.good.sha, bad: plan.bad.batch ?? plan.bad.sha },
    candidates: plan.candidates,
    classes: plan.classes,
    probes: [],
    spentUsd: 0,
    budgetUsd: plan.budgetUsd,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    tmux,
    answer: null,
    plan,
  };
}

/**
 * The api child's placeholder (BisectState.pending), written before it
 * launches the runner, so the page it sends the founder to reads a planning
 * bisect at once instead of no bisect at all. Refuses an id already on disk.
 */
export function writePendingState(id: string, plan: BisectPlan, tmux: string | null, home = evalsHome()): BisectState {
  const paths = bisectPaths(id, home);
  if (existsSync(paths.state)) throw new Error(`bisect ${id} already exists`);
  mkdirSync(paths.dir, { recursive: true });
  const state: BisectState = { ...freshState(id, plan, new Date().toISOString(), tmux), pending: true };
  writeJsonAtomic(paths.state, state);
  return state;
}
export const readBisectPlan = (id: string, home = evalsHome()): BisectPlan | null => readJson<BisectPlan>(bisectPaths(id, home).plan);

/** The steps after `since` (a seq), in order. A torn last line (mid-append) is left for the next read. */
export function readSteps(id: string, since = 0, home = evalsHome()): BisectStep[] {
  const path = bisectPaths(id, home).steps;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l) as BisectStep] : [];
      } catch {
        return [];
      }
    })
    .filter((s) => s.seq > since);
}

/** Cancel a bisect: the runner and its check see the file between reps. False when there is no such bisect. */
export function requestStop(id: string, home = evalsHome()): boolean {
  const p = bisectPaths(id, home);
  if (!existsSync(p.dir)) return false;
  writeFileSync(p.stop, `${new Date().toISOString()}\n`);
  return true;
}

export const stopRequested = (id: string, home = evalsHome()): boolean => existsSync(bisectPaths(id, home).stop);

/** Every bisect with a state, newest first. */
export function listBisects(home = evalsHome()): BisectSummary[] {
  const dir = bisectsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => BISECT_ID_RE.test(n))
    .flatMap((n) => {
      const s = readBisectState(n, home);
      return s ? [bisectSummaryOf(s)] : [];
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * One bisect runs at a time: EVALS_HOME/bisects/running.json names the one
 * that holds the machine and its pid. A holder whose process is gone (a
 * crash, a laptop that slept through a kill) is taken over; this process
 * may take its own lock again, which is how a resume in the same process
 * works. Returns a release, or the id that holds it.
 */
export function acquireRunLock(id: string, home = evalsHome()): { ok: true; release: () => void } | { ok: false; holder: string } {
  const path = join(bisectsDir(home), 'running.json');
  mkdirSync(bisectsDir(home), { recursive: true });
  const held = readJson<{ id: string; pid: number }>(path);
  if (held && held.pid !== process.pid && alive(held.pid)) return { ok: false, holder: held.id };
  writeJsonAtomic(path, { id, pid: process.pid, at: new Date().toISOString() });
  return {
    ok: true,
    release: () => {
      if (readJson<{ pid: number; id: string }>(path)?.id === id) rmSync(path, { force: true });
    },
  };
}

/**
 * The bisect's record as it runs: every step goes to steps.jsonl and log.txt
 * with the next seq, and the state is rewritten with it, so a reader never
 * sees a step the state does not count.
 */
export class Journal {
  readonly paths: ReturnType<typeof bisectPaths>;
  state: BisectState;

  private constructor(state: BisectState, home: string, private readonly echo: (line: string) => void) {
    this.paths = bisectPaths(state.id, home);
    this.state = state;
  }

  /** Open a bisect's journal: the state on disk when it has one (a resume), else a fresh one from the plan. */
  static open(id: string, plan: BisectPlan, o: { home?: string; tmux?: string | null; echo?: (line: string) => void } = {}): Journal {
    const home = o.home ?? evalsHome();
    const paths = bisectPaths(id, home);
    mkdirSync(paths.dir, { recursive: true });
    const placed = readBisectState(id, home);
    // A pending placeholder is not a resume: the runner starts fresh, keeping only when the founder pressed Start.
    const prior = placed && !placed.pending ? placed : null;
    const state: BisectState = prior ?? freshState(id, plan, placed?.startedAt ?? new Date().toISOString(), o.tmux ?? null);
    if (prior && o.tmux) state.tmux = o.tmux;
    if (!existsSync(paths.plan)) writeJsonAtomic(paths.plan, plan);
    const j = new Journal(state, home, o.echo ?? (() => {}));
    j.save();
    return j;
  }

  /** Tier 1 rewrote the plan: plan.json, and the state's view of the candidates and classes, follow it. */
  setPlan(plan: BisectPlan): void {
    writeJsonAtomic(this.paths.plan, plan);
    Object.assign(this.state, { plan, candidates: plan.candidates, classes: plan.classes, budgetUsd: plan.budgetUsd });
    this.save();
  }

  save(): void {
    this.state.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.paths.state, this.state);
  }

  /** Record one step and rewrite the state with it. */
  step(kind: BisectStep['kind'], sha: string | null, text: string, rep?: BisectStep['rep']): BisectStep {
    const step: BisectStep = { seq: this.state.seq + 1, at: new Date().toISOString(), kind, sha, text, ...(rep ? { rep } : {}) };
    appendFileSync(this.paths.steps, `${JSON.stringify(step)}\n`);
    this.log(`[${step.seq}] ${kind}${sha ? ` ${sha.slice(0, 9)}` : ''}: ${text}`);
    this.state.seq = step.seq;
    this.save();
    return step;
  }

  /** A line for log.txt (and the terminal) that is not a step: a check's own output. */
  log(line: string): void {
    appendFileSync(this.paths.log, line.endsWith('\n') ? line : `${line}\n`);
    this.echo(line);
  }
}
