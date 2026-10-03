import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { CheckResult, ConvoMessage, Freeze, GateResult, Replayer, ReplayOptions, RunSummary, Score } from '@platform/evals';
import { summarizeRunFolder } from '@platform/evals/fs';

import { runFolderName, writeRunFolder, type RunJson } from '../layout';
import { homePaths } from '../paths';
import { loadSurface, surfaceMeta } from '../registry';
import { addSpend, dirtySurfaces, gitHead, sourceHashes } from '../state';
import { gate, type AgentResult, type CallResult, type ReplayCtx, type ReplayResult, type SurfaceMeta } from '../surface';
import { assertAnswered, runAgent, runCall } from './dryRun';
import { judgeReply, PASS_AT } from './judge';
import { loadLabel, loadSnapshot, SnapshotMismatch, type LoadedSnapshot } from './resolver';

// Replays a freeze N times. Each rep loads the snapshot (checking its hash),
// runs the surface through the harness, grades it with the route's gates, the
// surface's own gates and checks, and the judged criterion, then writes the
// rep as a run folder. A rep that throws is a crash, recorded and counted.

export const MAX_REPS = 25;

/** Which model a run actually answered on: the one with the most output tokens. */
export function dominantModel(usage: CallResult['modelUsage']): string | null {
  let best: string | null = null;
  let most = -1;
  for (const [model, u] of Object.entries(usage)) {
    const out = Number(u?.outputTokens ?? 0);
    if (out > most) {
      best = model;
      most = out;
    }
  }
  return best;
}

/** A pin may carry a context suffix (`claude-opus-5-5[1m]`); the API reports the bare id. */
const pinnedMatches = (reported: string | null, pinned: string) => {
  const bare = pinned.replace(/\[.*\]$/, '');
  return Boolean(reported && (reported === bare || reported.startsWith(bare)));
};

/** The gates every call and agent run gets, read from what the harness wrote; `allowedHere` adds the snapshot's own allowed refusals (SurfaceImpl.allowedRefusals). */
export function routeGates(meta: SurfaceMeta, result: Pick<ReplayResult, 'calls' | 'agents'>, allowedHere: string[] = []): GateResult[] {
  const runs: Array<{ label: string; model: string; usage: CallResult['modelUsage']; loop?: Record<string, number>; isError: boolean; exitCode: number }> = [
    ...result.calls.map((c, i) => ({ label: `call${i + 1}`, model: c.request.model, usage: c.modelUsage, isError: c.isError, exitCode: c.exitCode })),
    ...result.agents.map((a, i) => ({ label: `agent${i + 1}`, model: a.model, usage: a.modelUsage, loop: a.loopTurns, isError: a.isError, exitCode: a.exitCode })),
  ];
  // An agent's own loop must run on the pin, every message of it; the `Agent` subagents it chooses to start are its behaviour, named in the evidence.
  // A call, or an agent run with no stream to read, answered on the model with the most output.
  const loopOf = (r: (typeof runs)[number]) => (r.loop && Object.keys(r.loop).length ? r.loop : null);
  const offModels = (r: (typeof runs)[number]): string[] => {
    const loop = loopOf(r);
    if (loop) return Object.keys(loop).filter((m) => !pinnedMatches(m, r.model));
    const dominant = dominantModel(r.usage);
    return pinnedMatches(dominant, r.model) ? [] : [dominant ?? 'nothing'];
  };
  const subagents = runs.flatMap((r) => {
    const loop = loopOf(r);
    if (!loop) return [];
    const others = Object.entries(r.usage).filter(([m, u]) => !(m in loop) && Number(u?.outputTokens ?? 0) > 0);
    return others.length ? [`${r.label}'s subagents answered on ${others.map(([m, u]) => `${m} (${u?.outputTokens} output tokens)`).join(', ')}`] : [];
  });
  const offPin = runs.filter((r) => offModels(r).length > 0);
  const failed = runs.filter((r) => r.isError || r.exitCode !== 0);
  const gates = [
    gate(
      'model-as-pinned',
      offPin.length === 0,
      [offPin.length ? offPin.map((r) => `${r.label} pinned ${r.model}, ${loopOf(r) ? 'its loop answered' : 'answered'} on ${offModels(r).join(', ')}`).join('; ') : `${runs.length} run(s) answered on the pinned model`, ...subagents].join('; '),
    ),
    gate('ok', failed.length === 0, failed.length ? failed.map((r) => `${r.label} exit ${r.exitCode}${r.isError ? ', is_error' : ''}`).join('; ') : `${runs.length} run(s) exited clean`),
  ];
  if (meta.route === 'call') {
    const over = result.calls.filter((c) => c.stopReason === 'max_tokens' || c.outputTokens > c.request.max_tokens);
    gates.push(gate('prod-budget', over.length === 0, over.length ? over.map((c) => `${c.outputTokens} output tokens against max_tokens ${c.request.max_tokens} (stop ${c.stopReason}): prod would have truncated`).join('; ') : 'every reply fit the max_tokens prod sends'));
  } else {
    const lines = result.agents.flatMap((a) => a.calls);
    const unserved = lines.filter((l) => l.startsWith('UNSERVED '));
    const allowed = [...(meta.allowedRefusals ?? []), ...allowedHere].map((p) => new RegExp(p));
    const refused = lines.filter((l) => l.startsWith('REFUSED ') && !allowed.some((re) => re.test(l.slice('REFUSED '.length))));
    gates.push(
      gate('frozen-reads', unserved.length === 0, unserved.length ? `${unserved.map((l) => `cast ${l.slice('UNSERVED '.length)}`).join('; ')} was not captured, so it was refused: add it to meta.frozenReads and re-run \`./evals snapshot\` (for a fixture, add it to the world it reads)` : 'every frozen read was served'),
      gate('no-unexpected-writes', refused.length === 0, refused.length ? `refused: ${refused.map((l) => `cast ${l.slice('REFUSED '.length)}`).join('; ')}` : 'no write was attempted outside the harness note'),
    );
  }
  return gates;
}

