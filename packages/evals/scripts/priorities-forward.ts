#!/usr/bin/env bun
// Study 2 (ct-102390): plays the priorities pass forward through a window the
// way live runs it, and compares what it holds at each snapshot time with an
// authoritative set read from the whole history up to then
// (priorities-snapshots.ts).
//
//   bun packages/evals/scripts/priorities-forward.ts replay --user <email|user id> --out <dir>
//       [--from 2026-11-10 --to 2026-11-24] [--every 90] [--snapshots 2026-11-14,2026-11-18,2026-11-21,2026-11-25,2026-11-27T22:30:00Z]
//       [--system-file <path>] [--workspace all|personal|team:<id>]
//     Steps the pass every --every minutes (90 by default, about live's cadence of a pass after activity) over the
//     window, one production replay call per step that had activity (priorityPassEval:evalPass, writing nothing,
//     each session as it stood then), carrying the state from step to step, and keeps what it holds at each
//     snapshot time (00:00 UTC of a date, or a full ISO time on the grid). It writes as it goes and picks up where a
//     killed run stopped, or, given a later --to and more snapshots, carries a finished run on.
//   bun packages/evals/scripts/priorities-forward.ts compare --run <dir> --snapshots <dir> [--golden <path>] [--out <dir>]
//     Scores each snapshot time's replayed set against that time's authoritative set (score() and the model judge
//     of priorities-measure.ts) and, with --golden, the last one against the hand-made set too; then has a model
//     read each pair's differences and say what kind each is (difference analysis: a difference is not
//     necessarily the pass's error). Adds churn: what the pass created, merged, retitled and re-filed per day.
//
// Results hold the person's real content: they go under --out, never in the repo.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { modelCost, parseJsonBlock, postMessages, replyText } from '../../convex/convex/lib/anthropic';
import { PRIORITY_PASS_SYSTEM, type PassPriority } from '../../convex/convex/lib/priorityPass';
import type { EvalChunk, EvalResult, EvalState } from '../../convex/convex/priorityPassEval';
import type { PassInputs } from '../../convex/convex/priorityPassInputs';
import { evalsApiKey } from '../src/adapters/apiCall';
import { convexRun, modelJudge, producedOf, replayScope, score, type Golden, type Produced, type Score } from './priorities-measure';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** The difference reader: judgment over two whole priority sets, so the strongest model. */
export const ANALYST_MODEL = 'claude-opus-5-5';

type Args = (name: string, fallback?: string) => string;
function argsOf(argv: string[]): Args {
  return (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]!;
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  };
}
const home = (p: string) => resolve(p.replace(/^~/, homedir()));
const iso = (t: number) => new Date(t).toISOString().replace(':00.000Z', 'Z');

// ---------------------------------------------------------------- the replay

/** One step the replay took: when, what the calls read and changed, what they cost. */
export type Step = { at: number; calls: number; cost_usd: number; sessions: string[]; creates: number; merges: number; retitles: number; status_changes: number; filed: number; unmapped: number };
export type WorkspaceReplay = { workspace: string; name: string; steps: Step[]; snapshots: Record<string, PassPriority[]>; read: Record<string, string>; state: EvalState | null; cost_usd: number };
export type Replay = { args: Record<string, unknown>; system_sha: string; every_min: number; snapshot_at: number[]; workspaces: WorkspaceReplay[]; cost_usd: number };

/** The times the pass would run: each grid point closing an interval that held activity, and every snapshot time. */
export function passTimes(activity: number[], start: number, end: number, every: number, snapshots: number[]): Array<{ at: number; active: boolean }> {
  const sorted = [...activity].sort((a, b) => a - b);
  const out = new Map<number, boolean>();
  let i = 0;
  for (let t = start + every; t <= end; t += every) {
    let active = false;
    while (i < sorted.length && sorted[i]! <= t) {
      if (sorted[i]! > t - every) active = true;
      i++;
    }
    if (active) out.set(t, true);
  }
  for (const s of snapshots) if (s > start && s <= end && !out.has(s)) out.set(s, false);
  return [...out].sort((a, b) => a[0] - b[0]).map(([at, active]) => ({ at, active }));
}

