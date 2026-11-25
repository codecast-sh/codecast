#!/usr/bin/env bun
// Calibrates the priorities pass (packages/convex/convex/lib/priorityPass.ts)
// against a person's golden set: runs the pass from empty over the set's
// window in production, writing nothing (priorityPassEval:evalPass through
// packages/convex/run.sh), then scores what it produced. A model judge matches
// produced priorities to golden ones by meaning, one to one, and aligns the
// critical steps of each matched pair.
//
//   bun packages/evals/scripts/priorities-measure.ts --golden ~/.codecast/emergent-goals/golden/jason.json \
//     --user <email|user id> [--workspace all|personal|team:<id>] [--from 2026-11-10 --to 2026-11-24] [--chunk N] [--out <dir>]
//   bun packages/evals/scripts/priorities-measure.ts --rescore <result.json> [--golden <path>] [--out <dir>]
//     scores a saved run's produced priorities again, without running the pass.
//
// The bar: recall, precision and session mapping at least 0.75, and no step the
// pass marked done whose golden step is not done. The golden set is real
// content: results go to --out (default ~/.codecast/emergent-goals/calibration/<timestamp>/),
// never inside the repo. Judge calls go out on the evals' API key.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { STRONG_MODEL, modelCost, parseJsonBlock, postMessages, replyText } from '../../convex/convex/lib/anthropic';
import { PRIORITY_PASS_MODEL, type PassPriority } from '../../convex/convex/lib/priorityPass';
import { evalsApiKey } from '../src/adapters/apiCall';
import { REPO_ROOT } from '../src/paths';

/** The judge: matching by meaning across differently worded lists is the hard part of the score, so it runs on the strong model. */
export const JUDGE_MODEL = STRONG_MODEL;
export const BAR = { recall: 0.75, precision: 0.75, sessions: 0.75, false_done: 0 } as const;

export type GoldenStep = { title: string; done: boolean; task: string | null };
export type GoldenPriority = { id: string; title: string; short?: string; workspace: string | null; status: string; critical?: GoldenStep[]; sessions: string[] };
export type Golden = { person: string; window: [string, string]; priorities: GoldenPriority[]; session_labels: Record<string, string>; standing_sessions: string[] };

/** A priority the pass produced, keyed across workspaces. */
export type Produced = { key: string; workspace: string; title: string; summary: string; status: string; steps: Array<{ title: string; tier: string; done: boolean }>; sessions: string[] };

export type Match = { produced: string; golden: string; reason: string };
export type StepPair = { produced: number; golden: number; reason: string };

export interface Judge {
  /** Produced priorities that name the same outcome as a golden one; the scorer keeps the first claim on each side. */
  match(produced: Produced[], golden: GoldenPriority[], titles: Map<string, string>): Promise<Match[]>;
  /** Pairs of (produced critical step, golden critical step) that are the same piece of work, by index. */
  alignSteps(produced: Produced, golden: GoldenPriority): Promise<StepPair[]>;
}

const ratio = (a: number, b: number): number | null => (b ? a / b : null);
const critical = (p: Produced) => p.steps.filter((s) => s.tier === 'critical');

/** The current status of each task id it can find (`ct-N`); ids it cannot are left out. */
export type TaskStatus = (ids: string[]) => Promise<Map<string, string>>;

/**
 * Scores produced priorities against the golden set over the sessions the
 * window read (`read`: session id to title).
 *
 * A priority never spans workspaces, so a golden priority whose work spans
 * several may match one produced priority in each; recall counts it once,
 * precision counts each match. A produced priority none of whose sessions the
 * golden set labels is out of its scope (the author never looked at that
 * work): it is listed as unlabeled, not counted for or against precision. One
 * whose sessions are mostly standing-role sessions is a false positive and is
 * not offered to the judge. A step falsely done is real unless its golden
 * step's task is done now (the golden set is stale there).
 */