/** The pass rule: every gate held, no check under its floor, and the score at PASS_AT or over. */
export const passesAt = (score: number, gatesFailed: number, missedFloors: number): boolean => gatesFailed === 0 && missedFloors === 0 && score >= PASS_AT;

/**
 * A rep's verdict. A dry rep's status is `dry` (it grades canned output), but
 * its score keeps the verdict its gates gave, so `line --dry` can prove the
 * station rule's wiring end to end.
 */
export const repPassed = (r: RunSummary): boolean => r.status === 'pass' || (r.status === 'dry' && r.score !== null && passesAt(r.score, r.gatesFailed.length, r.missedFloors.length));

/** The platform's Score: 0 on any failed gate, else the weighted mean of the checks (1 when only gates grade). */
export function scoreOf(gates: GateResult[], checks: CheckResult[], judge?: { costUsd: number; model: string } | null): Score {
  const missedFloors = checks.filter((c) => c.must != null && c.score < c.must).map((c) => ({ id: c.id, score: c.score, must: c.must! }));
  const weight = checks.reduce((s, c) => s + c.weight, 0);
  const mean = weight > 0 ? checks.reduce((s, c) => s + c.weight * c.score, 0) / weight : 1;
  const gatesPass = gates.every((g) => g.pass);
  const score = gatesPass ? mean : 0;
  return { pass: passesAt(score, gatesPass ? 0 : 1, missedFloors.length), score, passMark: PASS_AT, gates, checks, missedFloors, judgeCostUsd: judge?.costUsd ?? null, judgeModel: judge?.model ?? null, scoredAt: new Date().toISOString() };
}

/** One hash over every prompt under test the rep sent (system and user per call, then each agent briefing); a grader's prompt is not one. */
const promptShaOf = (calls: CallResult[], prompts: string[]): string | null => {
  const parts = [...calls.filter((c) => !c.grader).map((c) => `${c.request.system ?? ''}\x1e${c.request.prompt}`), ...prompts];
  return parts.length ? createHash('sha256').update(parts.join('\x1d')).digest('hex') : null;
};

/**
 * What a rep actually sent, read from its calls rather than copied into meta:
 * each prompt-under-test call's temperature (prod's builder sets it, or leaves
 * the API default), and how many agent reads went to the live workspace (the
 * guard keeps each one's output under the agent run's live-reads/). A rep with
 * live reads saw a world its snapshot does not hold, so it is not reproducible.
 */