/** What a step's calls changed, counted from their plans. */
export function stepCounts(outputs: EvalChunk[], before: PassPriority[]): Omit<Step, 'at' | 'calls' | 'cost_usd'> {
  const titles = new Map(before.map((p) => [p.short_id, p.title]));
  const statuses = new Map(before.map((p) => [p.short_id, p.status]));
  const c = { sessions: [] as string[], creates: 0, merges: 0, retitles: 0, status_changes: 0, filed: 0, unmapped: 0 };
  for (const o of outputs) {
    c.sessions.push(...o.sessions);
    c.creates += o.plan.creates.length;
    c.merges += o.plan.merges.length;
    c.filed += o.plan.sessions.length;
    c.unmapped += o.plan.unmap.length;
    for (const u of o.plan.updates) {
      if (u.patch.title !== undefined && u.patch.title !== titles.get(u.short_id)) c.retitles++;
      if (u.patch.status !== undefined && u.patch.status !== statuses.get(u.short_id)) c.status_changes++;
    }
  }
  return c;
}

/** Every typed message and pin of the person's in this workspace over the window, by time: what a live pass wakes on. */
function activityOf(user_id: string, workspace: string, start: number, end: number): number[] {
  const at: number[] = [];
  let cursor = start;
  for (;;) {
    const read = convexRun<PassInputs>('priorityPassInputs:passInputs', { user_id, workspace, window_start: cursor, now: end });
    for (const s of read.input.sessions) for (const r of [...s.typed, ...s.pin_events]) at.push(r.at);
    if (!read.more || read.read_to <= cursor) return at;
    cursor = read.read_to;
  }
}

/** One replay call, again after a failure (a model call can time out), up to three tries. */
function evalPassCall(args: Record<string, unknown>): EvalResult {
  for (let attempt = 1; ; attempt++) {
    try {
      return convexRun<EvalResult>('priorityPassEval:evalPass', args);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.error(`  evalPass failed (${(e as Error).message}); trying again`);
    }
  }
}