export async function score(golden: Golden, produced: Produced[], read: Map<string, string>, judge: Judge, taskStatus: TaskStatus) {
  const standing = new Set(golden.standing_sessions);
  const labeled = new Set([...Object.keys(golden.session_labels), ...golden.standing_sessions]);
  const unlabeled = produced.filter((p) => !p.sessions.some((s) => labeled.has(s))).map((p) => p.key);
  const standingLike = produced.filter((p) => p.sessions.length && p.sessions.filter((s) => standing.has(s)).length / p.sessions.length > 0.5).map((p) => p.key);
  const candidates = produced.filter((p) => !standingLike.includes(p.key));

  const goldenById = new Map(golden.priorities.map((g) => [g.id, g]));
  const producedByKey = new Map(candidates.map((p) => [p.key, p]));
  const matches: Match[] = [];
  const goldenOf = new Map<string, string>();
  const taken = new Set<string>(); // golden id | workspace
  for (const m of await judge.match(candidates, golden.priorities, read)) {
    const p = producedByKey.get(m.produced);
    const slot = p && `${m.golden}|${p.workspace}`;
    if (!p || !slot || !goldenById.has(m.golden) || goldenOf.has(m.produced) || taken.has(slot)) continue;
    goldenOf.set(m.produced, m.golden);
    taken.add(slot);
    matches.push(m);
  }
  const matchedGolden = new Set(goldenOf.values());

  const goldenActive = golden.priorities.filter((g) => g.status === 'active');
  const producedActive = produced.filter((p) => p.status === 'active' && !unlabeled.includes(p.key));
  const recall = { matched: goldenActive.filter((g) => matchedGolden.has(g.id)).length, of: goldenActive.length, missed: goldenActive.filter((g) => !matchedGolden.has(g.id)).map((g) => g.id) };
  const precision = { matched: producedActive.filter((p) => goldenOf.has(p.key)).length, of: producedActive.length, unmatched: producedActive.filter((p) => !goldenOf.has(p.key)).map((p) => p.key) };

  const holder = new Map<string, string>();
  for (const p of produced) for (const s of p.sessions) holder.set(s, p.key);
  const labels: Array<[string, string]> = [...Object.entries(golden.session_labels), ...golden.standing_sessions.map((s) => [s, 'standing'] as [string, string])];
  const sessionResults = labels.filter(([s]) => read.has(s)).map(([session, label]) => {
    const by = holder.get(session) ?? null;
    const correct = label === 'standing' ? by === null : by !== null && goldenOf.get(by) === label;
    return { session, title: read.get(session) ?? '', label, produced: by, correct };
  });
  const notRead = labels.filter(([s]) => !read.has(s)).map(([s]) => s);

  const stepPairs = await Promise.all(matches.map(async (m) => {
    const p = producedByKey.get(m.produced)!;
    const g = goldenById.get(m.golden)!;
    const ps = critical(p), gs = g.critical ?? [];
    if (!ps.length || !gs.length) return [];
    const used = new Set<number>(), usedG = new Set<number>();
    const out = [];
    for (const a of await judge.alignSteps(p, g)) {
      if (!ps[a.produced] || !gs[a.golden] || used.has(a.produced) || usedG.has(a.golden)) continue;
      used.add(a.produced);
      usedG.add(a.golden);
      out.push({ produced: m.produced, golden: m.golden, produced_step: ps[a.produced]!.title, golden_step: gs[a.golden]!.title, golden_task: gs[a.golden]!.task, produced_done: ps[a.produced]!.done, golden_done: gs[a.golden]!.done, reason: a.reason });
    }
    return out;
  }));
  const steps = stepPairs.flat();
  const flagged = steps.filter((s) => s.produced_done && !s.golden_done);
  const statusNow = await taskStatus([...new Set(flagged.flatMap((s) => (s.golden_task ? [s.golden_task] : [])))]);
  const falseDone = flagged.map((s) => {
    const task_status = s.golden_task ? statusNow.get(s.golden_task) ?? null : null;
    return { ...s, task_status, verdict: task_status === 'done' ? ('task done now (golden stale)' as const) : ('no task / task open (real)' as const) };
  });
  const realFalseDone = falseDone.filter((f) => f.task_status !== 'done');
  const staleFalseDone = falseDone.filter((f) => f.task_status === 'done');

  const metrics = {
    recall: ratio(recall.matched, recall.of),
    precision: ratio(precision.matched, precision.of),
    sessions: ratio(sessionResults.filter((r) => r.correct).length, sessionResults.length),
    step_done: ratio(steps.filter((s) => s.produced_done === s.golden_done).length, steps.length),
    false_done: realFalseDone.length,
  };
  const pass = (metrics.recall ?? 0) >= BAR.recall && (metrics.precision ?? 0) >= BAR.precision && (metrics.sessions ?? 0) >= BAR.sessions && metrics.false_done <= BAR.false_done;
  return {
    metrics, pass, recall, precision, unlabeled, standing_like: standingLike, matches,
    sessions: { results: sessionResults, not_read: notRead },
    steps: { pairs: steps, false_done: realFalseDone, stale_done: staleFalseDone },
  };
}