export const sentFields = (calls: CallResult[], agents: AgentResult[]): Pick<RunJson, 'temperatureProd' | 'liveReads'> => ({
  temperatureProd: calls.filter((c) => !c.grader).map((c) => c.request.temperature ?? 'api-default'),
  liveReads: agents.reduce((n, a) => n + a.calls.filter((l) => l.startsWith('LIVE ')).length, 0),
});

/**
 * What every rep of one check shares: the spend so far, each lane's reps
 * still running (so parallel reps cannot all start under a budget they would
 * cross together), and why the check stopped, once it has. A lane is one
 * surface on one model.
 */
export interface RepLedger {
  usd: number;
  lanes?: Record<string, LaneLedger>;
  stoppedBy?: 'budget' | 'time';
}

export interface LaneLedger {
  /** The estimate the check started with (state.ts perRepUsd). */
  est: number;
  running: number;
  done: number;
  doneUsd: number;
}

/**
 * What one more rep on a lane is expected to cost: the starting estimate, or
 * the average of the reps this check already finished there when that is
 * more. A history from another freeze mix can sit far under a lane's real
 * cost, and reps in flight finish past any stop, so the reservation follows
 * what the check is measuring.
 */
export const laneRepUsd = (l: LaneLedger): number => Math.max(l.est, l.done ? l.doneUsd / l.done : 0);

/** What the reps still running are expected to add to the spend. */
export const reservedUsd = (ledger: RepLedger): number => Object.values(ledger.lanes ?? {}).reduce((t, l) => t + l.running * laneRepUsd(l), 0);

export interface ReplayRunOptions extends ReplayOptions {
  /** The `check` invocation this belongs to; a fresh one when unset. */
  batch?: string;
  /** Stop before a rep that would take the spend past this. */
  budgetUsd?: number | null;
  /** Shared across every freeze and rep of one check. */
  spent?: RepLedger;
  /** The expected cost of one rep on this freeze's surface and model, for the budget stop (raised by what the check's finished reps cost; laneRepUsd). */
  estPerRep?: number;
  /** Epoch ms after which no rep starts: a check bounds its own wall time, so a session that started it in the background cannot leave it running. */
  deadline?: number | null;
}

export interface ReplayOutcome {
  runs: RunSummary[];
  crashes: number;
  /** Stopped before a rep: the spend budget or the time limit (`stoppedBy`). */
  budgetHit: boolean;
  stoppedBy?: 'budget' | 'time';
  costUsd: number;
}

/** One freeze, loaded once for all its reps. */
export interface PreparedFreeze {
  f: Freeze;
  meta: SurfaceMeta;
  impl: Awaited<ReturnType<typeof loadSurface>>;
  root: string;
  model: string;
  scenario: string;
  run: Omit<RunJson, 'promptSha' | 'judgeModel' | 'temperatureProd' | 'liveReads'>;
  loaded: LoadedSnapshot | null;
  mismatch: string | null;
}

/** What a rep records about the tree: HEAD, and each surface's source hash and dirtiness. One read per check, not per freeze. */
export interface TreeFacts {
  head: string;
  hashes: Map<string, string>;
  dirty: Set<string>;
}

export const treeFacts = (metas: SurfaceMeta[]): TreeFacts => ({ head: gitHead(), hashes: sourceHashes(metas), dirty: dirtySurfaces(metas) });

/** The reps `replayFreeze` runs for a requested count. */
export const repCount = (reps: number): number => Math.max(1, Math.min(reps, MAX_REPS));

/** The model a freeze replays on: the --model override, else an agent surface's production session model when its capture read one, else the pin. */
export function replayModel(meta: SurfaceMeta, f: Freeze, override?: string | null): string {
  const capturedModel = meta.route === 'agent' ? (f.meta as { model?: string } | undefined)?.model : undefined;
  return override ?? capturedModel ?? meta.model;
}