async function replay(arg: Args) {
  const out = home(arg('out'));
  mkdirSync(out, { recursive: true });
  const scope = replayScope({ window: [arg('from', '2026-11-10'), arg('to', '2026-11-24')] } as Golden, arg);
  const every = Number(arg('every', '90')) * MINUTE;
  if (DAY % every) throw new Error('--every must divide a day, so snapshot times fall on the grid');
  // A date is its 00:00 UTC; a full ISO time is taken as given (it must fall on the --every grid).
  const snapshot_at = arg('snapshots', '2026-11-14,2026-11-18,2026-11-21,2026-11-25').split(',').map((d) => Date.parse(d.includes('T') ? d.trim() : `${d.trim()}T00:00:00Z`));
  if (snapshot_at.some((t) => Number.isNaN(t) || (t - Date.parse(`${arg('from', '2026-11-10')}T00:00:00Z`)) % every)) throw new Error('every snapshot time must be a valid time on the --every grid from --from');
  const systemFile = process.argv.includes('--system-file') ? home(arg('system-file')) : null;
  const system = systemFile ? readFileSync(systemFile, 'utf8') : PRIORITY_PASS_SYSTEM;
  const system_sha = createHash('sha256').update(system).digest('hex').slice(0, 12);

  const file = join(out, 'replay.json');
  const saved: Replay | null = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (saved && saved.system_sha !== system_sha) throw new Error(`${file} was replayed under another prompt (${saved.system_sha}): use another --out`);
  // A resume carries on the same replay: only --to and the snapshot times may grow.
  const same = { user: arg('user'), workspace: scope.scope, from: scope.from };
  for (const [k, v] of Object.entries(same)) if (saved && saved.args[k] !== v) throw new Error(`${file} was replayed with --${k} ${saved.args[k]}, not ${v}: use another --out`);
  if (saved && saved.every_min !== every / MINUTE) throw new Error(`${file} was replayed every ${saved.every_min} min, not ${every / MINUTE}: use another --out`);
  const run: Replay = saved ?? {
    args: { user: arg('user'), workspace: scope.scope, from: scope.from, to: scope.to, system_file: systemFile },
    system_sha, every_min: every / MINUTE, snapshot_at, workspaces: [], cost_usd: 0,
  };
  // A resumed run may go on past its old window and take more snapshots.
  run.snapshot_at = snapshot_at;
  run.args = { ...run.args, to: scope.to };
  const save = () => writeFileSync(file, JSON.stringify(run, null, 1));

  for (const w of scope.workspaces) {
    let wr = run.workspaces.find((x) => x.workspace === w.workspace);
    if (!wr) run.workspaces.push((wr = { workspace: w.workspace, name: w.name, steps: [], snapshots: {}, read: {}, state: null, cost_usd: 0 }));
    const activity = activityOf(scope.user_id, w.workspace, scope.window_start, scope.window_end);
    const times = passTimes(activity, scope.window_start, scope.window_end, every, snapshot_at);
    const doneTo = wr.steps.at(-1)?.at ?? scope.window_start;
    console.error(`${w.name}: ${activity.length} activity rows, ${times.filter((t) => t.active).length} passes${doneTo > scope.window_start ? `, resuming after ${iso(doneTo)}` : ''}`);
    for (const t of times) {
      if (t.at <= doneTo && wr.steps.length) continue;
      let line: string | null = null;
      if (t.active) {
        const before = wr.state?.priorities ?? [];
        const outputs: EvalChunk[] = [];
        let cost = 0, calls = 0;
        let resume: EvalState | undefined = wr.state ?? undefined;
        for (;;) {
          const r = evalPassCall({ user_id: scope.user_id, workspace: w.workspace, window_start: scope.window_start, window_end: t.at, ...(resume ? { resume } : {}), ...(systemFile ? { system } : {}) });
          outputs.push(...r.outputs);
          cost += r.cost_usd;
          calls += r.outputs.length;
          for (const s of r.sessions_read) wr.read[s.id] = s.title;
          wr.state = r.end;
          if (!r.resume) break;
          resume = r.resume;
        }
        const step: Step = { at: t.at, calls, cost_usd: cost, ...stepCounts(outputs, before) };
        wr.steps.push(step);
        wr.cost_usd += cost;
        run.cost_usd += cost;
        line = JSON.stringify({ ...step, outputs }) + '\n';
        console.error(`  ${iso(t.at)}  ${step.sessions.length} sessions, +${step.creates} new, ${step.merges} merged, ${step.retitles} retitled, $${cost.toFixed(3)}  (total $${run.cost_usd.toFixed(2)})`);
      } else {
        wr.steps.push({ at: t.at, calls: 0, cost_usd: 0, sessions: [], creates: 0, merges: 0, retitles: 0, status_changes: 0, filed: 0, unmapped: 0 });
      }
      if (snapshot_at.includes(t.at)) wr.snapshots[iso(t.at)] = structuredClone(wr.state?.priorities ?? []);
      save();
      // After the save, so a run killed between the two replays this step without logging it twice.
      if (line) appendFileSync(join(out, `${w.name}.steps.jsonl`), line);
    }
  }
  save();
  console.error(`replay done: $${run.cost_usd.toFixed(2)} → ${file}`);
}

// ---------------------------------------------------------------- the comparison

/** A golden-shaped set as produced priorities, so the judge can match two such sets. */
export function asProduced(golden: Golden): Produced[] {
  return golden.priorities.map((p) => ({
    key: `${p.workspace ?? 'none'}:${p.id}`, workspace: p.workspace ?? 'none', title: p.title, summary: '', status: p.status,
    steps: (p.critical ?? []).map((s) => ({ title: s.title, tier: 'critical', done: s.done })), sessions: p.sessions,
  }));
}