export type Score = Awaited<ReturnType<typeof score>>;

// ---------------------------------------------------------------- the model judge

const MATCH_SYSTEM = `You compare two lists of one person's priorities over the same two weeks of work: a reference list a person checked by hand, and a list a program inferred from their sessions. A priority is an outcome the person drives at for a day to a month.

Match an inferred priority to a reference priority when both name the same outcome, even in other words or at a somewhat wider or narrower scope. Sessions both list are evidence, but the outcome decides: two priorities that share a session can still be different outcomes. Inferred priorities are kept per workspace and never span two, so a reference priority whose work spans workspaces may match one inferred priority in each workspace; an inferred priority matches at most one reference priority. Leave a priority unmatched when nothing on the other side is the same outcome. Give one short reason per match.`;

const STEPS_SYSTEM = `You align two critical paths of the same priority: the steps a program inferred and the steps a person checked by hand. Pair an inferred step with the reference step that is the same piece of work, even in other words. Each step pairs at most once. Leave a step unpaired when nothing on the other side is the same work. Give one short reason per pair.`;

const MATCH_SCHEMA = {
  type: 'object',
  properties: { matches: { type: 'array', items: { type: 'object', properties: { inferred: { type: 'string' }, reference: { type: 'string' }, reason: { type: 'string' } }, required: ['inferred', 'reference', 'reason'], additionalProperties: false } } },
  required: ['matches'],
  additionalProperties: false,
};
const STEPS_SCHEMA = {
  type: 'object',
  properties: { pairs: { type: 'array', items: { type: 'object', properties: { inferred: { type: 'integer' }, reference: { type: 'integer' }, reason: { type: 'string' } }, required: ['inferred', 'reference', 'reason'], additionalProperties: false } } },
  required: ['pairs'],
  additionalProperties: false,
};