export async function prepareFreeze(f: Freeze, o: ReplayRunOptions, facts?: TreeFacts): Promise<PreparedFreeze> {
  const surfaceId = String((f.meta as { surface?: string } | undefined)?.surface ?? '');
  const meta = surfaceMeta(surfaceId);
  if (!meta) throw new Error(`freeze ${f.id.slice(0, 8)} names no known surface (${surfaceId || 'none'})`);
  const impl = await loadSurface(surfaceId);
  const model = replayModel(meta, f, o.model);
  const tree = facts ?? treeFacts([meta]);
  const run: PreparedFreeze['run'] = {
    freezeId: f.id,
    notes: o.notes ?? null,
    model,
    route: meta.route,
    sourceHash: tree.hashes.get(meta.id)!,
    budgetUsd: o.budgetUsd ?? null,
    gitHead: tree.head,
    dirty: tree.dirty.has(meta.id),
    dry: Boolean(o.dry),
    temperatureReplay: 'cli-default',
    batch: o.batch ?? new Date().toISOString(),
    title: f.name,
  };
  let loaded: LoadedSnapshot | null = null;
  let mismatch: string | null = null;
  try {
    loaded = loadSnapshot(f);
  } catch (e) {
    if (!(e instanceof SnapshotMismatch)) throw e;
    mismatch = e.message;
  }
  return { f, meta, impl, root: homePaths().runs, model, scenario: `${meta.id}-${f.id.slice(0, 8)}`, run, loaded, mismatch };
}

/**
 * One rep of a prepared freeze. It starts only while the shared ledger has
 * room under the budget and the deadline has not passed; the first rep that
 * finds no room writes the stop as a run folder and marks the ledger, and
 * every later one returns `stopped` without a trace. A rep that throws is a
 * crash, recorded and counted.
 */