const DIFF_SYSTEM = `You study how an incrementally evolved list of one person's priorities differs from an authoritative list made at the same moment by reading their whole history up to it. A priority is an outcome that holds a real share of the person's attention for days to weeks, with a few critical milestones and the work sessions that serve it.

The incremental list comes from a program that runs every hour or two and sees only what changed since its last run, plus its own list so far. The authoritative list is a careful reader's view with everything up to the moment in front of it. It is a strong reference, not the truth: when the incremental list holds something the reader left out, or names it better, say so.

You are given both lists, the matches a judge made between them with its reasons, and how sessions are filed on each side. Describe every material difference, one entry each, and say what kind it is:
- "lag": the incremental list has not yet picked up a priority or milestone the reader states (it may appear later)
- "missed": the incremental list holds no version of it at all
- "split": one authoritative priority is spread over several incremental ones
- "merged": several authoritative priorities share one incremental priority
- "narrower" / "wider": an incremental priority is a milestone or part of an authoritative one, or holds more than it
- "extra": the incremental list holds a priority the reader does not; say whether it looks like noise (a one-off task, a standing duty) or a real goal the reader missed
- "stale": the incremental list still holds as active something the reader shows done, set aside, or absorbed
- "milestones": the same priority with a materially different critical path or done states
- "filing": sessions filed under a different priority than the reader files them
- "wording": the same thing named so differently a person would not recognise it
For each, quote the titles involved, explain the difference in one or two sentences, judge whether the incremental list is worse, better or just different there, and, when worse, name the likely cause in the program's behaviour (what it would have needed to do differently) without naming specific goals: the lesson must hold for anyone's priorities.`;

const DIFF_SCHEMA = {
  type: 'object',
  properties: {
    differences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['lag', 'missed', 'split', 'merged', 'narrower', 'wider', 'extra', 'stale', 'milestones', 'filing', 'wording'] },
          authoritative: { type: 'array', items: { type: 'string' } },
          incremental: { type: 'array', items: { type: 'string' } },
          explanation: { type: 'string' },
          verdict: { type: 'string', enum: ['worse', 'better', 'different'] },
          cause: { type: 'string' },
        },
        required: ['kind', 'authoritative', 'incremental', 'explanation', 'verdict', 'cause'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['differences', 'summary'],
  additionalProperties: false,
};

export type Difference = { kind: string; authoritative: string[]; incremental: string[]; explanation: string; verdict: 'worse' | 'better' | 'different'; cause: string };

function renderSet(label: string, rows: Array<{ title: string; status: string; steps: Array<{ title: string; done: boolean }>; sessions: string[] }>, titles: Map<string, string>) {
  return `${label}\n` + rows.map((p, i) => [
    `${i + 1}. "${p.title}" (${p.status})`,
    ...p.steps.map((s) => `   - [${s.done ? 'x' : ' '}] ${s.title}`),
    ...p.sessions.slice(0, 12).map((s) => `   · ${titles.get(s) ?? s}`),
    ...(p.sessions.length > 12 ? [`   · … ${p.sessions.length - 12} more sessions`] : []),
  ].join('\n')).join('\n');
}