export function modelJudge(apiKey: string) {
  const spent = { usd: 0, calls: 0 };
  async function ask(system: string, prompt: string, schema: Record<string, unknown>): Promise<any> {
    const res = await postMessages({ model: JUDGE_MODEL, max_tokens: 8_000, system, prompt, output_schema: schema }, { apiKey });
    if (!res?.ok) throw new Error(`judge call failed: ${res?.status} ${await res?.text()}`);
    const body = await res.json();
    spent.usd += modelCost(JUDGE_MODEL, body.usage);
    spent.calls++;
    const json = parseJsonBlock(replyText(body));
    if (!json) throw new Error('judge reply held no JSON');
    return json;
  }
  const sessionList = (ids: string[], titles: Map<string, string>) => ids.map((s) => `${s}${titles.has(s) ? ` "${titles.get(s)}"` : ''}`).join('; ') || '(none)';
  const judge: Judge = {
    async match(produced, golden, titles) {
      const inferred = produced.map((p) => `- ${p.key} · workspace ${p.workspace} · "${p.title}" (${p.status}) · ${p.summary}\n  Critical steps: ${critical(p).map((s) => s.title).join('; ') || '(none)'}\n  Sessions: ${sessionList(p.sessions, titles)}`);
      const reference = golden.map((g) => `- ${g.id} · "${g.title}" (${g.status})\n  Critical steps: ${(g.critical ?? []).map((s) => s.title).join('; ') || '(none)'}\n  Sessions: ${sessionList(g.sessions, titles)}`);
      const out = await ask(MATCH_SYSTEM, `# Reference priorities\n${reference.join('\n')}\n\n# Inferred priorities\n${inferred.join('\n') || '(none)'}`, MATCH_SCHEMA);
      return (out.matches ?? []).map((m: any) => ({ produced: m.inferred, golden: m.reference, reason: m.reason }));
    },
    async alignSteps(produced, golden) {
      const list = (steps: Array<{ title: string }>) => steps.map((s, i) => `${i}. ${s.title}`).join('\n');
      const out = await ask(STEPS_SYSTEM, `Priority: "${golden.title}"\n\n# Reference steps\n${list(golden.critical ?? [])}\n\n# Inferred steps\n${list(critical(produced))}`, STEPS_SCHEMA);
      return (out.pairs ?? []).map((p: any) => ({ produced: p.inferred, golden: p.reference, reason: p.reason }));
    },
  };
  return { judge, spent };
}

// ---------------------------------------------------------------- the run

type EvalResult = {
  outputs: unknown[];
  priorities: PassPriority[];
  cost_usd: number;
  sessions_read: Array<{ id: string; title: string }>;
  omitted: string[];
  resume?: unknown;
};

