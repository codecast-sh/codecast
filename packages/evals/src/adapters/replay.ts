import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { CheckResult, ConvoMessage, Freeze, GateResult, Replayer, ReplayOptions, RunSummary, Score } from '@platform/evals';
import { summarizeRunFolder } from '@platform/evals/fs';

import { runFolderName, writeRunFolder, type RunJson } from '../layout';
import { homePaths } from '../paths';
import { loadSurface, surfaceMeta } from '../registry';
import { dirtySurfaces, gitHead, sourceHashes } from '../state';
import { gate, type AgentResult, type CallResult, type ReplayCtx, type ReplayResult, type SurfaceMeta } from '../surface';
import { runAgent, runCall } from './dryRun';
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

/** The gates every call and agent run gets, read from what the harness wrote. */
export function routeGates(meta: SurfaceMeta, result: Pick<ReplayResult, 'calls' | 'agents'>): GateResult[] {
  const runs: Array<{ label: string; model: string; usage: CallResult['modelUsage']; isError: boolean; exitCode: number }> = [
    ...result.calls.map((c, i) => ({ label: `call${i + 1}`, model: c.request.model, usage: c.modelUsage, isError: c.isError, exitCode: c.exitCode })),
    ...result.agents.map((a, i) => ({ label: `agent${i + 1}`, model: a.model, usage: a.modelUsage, isError: a.isError, exitCode: a.exitCode })),
  ];
  const offPin = runs.filter((r) => !pinnedMatches(dominantModel(r.usage), r.model));
  const failed = runs.filter((r) => r.isError || r.exitCode !== 0);
  const gates = [
    gate('model-as-pinned', offPin.length === 0, offPin.length ? offPin.map((r) => `${r.label} pinned ${r.model}, answered on ${dominantModel(r.usage) ?? 'nothing'}`).join('; ') : `${runs.length} run(s) answered on the pinned model`),
    gate('ok', failed.length === 0, failed.length ? failed.map((r) => `${r.label} exit ${r.exitCode}${r.isError ? ', is_error' : ''}`).join('; ') : `${runs.length} run(s) exited clean`),
  ];
  if (meta.route === 'call') {
    const over = result.calls.filter((c) => c.stopReason === 'max_tokens' || c.outputTokens > c.request.max_tokens);
    gates.push(gate('prod-budget', over.length === 0, over.length ? over.map((c) => `${c.outputTokens} output tokens against max_tokens ${c.request.max_tokens} (stop ${c.stopReason}): prod would have truncated`).join('; ') : 'every reply fit the max_tokens prod sends'));
  } else {
    const lines = result.agents.flatMap((a) => a.calls);
    const unserved = lines.filter((l) => l.startsWith('UNSERVED '));
    const allowed = (meta.allowedRefusals ?? []).map((p) => new RegExp(p));
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

export interface ReplayRunOptions extends ReplayOptions {
  /** The `check` invocation this belongs to; a fresh one when unset. */
  batch?: string;
  /** Stop before a rep that would take the spend past this. */
  budgetUsd?: number | null;
  /** Spend so far across the whole check, shared between freezes. */
  spent?: { usd: number };
  /** The expected cost of one rep, for the budget stop. */
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

export async function replayFreeze(f: Freeze, o: ReplayRunOptions): Promise<ReplayOutcome> {
  const surfaceId = String((f.meta as { surface?: string } | undefined)?.surface ?? '');
  const meta = surfaceMeta(surfaceId);
  if (!meta) throw new Error(`freeze ${f.id.slice(0, 8)} names no known surface (${surfaceId || 'none'})`);
  const impl = await loadSurface(surfaceId);
  const root = homePaths().runs;
  const batch = o.batch ?? new Date().toISOString();
  // An agent surface runs on the production session's model when its capture could read one.
  const capturedModel = meta.route === 'agent' ? (f.meta as { model?: string } | undefined)?.model : undefined;
  const model = o.model ?? capturedModel ?? meta.model;
  const run: Omit<RunJson, 'promptSha' | 'judgeModel' | 'temperatureProd' | 'liveReads'> = {
    freezeId: f.id,
    notes: o.notes ?? null,
    model,
    route: meta.route,
    sourceHash: sourceHashes([meta]).get(meta.id)!,
    budgetUsd: o.budgetUsd ?? null,
    gitHead: gitHead(),
    dirty: dirtySurfaces([meta]).has(meta.id),
    dry: Boolean(o.dry),
    temperatureReplay: 'cli-default',
    batch,
    title: f.name,
  };
  const scenario = `${meta.id}-${f.id.slice(0, 8)}`;
  const spent = o.spent ?? { usd: 0 };
  const outcome: ReplayOutcome = { runs: [], crashes: 0, budgetHit: false, costUsd: 0 };
  const reps = Math.max(1, Math.min(o.reps, MAX_REPS));

  let loaded: LoadedSnapshot | null = null;
  let mismatch: string | null = null;
  try {
    loaded = loadSnapshot(f);
  } catch (e) {
    if (!(e instanceof SnapshotMismatch)) throw e;
    mismatch = e.message;
  }

  for (let rep = 1; rep <= reps; rep++) {
    const startedAt = Date.now();
    const dir = join(root, runFolderName(meta.id, f.id, rep, startedAt));
    const base = { dir, freeze: f, scenario, rep, startedAt };
    const overBudget = o.budgetUsd != null && spent.usd + (o.estPerRep ?? 0) > o.budgetUsd;
    const overTime = o.deadline != null && startedAt >= o.deadline;
    if (overBudget || overTime) {
      const why = overTime ? `the time limit (${new Date(o.deadline!).toISOString()}) has passed` : `the $${o.budgetUsd} budget is spent`;
      writeRunFolder({ ...base, endedBecause: 'budget', error: overTime ? `time limit reached after $${spent.usd.toFixed(4)}` : `budget $${o.budgetUsd} reached after $${spent.usd.toFixed(4)}`, run: { ...run, ...sentFields([], []), promptSha: null, judgeModel: null } });
      o.onLine?.(`stopped before rep ${rep}: ${why}`);
      outcome.budgetHit = true;
      outcome.stoppedBy = overTime ? 'time' : 'budget';
      break;
    }
    o.onLine?.(`${scenario} rep ${rep} of ${reps}`);
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
          return r;
        },
        async agent(opts) {
          prompts.push(opts.prompt);
          const a = await runAgent({ ...opts, serveDir: opts.serveDir ?? loaded!.dir }, join(dir, `agent${agents.length + 1}`), { dry: Boolean(o.dry) });
          agents.push(a);
          return a;
        },
      };
      try {
        const out = await impl.replay(loaded.snap, ctx);
        const result: ReplayResult = { ...out, calls, agents };
        const label = loadLabel(f, loaded);
        const gates = [...routeGates(meta, result), ...impl.gates(loaded.snap, result, label)];
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
        outcome.crashes++;
        const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
        writeRunFolder({ ...base, endedBecause: 'failed', error, result: { reply: '', calls, agents }, run: { ...run, ...sentFields(calls, agents), promptSha: promptShaOf(calls, prompts), judgeModel: null } });
        o.onLine?.(`${scenario} rep ${rep} crashed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const summary = summarizeRunFolder(root, dir.slice(root.length + 1));
    if (summary) {
      outcome.runs.push(summary);
      outcome.costUsd += summary.costUsd;
      spent.usd += summary.costUsd;
    }
  }
  return outcome;
}

export const codecastReplayer: Replayer = {
  async replay(f, o) {
    return (await replayFreeze(f, o)).runs;
  },
};