async function differences(apiKey: string, at: string, authoritative: Produced[], incremental: Produced[], s: Score, titles: Map<string, string>): Promise<{ differences: Difference[]; summary: string; cost_usd: number }> {
  // The score covers every workspace; this reading is one workspace's: only its matches and its sessions.
  const title = (key: string | null | undefined) => incremental.find((p) => p.key === key)?.title;
  const authTitle = (id: string | null | undefined) => authoritative.find((p) => p.key.endsWith(`:${id}`))?.title;
  const matched = s.matches.filter((m) => title(m.produced) || authTitle(m.golden)).map((m) => `- "${title(m.produced) ?? '(another workspace)'}" ↔ "${authTitle(m.golden) ?? '(another workspace)'}": ${m.reason}`).join('\n') || '(none)';
  const misfiled = s.sessions.results.filter((r) => !r.correct && (authTitle(r.label) || title(r.produced)));
  const prompt = [
    `The moment: ${at}.`,
    renderSet('AUTHORITATIVE LIST', authoritative, titles),
    renderSet('INCREMENTAL LIST', incremental, titles),
    `JUDGE'S MATCHES\n${matched}`,
    `Session filing that disagrees (session: authoritative → incremental):\n${misfiled.map((r) => `- ${r.title || r.session}: ${r.label} → ${r.produced ?? 'unfiled'}`).join('\n') || '(none)'}`,
  ].join('\n\n');
  const res = await postMessages({ model: ANALYST_MODEL, max_tokens: 16_000, system: DIFF_SYSTEM, prompt, output_schema: DIFF_SCHEMA }, { apiKey });
  if (!res || !res.ok) throw new Error(`difference analysis failed: ${res?.status} ${res ? await res.text() : ''}`);
  const body = await res.json();
  const parsed = parseJsonBlock(replyText(body)) as { differences: Difference[]; summary: string };
  return { ...parsed, cost_usd: modelCost(ANALYST_MODEL, body.usage) };
}

/** When each authoritative priority first had a match in the replay, by snapshot: a lag shows as a later first match. */
export function firstMatched(byTime: Array<{ at: string; matches: Array<{ golden: string }> }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of byTime) for (const m of t.matches) out[m.golden] ??= t.at;
  return out;
}

/** Churn per day of the window: what the pass did to its own list, counted from the steps. */
export function churn(run: Replay) {
  return run.workspaces.map((w) => {
    const days = Math.max(1, (w.steps.at(-1)?.at ?? 0) - (w.steps[0]?.at ?? 0)) / DAY;
    const sum = (k: keyof Step) => w.steps.reduce((n, s) => n + (s[k] as number), 0);
    return {
      workspace: w.name, passes: w.steps.filter((s) => s.calls).length, cost_usd: w.cost_usd,
      per_day: { creates: sum('creates') / days, merges: sum('merges') / days, retitles: sum('retitles') / days, status_changes: sum('status_changes') / days, filed: sum('filed') / days },
    };
  });
}

/** The authoritative snapshot files, oldest first: T1.json … in the snapshot dir. */
function readSnapshots(dir: string, times: number[]): Array<{ at: string; golden: Golden }> {
  return times.map((t, i) => {
    const named = [join(dir, `T${i + 1}.json`), join(dir, `${iso(t)}.json`)].find(existsSync);
    if (!named) throw new Error(`no snapshot for ${iso(t)} in ${dir} (T${i + 1}.json)`);
    return { at: iso(t), golden: JSON.parse(readFileSync(named, 'utf8')) as Golden };
  });
}