/** A staff run of an internal function against prod (packages/convex/run.sh), its JSON result. */
function convexRun<T>(fn: string, args: Record<string, unknown>): T {
  const r = Bun.spawnSync([join(REPO_ROOT, 'packages/convex/run.sh'), fn, JSON.stringify(args)], { stdout: 'pipe', stderr: 'inherit' });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`${fn} failed (exit ${r.exitCode})`);
  return JSON.parse(out.slice(out.search(/^[{[]/m)));
}

const DAY = 86_400_000;

/** Current task statuses through the CLI (`cast task show`), one call for all, one per id when a batch fails. */
const castTaskStatus: TaskStatus = async (ids) => {
  const out = new Map<string, string>();
  const show = (batch: string[]) => {
    const r = Bun.spawnSync(['cast', 'task', 'show', ...batch, '--json', '--fields', 'status'], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) return false;
    const rows = JSON.parse(r.stdout.toString());
    for (const t of Array.isArray(rows) ? rows : [rows]) if (t?.short_id && t.status) out.set(t.short_id, t.status);
    return true;
  };
  const tasks = ids.filter((id) => id.startsWith('ct-'));
  if (tasks.length && !show(tasks)) for (const id of tasks) show([id]);
  return out;
};

/** What a run read and produced: from a fresh pass in production, or from a saved result.json (--rescore). */
type PassRun = { produced: Produced[]; read: Map<string, string>; scoredNames: string[]; workspaces: unknown[]; passUsd: number; args: { golden: string; user: string; workspace: string; from: string; to: string; chunk: number | null } };

async function main() {
  const arg = (name: string, fallback?: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i > 0 ? process.argv[i + 1] : fallback;
    if (v === undefined) throw new Error(`--${name} is required`);
    return v;
  };
  const home = (p: string) => resolve(p.replace(/^~/, homedir()));
  const rescore = process.argv.includes('--rescore') ? JSON.parse(readFileSync(home(arg('rescore')), 'utf8')) : null;
  const goldenPath = arg('golden', rescore?.args.golden);
  const golden: Golden = JSON.parse(readFileSync(home(goldenPath), 'utf8'));
  const out = home(arg('out', join(homedir(), '.codecast', 'emergent-goals', 'calibration', new Date().toISOString().replace(/[:.]/g, '-'))));
  if (out === REPO_ROOT || out.startsWith(`${REPO_ROOT}/`)) throw new Error(`--out ${out} is inside the repo; the golden set and results are real content and stay outside it`);
  const key = evalsApiKey();
  if (!key) throw new Error('no evals API key: set CODECAST_EVALS_ANTHROPIC_KEY or the keychain item (./evals doctor)');

  const run = rescore
    ? {
        produced: rescore.produced as Produced[],
        read: new Map<string, string>(rescore.workspaces.filter((w: any) => w.scored).flatMap((w: any) => w.sessions_read.map((s: any) => [s.id, s.title]))),
        scoredNames: rescore.workspaces.filter((w: any) => w.scored).map((w: any) => w.name),
        workspaces: rescore.workspaces,
        passUsd: rescore.cost.pass_usd as number,
        args: { ...rescore.args, golden: goldenPath },
      }
    : runPasses(golden, goldenPath, arg);
  const { produced, read, args } = run;
  // One workspace is scored only against the golden priorities whose sessions it read.
  const scopedGolden: Golden = args.workspace === 'all'
    ? golden
    : { ...golden, priorities: golden.priorities.filter((g) => Object.entries(golden.session_labels).some(([s, id]) => id === g.id && read.has(s))) };

  const { judge, spent } = modelJudge(key);
  const s = await score(scopedGolden, produced, read, judge, castTaskStatus);

  const fmt = (n: number | null) => (n == null ? '  -  ' : n.toFixed(2));
  const titleOf = new Map([...golden.priorities.map((g) => [g.id, g.title] as const), ...produced.map((p) => [p.key, p.title] as const)]);
  const doneLine = (label: string) => (f: Score['steps']['false_done'][number]) =>
    `  ${label} ${f.produced} "${f.produced_step}" ~ ${f.golden} "${f.golden_step}" · task ${f.golden_task ?? 'none'}${f.golden_task ? ` (${f.task_status ?? 'not found'} now)` : ''}`;
  const lines = [
    `window ${args.from}..${args.to} · ${run.scoredNames.join(', ')} · pass ${PRIORITY_PASS_MODEL} · judge ${JUDGE_MODEL}${rescore ? ' · rescored' : ''}`,
    `recall          ${fmt(s.metrics.recall)}  ${s.recall.matched} of ${s.recall.of} active golden priorities matched   bar ≥ ${BAR.recall}`,
    `precision       ${fmt(s.metrics.precision)}  ${s.precision.matched} of ${s.precision.of} active produced priorities in the golden set's scope matched (${s.unlabeled.length} unlabeled)   bar ≥ ${BAR.precision}`,
    `session mapping ${fmt(s.metrics.sessions)}  ${s.sessions.results.filter((r) => r.correct).length} of ${s.sessions.results.length} labeled sessions in the window (${s.sessions.not_read.length} not read)   bar ≥ ${BAR.sessions}`,
    `step done       ${fmt(s.metrics.step_done)}  over ${s.steps.pairs.length} aligned critical steps`,
    `false done      ${s.metrics.false_done} real · ${s.steps.stale_done.length} where the golden set is stale   bar = ${BAR.false_done} real`,
    `cost            pass $${run.passUsd.toFixed(2)} · judge $${spent.usd.toFixed(2)} (${spent.calls} calls)`,
    ...s.recall.missed.map((id) => `  missed     ${id} "${titleOf.get(id)}"`),
    ...s.precision.unmatched.map((k) => `  unmatched  ${k} "${titleOf.get(k)}"${s.standing_like.includes(k) ? ' (mostly standing sessions)' : ''}`),
    ...s.unlabeled.map((k) => `  unlabeled, needs a person  ${k} "${titleOf.get(k)}"`),
    ...s.steps.false_done.map(doneLine('false done')),
    ...s.steps.stale_done.map(doneLine('stale done')),
    `verdict         ${s.pass ? 'PASS' : 'FAIL'}`,
  ];
  console.log(lines.join('\n'));

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'result.json'), JSON.stringify({
    args,
    ...(rescore ? { rescored_from: home(arg('rescore')) } : {}),
    judge_model: JUDGE_MODEL,
    cost: { pass_usd: run.passUsd, judge_usd: spent.usd },
    workspaces: run.workspaces,
    produced,
    score: s,
  }, null, 2));
  writeFileSync(join(out, 'summary.txt'), lines.join('\n') + '\n');
  console.error(`wrote ${out}`);
}