export async function replayRep(p: PreparedFreeze, rep: number, reps: number, o: ReplayRunOptions): Promise<{ summary: RunSummary | null; crashed: boolean; stopped: boolean }> {
  const { f, meta, impl, root, model, scenario, run, loaded, mismatch } = p;
  const spent = o.spent ?? { usd: 0 };
  if (spent.stoppedBy) return { summary: null, crashed: false, stopped: true };
  const startedAt = Date.now();
  const dir = join(root, runFolderName(meta.id, f.id, rep, startedAt));
  const base = { dir, freeze: f, scenario, rep, startedAt };
  const lane = ((spent.lanes ??= {})[`${meta.id} ${model}`] ??= { est: o.estPerRep ?? 0, running: 0, done: 0, doneUsd: 0 });
  const overBudget = o.budgetUsd != null && spent.usd + reservedUsd(spent) + laneRepUsd(lane) > o.budgetUsd;
  const overTime = o.deadline != null && startedAt >= o.deadline;
  if (overBudget || overTime) {
    spent.stoppedBy = overTime ? 'time' : 'budget';
    const why = overTime ? `the time limit (${new Date(o.deadline!).toISOString()}) has passed` : `the $${o.budgetUsd} budget is spent`;
    writeRunFolder({ ...base, endedBecause: 'budget', error: overTime ? `time limit reached after $${spent.usd.toFixed(4)}` : `budget $${o.budgetUsd} reached after $${spent.usd.toFixed(4)}`, run: { ...run, ...sentFields([], []), promptSha: null, judgeModel: null } });
    o.onLine?.(`stopped before ${scenario} rep ${rep}: ${why}`);
    return { summary: summarizeRunFolder(root, dir.slice(root.length + 1)), crashed: false, stopped: true };
  }
  lane.running++;
  o.onLine?.(`${scenario} rep ${rep} of ${reps}`);
  let crashed = false;
  try {
    if (mismatch || !loaded) {
      const gates = [gate('snapshot', false, mismatch ?? 'no snapshot')];
      writeRunFolder({ ...base, endedBecause: 'done', score: scoreOf(gates, []), run: { ...run, ...sentFields([], []), promptSha: null, judgeModel: null } });
    } else {
      const calls: CallResult[] = [];
      const agents: AgentResult[] = [];
      const prompts: string[] = [];
      const ctx: ReplayCtx = {
        dry: Boolean(o.dry),
        model,
        runDir: dir,
        snapshotDir: loaded.dir,
        freeze: f,
        async call(req, opts) {
          const r = await runCall(o.model && req.model === meta.model ? { ...req, model: o.model } : req, join(dir, `call${calls.length + 1}`), { dry: Boolean(o.dry) });
          if (opts?.grader) r.grader = true;
          calls.push(r);
          assertAnswered(r, `call${calls.length}`);
          return r;
        },
        async agent(opts) {
          prompts.push(opts.prompt);
          const a = await runAgent({ ...opts, serveDir: opts.serveDir ?? loaded.dir }, join(dir, `agent${agents.length + 1}`), { dry: Boolean(o.dry) });
          agents.push(a);
          assertAnswered(a, `agent${agents.length}`);
          return a;
        },
      };
      try {
        const out = await impl.replay(loaded.snap, ctx);
        const result: ReplayResult = { ...out, calls, agents };
        const label = loadLabel(f, loaded);
        const gates = [...routeGates(meta, result, impl.allowedRefusals?.(loaded.snap) ?? []), ...impl.gates(loaded.snap, result, label)];
        const checks = [...(impl.checks?.(loaded.snap, result, label) ?? [])];
        let judged: { costUsd: number; model: string } | null = null;
        if (f.judge) {
          let transcript: ConvoMessage[] = [];
          try {
            transcript = impl.describe(loaded.snap).filter((m) => Date.parse(m.at) <= Date.parse(f.asOf));
          } catch {
            transcript = [];
          }
          const texts = agents.length ? agents.flatMap((a) => a.said) : [result.reply];
          const reply = texts.map((text, i): ConvoMessage => ({ n: i + 1, id: `reply-${i + 1}`, at: f.asOf, channel: 'session', isGroup: false, direction: 'out', from: 'assistant', text }));
          const v = await judgeReply(f, transcript, reply, { dir: join(dir, 'judge'), dry: Boolean(o.dry) });
          judged = { costUsd: v.costUsd, model: v.model };
          checks.push({ id: 'criteria', ask: f.judge, weight: 1, score: v.score, reasoning: v.reasoning ?? null, must: f.tags.includes('must') ? PASS_AT : null });
        }
        const score = scoreOf(gates, checks, judged);
        writeRunFolder({ ...base, endedBecause: 'done', result, score, run: { ...run, ...sentFields(calls, agents), promptSha: out.promptSha ?? promptShaOf(calls, prompts), judgeModel: judged?.model ?? null } });
      } catch (e) {
        crashed = true;
        const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
        writeRunFolder({ ...base, endedBecause: 'failed', error, result: { reply: '', calls, agents }, run: { ...run, ...sentFields(calls, agents), promptSha: promptShaOf(calls, prompts), judgeModel: null } });
        o.onLine?.(`${scenario} rep ${rep} crashed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    lane.running--;
  }
  const summary = summarizeRunFolder(root, dir.slice(root.length + 1));
  if (summary) {
    spent.usd += summary.costUsd;
    // The day's ledger hears of each rep as it finishes, so a long or killed check never hides what it spent.
    if (!o.dry) addSpend(summary.costUsd);
    lane.done++;
    lane.doneUsd += summary.costUsd;
  }
  return { summary, crashed, stopped: false };
}

/** Folds rep results into one outcome; stop folders are kept, so a run list shows where a check stopped. */
export function outcomeOf(results: Array<{ summary: RunSummary | null; crashed: boolean; stopped: boolean }>, spent: RepLedger): ReplayOutcome {
  const runs = results.flatMap((r) => (r.summary ? [r.summary] : []));
  const budgetHit = results.some((r) => r.stopped);
  return {
    runs,
    crashes: results.filter((r) => r.crashed).length,
    budgetHit,
    ...(budgetHit ? { stoppedBy: spent.stoppedBy ?? 'budget' } : {}),
    costUsd: runs.reduce((s, r) => s + r.costUsd, 0),
  };
}

/** Replays a freeze's reps one after another (`freeze replay`); `check` runs reps through its own pool. */
export async function replayFreeze(f: Freeze, o: ReplayRunOptions): Promise<ReplayOutcome> {
  const p = await prepareFreeze(f, o);
  const spent = o.spent ?? { usd: 0 };
  const reps = repCount(o.reps);
  const results: Array<Awaited<ReturnType<typeof replayRep>>> = [];
  for (let rep = 1; rep <= reps; rep++) {
    const r = await replayRep(p, rep, reps, { ...o, spent });
    results.push(r);
    if (r.stopped) break;
  }
  return outcomeOf(results, spent);
}

export const codecastReplayer: Replayer = {
  async replay(f, o) {
    return (await replayFreeze(f, o)).runs;
  },
};