async function compare(arg: Args) {
  const runDir = home(arg('run'));
  const run: Replay = JSON.parse(readFileSync(join(runDir, 'replay.json'), 'utf8'));
  const out = home(arg('out', join(runDir, 'compare')));
  mkdirSync(out, { recursive: true });
  const apiKey = evalsApiKey();
  if (!apiKey) throw new Error('no evals API key: run under cast vault run (CODECAST_EVALS_ANTHROPIC_KEY)');
  const { judge, spent } = modelJudge(apiKey);
  const noTasks = async () => new Map<string, string>();
  const snapshots = readSnapshots(home(arg('snapshots')), run.snapshot_at);
  const read = new Map(run.workspaces.flatMap((w) => Object.entries(w.read)));
  let analysisUsd = 0;

  const results = [];
  for (const snap of snapshots) {
    const incremental = producedOf(run.workspaces.map((w) => ({ name: w.name, priorities: w.snapshots[snap.at] ?? [] })));
    const s = await score(snap.golden, incremental, read, judge, noTasks);
    const authoritative = asProduced(snap.golden);
    // Per workspace: the replay keeps one list per workspace, so the reader compares like with like.
    const byWorkspace = [];
    for (const w of run.workspaces) {
      const a = authoritative.filter((p) => p.workspace === w.name.toLowerCase());
      const inc = incremental.filter((p) => p.workspace === w.name);
      if (!a.length && !inc.length) continue;
      const d = await differences(apiKey, snap.at, a, inc, s, read);
      analysisUsd += d.cost_usd;
      byWorkspace.push({ workspace: w.name, ...d });
    }
    results.push({ at: snap.at, metrics: s.metrics, score: s, differences: byWorkspace });
    console.error(`${snap.at}: recall ${s.metrics.recall?.toFixed(2)} precision ${s.metrics.precision?.toFixed(2)} sessions ${s.metrics.sessions?.toFixed(2)} · ${byWorkspace.reduce((n, w) => n + w.differences.length, 0)} differences`);
  }

  let hand = null;
  if (process.argv.includes('--golden')) {
    const golden: Golden = JSON.parse(readFileSync(home(arg('golden')), 'utf8'));
    const last = snapshots.at(-1)!;
    hand = {
      replay: (await score(golden, producedOf(run.workspaces.map((w) => ({ name: w.name, priorities: w.snapshots[last.at] ?? [] }))), read, judge, noTasks)).metrics,
      authoritative: (await score(golden, asProduced(last.golden), read, judge, noTasks)).metrics,
    };
  }

  const kinds: Record<string, Record<string, number>> = {};
  for (const r of results) for (const w of r.differences) for (const d of w.differences) {
    kinds[d.kind] ??= { worse: 0, better: 0, different: 0 };
    kinds[d.kind]![d.verdict]++;
  }
  const report = {
    run: runDir, system_sha: run.system_sha, every_min: run.every_min, replay_usd: run.cost_usd, analysis_usd: analysisUsd, judge_usd: spent.usd,
    by_time: results.map((r) => ({ at: r.at, metrics: r.metrics })),
    first_matched: firstMatched(results.map((r) => ({ at: r.at, matches: r.score.matches }))),
    kinds, churn: churn(run), hand, results,
  };
  writeFileSync(join(out, 'compare.json'), JSON.stringify(report, null, 1));
  const lines = [
    `# Forward replay vs authoritative snapshots`,
    `prompt ${run.system_sha} · pass every ${run.every_min} min · replay $${run.cost_usd.toFixed(2)} · analysis $${analysisUsd.toFixed(2)} · judge $${spent.usd.toFixed(2)}`,
    '',
    '| at | recall | precision | sessions | step done |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.at} | ${r.metrics.recall?.toFixed(2)} | ${r.metrics.precision?.toFixed(2)} | ${r.metrics.sessions?.toFixed(2)} | ${r.metrics.step_done?.toFixed(2)} |`),
    '',
    hand ? `Against the hand-made set at the end: replay ${JSON.stringify(hand.replay)}; authoritative ${JSON.stringify(hand.authoritative)}` : '',
    '',
    '## Differences by kind (worse / better / different)',
    ...Object.entries(kinds).map(([k, v]) => `- ${k}: ${v.worse} / ${v.better} / ${v.different}`),
    '',
    '## Churn per day',
    ...report.churn.map((c) => `- ${c.workspace}: ${c.passes} passes · ${Object.entries(c.per_day).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · ')} · $${c.cost_usd.toFixed(2)}`),
    '',
    ...results.flatMap((r) => [`## ${r.at}`, ...r.differences.flatMap((w) => [`### ${w.workspace}`, w.summary, ...w.differences.map((d) => `- **${d.kind}** (${d.verdict}): ${d.explanation}${d.verdict === 'worse' ? ` Cause: ${d.cause}` : ''}`)])]),
  ];
  writeFileSync(join(out, 'summary.md'), lines.join('\n'));
  console.error(`compare done → ${out}/summary.md`);
}

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  const arg = argsOf(process.argv);
  if (cmd === 'replay') await replay(arg);
  else if (cmd === 'compare') await compare(arg);
  else throw new Error('usage: priorities-forward.ts replay|compare …');
}