/** Runs evalPass in production for each workspace the user holds, resuming until each window is read. */
function runPasses(golden: Golden, goldenPath: string, arg: (name: string, fallback?: string) => string): PassRun {
  const scope = arg('workspace', 'all');
  const from = arg('from', golden.window[0]);
  const to = arg('to', golden.window[1]);
  const chunk = process.argv.includes('--chunk') ? Number(arg('chunk')) : null;
  const targets = convexRun<{ user_id: string; workspaces: Array<{ workspace: string; name: string }> }>('priorityPassEval:evalTargets', { user: arg('user') });
  const workspaces = scope === 'all'
    ? targets.workspaces
    : scope === 'personal'
      ? targets.workspaces.filter((w) => w.workspace === `user:${targets.user_id}`)
      : targets.workspaces.filter((w) => w.workspace === scope);
  if (!workspaces.length) throw new Error(`no workspace ${scope} for this user`);
  const window_start = Date.parse(`${from}T00:00:00Z`);
  const window_end = Date.parse(`${to}T00:00:00Z`) + DAY;

  const labeled = new Set([...Object.keys(golden.session_labels), ...golden.standing_sessions]);
  const runs: Array<{ workspace: string; name: string; result: EvalResult; scored: boolean }> = [];
  for (const w of workspaces) {
    const result: EvalResult = { outputs: [], priorities: [], cost_usd: 0, sessions_read: [], omitted: [] };
    let resume: unknown;
    do {
      console.error(`${w.name}: pass ${resume ? '(resumed)' : ''}…`);
      const r = convexRun<EvalResult>('priorityPassEval:evalPass', { user_id: targets.user_id, workspace: w.workspace, window_start, window_end, ...(chunk ? { chunk } : {}), ...(resume ? { resume } : {}) });
      result.outputs.push(...r.outputs);
      result.priorities = r.priorities;
      result.cost_usd += r.cost_usd;
      result.sessions_read.push(...r.sessions_read);
      result.omitted.push(...r.omitted);
      resume = r.resume;
    } while (resume);
    // With every workspace, one that holds none of the golden set's sessions is not scored: its priorities are outside the set.
    const scored = scope !== 'all' || result.sessions_read.some((s) => labeled.has(s.id));
    runs.push({ ...w, result, scored });
    console.error(`${w.name}: ${result.sessions_read.length} sessions, ${result.priorities.length} priorities, $${result.cost_usd.toFixed(2)}${scored ? '' : ' (no golden sessions: not scored)'}`);
  }

  const scoredRuns = runs.filter((r) => r.scored);
  return {
    read: new Map(scoredRuns.flatMap((r) => r.result.sessions_read.map((s) => [s.id, s.title] as [string, string]))),
    produced: scoredRuns.flatMap((r) => r.result.priorities.map((p) => ({
      key: `${r.name}:${p.short_id}`,
      workspace: r.name,
      title: p.title,
      summary: p.summary,
      status: p.status,
      steps: p.steps.map((s) => ({ title: s.title, tier: s.tier, done: s.done })),
      sessions: p.sessions.map((s) => s.id),
    }))),
    scoredNames: scoredRuns.map((r) => r.name),
    workspaces: runs.map((r) => ({ workspace: r.workspace, name: r.name, scored: r.scored, sessions_read: r.result.sessions_read, omitted: r.result.omitted, cost_usd: r.result.cost_usd, outputs: r.result.outputs })),
    passUsd: runs.reduce((sum, r) => sum + r.result.cost_usd, 0),
    args: { golden: goldenPath, user: arg('user'), workspace: scope, from, to, chunk },
  };
}

if (import.meta.main) await main();
