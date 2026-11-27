#!/usr/bin/env bun
// Calibrates the priorities pass (packages/convex/convex/lib/priorityPass.ts)
// against a person's golden set: runs the pass from empty over the set's
// window in production, writing nothing (priorityPassEval:evalPass through
// packages/convex/run.sh), then scores what it produced. A model judge matches
// produced priorities to golden ones by meaning, one to one, and aligns the
// critical steps of each matched pair.
//
//   bun packages/evals/scripts/priorities-measure.ts --golden ~/.codecast/emergent-goals/golden/jason.json \
//     --user <email|user id> [--workspace all|personal|team:<id>] [--from 2026-11-10 --to 2026-11-24] [--chunk N] [--system-file <path>] [--out <dir>]
//     --system-file replays the pass under a candidate system prompt (its sha goes in the result).
//     --seed-golden starts every workspace's pass holding the golden priorities (titles and critical
//     steps with their tasks, no sessions, nothing done), so session mapping measures placement given the person's goals.
//   bun packages/evals/scripts/priorities-measure.ts --golden <path> --user <email|user id> --classifier [--holdout 4] [--model <id>]
//     runs the per-session classifier (priorityClassifierEval:evalClassify, deployed to prod: deploy first) instead of
//     the pass, over the same window, against the golden priorities seeded as open goals (done ones too: they were open
//     during the window), asking about each session as live would have, when live would have (its first title or pin,
//     and its first pin after a "new"). Every --holdout'th golden priority (4th, 8th, ...; 0 holds none out) is left out
//     of the seed, so its sessions test "new". No judge: a seeded pri-N is its golden priority. It reports
//       placement      sessions of seeded goals placed under their own goal
//       new detection  sessions of held-out goals left unplaced
//       combined       both together: the verdict, at the session bar
//       standing       standing-role sessions left unplaced (free: the classifier never asks about them)
//       as the pass scores it  placement and standing together, the quantity of the pass's seeded session mapping
//     Read "as the pass scores it" against the pass's 0.86 (its --seed-golden run) only at --holdout 0, where both
//     replays hold the same goals; with goals held out the seed has fewer distractors, so it reads a little high.
//     --local runs the classifier here, on the working tree's prompt and the evals' key, with prod supplying only the
//     sessions' facts (read-only), saved to <out>/facts.json; --facts <path> reuses them with no prod read at all.
//   bun packages/evals/scripts/priorities-measure.ts --rescore <result.json> [--golden <path>] [--out <dir>]
//     scores a saved run's produced priorities again, without running the pass.
//
// The bar: recall, precision and session mapping at least 0.75, and no step the
// pass marked done whose golden step is not done (a done step that is only part
// of a golden step claims nothing about the rest of it). The golden set is real
// content: results go to --out (default ~/.codecast/emergent-goals/calibration/<timestamp>/),
// never inside the repo. Judge calls go out on the evals' API key.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { STRONG_MODEL, modelCost, parseJsonBlock, postMessages, replyText } from '../../convex/convex/lib/anthropic';
import { PRIORITY_PASS_MODEL, PRIORITY_PASS_SYSTEM, type PassPriority } from '../../convex/convex/lib/priorityPass';
import { PRIORITY_CLASSIFIER_MODEL, classifierPriorities, classifierRequest, parseClassifierReply, type ClassifierChoice, type ClassifierTask } from '../../convex/convex/lib/priorityClassifier';
import type { EvalAsk, EvalSession } from '../../convex/convex/priorityClassifierEval';
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
/** The inferred step against the reference step: the same work, one part of it, or more than it. */
export type StepScope = 'same' | 'narrower' | 'wider';
export type StepPair = { produced: number; golden: number; scope: StepScope; reason: string };

/**
 * Whether a pair's done states agree, given scope: a narrower step may be done
 * while the whole is not (but not the reverse), and a wider one may be open
 * while the reference step is done (but not the reverse).
 */
export function doneAgrees(scope: StepScope, produced: boolean, golden: boolean): boolean {
  if (scope === 'narrower') return produced || !golden;
  if (scope === 'wider') return golden || !produced;
  return produced === golden;
}

export interface Judge {
  /** Produced priorities that name the same outcome as a golden one; the scorer keeps the first claim on each side. */
  match(produced: Produced[], golden: GoldenPriority[], titles: Map<string, string>): Promise<Match[]>;
  /** Pairs of (produced critical step, golden critical step) that are the same piece of work or one holds the other, by index. */
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
 * golden set labels (and it holds at least one) is out of its scope (the author never looked at that
 * work): it is listed as unlabeled, not counted for or against precision. One
 * whose sessions are mostly standing-role sessions is a false positive and is
 * not offered to the judge. A step falsely done is one marked done whose golden
 * step is not, unless it is only a narrower part of that step; it is real unless
 * its golden step's task is done now (the golden set is stale there).
 */
export async function score(golden: Golden, produced: Produced[], read: Map<string, string>, judge: Judge, taskStatus: TaskStatus) {
  const standing = new Set(golden.standing_sessions);
  const labeled = new Set([...Object.keys(golden.session_labels), ...golden.standing_sessions]);
  // Out of scope only when it has sessions and the golden set labels none of them; a sessionless one (from calls, or emptied) is scored.
  const unlabeled = produced.filter((p) => p.sessions.length > 0 && !p.sessions.some((s) => labeled.has(labelId(s)))).map((p) => p.key);
  const standingLike = produced.filter((p) => p.sessions.length && p.sessions.filter((s) => standing.has(labelId(s))).length / p.sessions.length > 0.5).map((p) => p.key);
  // Out of the golden set's scope: never offered to the judge, so one cannot take a labeled priority's slot.
  const candidates = produced.filter((p) => !standingLike.includes(p.key) && !unlabeled.includes(p.key));

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

  read = byLabelId(read);
  const holder = new Map<string, string>();
  for (const p of produced) for (const s of p.sessions) holder.set(labelId(s), p.key);
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
      out.push({ produced: m.produced, golden: m.golden, produced_step: ps[a.produced]!.title, golden_step: gs[a.golden]!.title, golden_task: gs[a.golden]!.task, produced_done: ps[a.produced]!.done, golden_done: gs[a.golden]!.done, scope: a.scope, reason: a.reason });
    }
    return out;
  }));
  const steps = stepPairs.flat();
  const flagged = steps.filter((s) => s.produced_done && !s.golden_done && s.scope !== 'narrower');
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
    step_done: ratio(steps.filter((s) => doneAgrees(s.scope, s.produced_done, s.golden_done)).length, steps.length),
    false_done: realFalseDone.length,
  };
  const pass = (metrics.recall ?? 0) >= BAR.recall && (metrics.precision ?? 0) >= BAR.precision && (metrics.sessions ?? 0) >= BAR.sessions && metrics.false_done <= BAR.false_done;
  return {
    metrics, pass, recall, precision, unlabeled, standing_like: standingLike, matches,
    sessions: { results: sessionResults, not_read: notRead },
    steps: { pairs: steps, false_done: realFalseDone, stale_done: staleFalseDone, part_done: steps.filter((s) => s.produced_done && !s.golden_done && s.scope === 'narrower') },
  };
}

export type Score = Awaited<ReturnType<typeof score>>;

// ---------------------------------------------------------------- the model judge

const MATCH_SYSTEM = `You compare two lists of one person's priorities over the same two weeks of work: a reference list a person checked by hand, and a list a program inferred from their sessions. A priority is an outcome the person drives at for a day to a month.

Match an inferred priority to a reference priority when both name the same outcome, even in other words or at a somewhat wider or narrower scope. Sessions both list are evidence, but the outcome decides: two priorities that share a session can still be different outcomes. Inferred priorities are kept per workspace and never span two, so a reference priority whose work spans workspaces may match one inferred priority in each workspace; an inferred priority matches at most one reference priority. Leave a priority unmatched when nothing on the other side is the same outcome. Give one short reason per match.`;

const STEPS_SYSTEM = `You align two critical paths of the same priority: the steps a program inferred and the steps a person checked by hand. Pair an inferred step with the reference step that is the same piece of work, even in other words, or one whose work holds it or is held by it. Give each pair a scope: "same" when both name the same work; "narrower" when the inferred step's work is a piece of the reference step's own work, so that finishing the reference step finishes it too; "wider" when the reference step's work is a piece of the inferred step's. A step that only leads up to or supports the other, such as its design, plan, handoff or a prerequisite, is not a piece of its work: leave that pair out. Use "narrower" sparingly: it excuses an inferred step marked done while the reference step is open, so a wrong "narrower" hides a false claim. When unsure which scope holds, answer "same". In each pair, first give the reason, saying which step's work holds which, then the scope that follows from it. Each step pairs at most once. Leave a step unpaired when nothing on the other side is the same work or holds it.`;

const MATCH_SCHEMA = {
  type: 'object',
  properties: { matches: { type: 'array', items: { type: 'object', properties: { inferred: { type: 'string' }, reference: { type: 'string' }, reason: { type: 'string' } }, required: ['inferred', 'reference', 'reason'], additionalProperties: false } } },
  required: ['matches'],
  additionalProperties: false,
};
const STEPS_SCHEMA = {
  type: 'object',
  properties: { pairs: { type: 'array', items: { type: 'object', properties: { inferred: { type: 'integer' }, reference: { type: 'integer' }, reason: { type: 'string' }, scope: { type: 'string', enum: ['same', 'narrower', 'wider'] } }, required: ['inferred', 'reference', 'reason', 'scope'], additionalProperties: false } } },
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
      return (out.pairs ?? []).map((p: any) => ({ produced: p.inferred, golden: p.reference, scope: p.scope, reason: p.reason }));
    },
  };
  return { judge, spent };
}

// ---------------------------------------------------------------- the classifier's score

/**
 * A golden label names a session by its 7-character short id; a run names it by
 * that, a longer prefix of its id (priorityPassInputs sessionNames) or its
 * whole id (the classifier replay). A label two read sessions share cannot say
 * which it meant, so it is left out, as if not read.
 */
const labelId = (id: string) => id.slice(0, 7);
function byLabelId(read: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const shared = new Set<string>();
  for (const [id, title] of read) {
    const label = labelId(id);
    if (out.has(label)) shared.add(label);
    out.set(label, title);
  }
  for (const label of shared) out.delete(label);
  return out;
}

/** The golden priorities held out of a classifier replay's seed: every `every`th (none at 0). */
export function heldOut(golden: Golden, every: number): Set<string> {
  return new Set(every > 0 ? golden.priorities.filter((_, i) => i % every === every - 1).map((g) => g.id) : []);
}

/** Characters a typed word takes, space included, for a words:N cadence. */
const CHARS_PER_WORD = 6;

/** A session's reads kept by a words:N cadence: the first, then each once N more words were typed since the last kept. All with no N. */
export function keptReads(asks: EvalAsk[], wordsPer: number | null): EvalAsk[] {
  if (!wordsPer) return asks;
  let since = Infinity;
  return asks.filter((a) => {
    since += a.chars ?? 0;
    if (since < wordsPer * CHARS_PER_WORD) return false;
    since = 0;
    return true;
  });
}

export type ReplayRead = { session: string; title: string; choice: ClassifierChoice | null; asks: Array<{ trigger: string; choice: ClassifierChoice | null; reason: string }>; inherited_from?: string };

/**
 * A re-reading cadence over a window's sessions, in time order across them as
 * live would see it: each kept read files the session where `read` says (the
 * latest read stands, so a session moves, or leaves on a "new"), and sees the
 * placements made before it; a session with no reads takes its parent's
 * placement at its first activity. `priorities` holds the placements as they
 * end.
 */
export async function replayReads(
  sessions: EvalSession[],
  priorities: PassPriority[],
  wordsPer: number | null,
  read: (priorities: PassPriority[], session: EvalAsk['session']) => Promise<{ choice: ClassifierChoice | null; reason: string }>,
): Promise<ReplayRead[]> {
  const placementOf = (id: string) => {
    for (const p of priorities) for (const s of p.sessions) if (s.id === id) return { priority: p.short_id, step: s.step_key };
    return null;
  };
  const events = sessions.flatMap((s) => (s.asks.length ? keptReads(s.asks, wordsPer).map((a) => ({ at: a.at, s, a })) : [{ at: s.last_active, s, a: null as EvalAsk | null }]));
  const rows = new Map<string, ReplayRead>();
  for (const { s, a } of events.sort((x, y) => x.at - y.at)) {
    let row = rows.get(s.id);
    if (!a) {
      const inherited = s.parent ? placementOf(s.parent) : null;
      if (!inherited) continue;
      row = { session: s.id, title: s.title, choice: inherited, asks: [], inherited_from: s.parent! };
    } else {
      const reply = await read(priorities, a.session);
      row ??= { session: s.id, title: s.title, choice: null, asks: [] };
      row.asks.push({ trigger: a.trigger, ...reply });
      row.choice = reply.choice;
    }
    rows.set(s.id, row);
    for (const p of priorities) p.sessions = p.sessions.filter((x) => x.id !== s.id);
    const choice = row.choice;
    if (choice && choice !== 'new') priorities.find((x) => x.short_id === choice.priority)?.sessions.unshift({ id: s.id, title: s.title, step_key: choice.step, last_active: s.last_active });
  }
  return [...rows.values()];
}

/**
 * How each labeled session's reads went, in order: whether its first read
 * filed it right (what shows at once), and the share of its reads that did
 * (how often it sat right while it ran). A seeded goal's session is right
 * under its goal; a held-out goal's, when the read says "new".
 */
export function scoreReads(golden: Golden, placements: Array<{ session: string; asks: Array<{ choice: ClassifierChoice | null }> }>, held: Set<string>) {
  const goldenOf = (pri: string) => golden.priorities[Number(/^pri-(\d+)$/.exec(pri)?.[1] ?? 0) - SEED_BASE - 1]?.id ?? null;
  const right = (label: string, c: ClassifierChoice | null) => (held.has(label) ? c === 'new' : !!c && c !== 'new' && goldenOf(c.priority) === label);
  const rows = placements.flatMap((p) => {
    const label = golden.session_labels[labelId(p.session)];
    return label && p.asks.length ? [p.asks.map((a) => right(label, a.choice))] : [];
  });
  const first = rows.filter((r) => r[0]).length;
  const life = rows.length ? rows.reduce((sum, r) => sum + r.filter(Boolean).length / r.length, 0) / rows.length : null;
  return { sessions: rows.length, first: { correct: first, of: rows.length, score: ratio(first, rows.length) }, life, reads: rows.reduce((n, r) => n + r.length, 0) };
}

/**
 * The classifier's session score over the labeled sessions the window read.
 * A seeded pri-N is golden priority N (seedState numbering). A session of a
 * seeded goal is right when placed under that goal (placement), one of a
 * held-out goal when left unplaced (new detection), and a standing one when
 * left unplaced (standing, never asked about, so free).
 */
export function scoreClassifier(golden: Golden, produced: Produced[], read: Map<string, string>, held: Set<string>) {
  const goldenOf = (key: string) => golden.priorities[Number(/:pri-(\d+)$/.exec(key)?.[1] ?? 0) - SEED_BASE - 1]?.id ?? null;
  read = byLabelId(read);
  const holder = new Map<string, string>();
  for (const p of produced) for (const id of p.sessions) holder.set(labelId(id), p.key);
  const labels: Array<[string, string]> = [...Object.entries(golden.session_labels), ...golden.standing_sessions.map((id) => [id, 'standing'] as [string, string])];
  const results = labels.filter(([id]) => read.has(id)).map(([session, label]) => {
    const by = holder.get(session) ?? null;
    const kind = label === 'standing' ? ('standing' as const) : held.has(label) ? ('new' as const) : ('placement' as const);
    const correct = kind === 'placement' ? by !== null && goldenOf(by) === label : by === null;
    return { session, title: read.get(session) ?? '', label, kind, produced: by, correct };
  });
  const of = (kinds: string[]) => {
    const rs = results.filter((r) => kinds.includes(r.kind));
    return { correct: rs.filter((r) => r.correct).length, of: rs.length, score: ratio(rs.filter((r) => r.correct).length, rs.length) };
  };
  const metrics = { placement: of(['placement']), new: of(['new']), combined: of(['placement', 'new']), standing: of(['standing']), as_pass: of(['placement', 'standing']) };
  return { metrics, pass: (metrics.combined.score ?? 0) >= BAR.sessions, results, not_read: labels.filter(([id]) => !read.has(id)).map(([id]) => id) };
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
type PassRun = { produced: Produced[]; read: Map<string, string>; scoredNames: string[]; workspaces: unknown[]; passUsd: number; args: { golden: string; user: string; workspace: string; from: string; to: string; chunk: number | null; system_file?: string | null; system_sha?: string; seed_golden?: boolean; classifier?: boolean; model?: string; holdout?: number; cadence?: string } };

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
  const classifier = rescore ? !!rescore.args.classifier : process.argv.includes('--classifier');
  const key = evalsApiKey();
  if (!key && !classifier) throw new Error('no evals API key: set CODECAST_EVALS_ANTHROPIC_KEY or the keychain item (./evals doctor)');

  const run: PassRun = rescore
    ? {
        produced: rescore.produced as Produced[],
        read: new Map<string, string>(rescore.workspaces.filter((w: any) => w.scored).flatMap((w: any) => w.sessions_read.map((s: any) => [s.id, s.title]))),
        scoredNames: rescore.workspaces.filter((w: any) => w.scored).map((w: any) => w.name),
        workspaces: rescore.workspaces,
        passUsd: rescore.cost.pass_usd as number,
        args: { ...rescore.args, golden: goldenPath },
      }
    : classifier
      ? process.argv.includes('--local') ? await runClassifierLocal(golden, goldenPath, arg) : runClassifier(golden, goldenPath, arg)
      : runPasses(golden, goldenPath, arg);
  const { produced, read, args } = run;
  if (classifier) return reportClassifier(golden, run, out, rescore ? home(arg('rescore')) : null);
  // One workspace is scored only against the golden priorities whose sessions it read.
  const scopedGolden: Golden = args.workspace === 'all'
    ? golden
    : { ...golden, priorities: golden.priorities.filter((g) => Object.entries(golden.session_labels).some(([s, id]) => id === g.id && byLabelId(read).has(s))) };

  const { judge, spent } = modelJudge(key!);
  const s = await score(scopedGolden, produced, read, judge, castTaskStatus);

  const fmt = (n: number | null) => (n == null ? '  -  ' : n.toFixed(2));
  const titleOf = new Map([...golden.priorities.map((g) => [g.id, g.title] as const), ...produced.map((p) => [p.key, p.title] as const)]);
  const doneLine = (label: string) => (f: Score['steps']['pairs'][number] & { task_status?: string | null }) =>
    `  ${label} ${f.produced} "${f.produced_step}" ~ ${f.golden} "${f.golden_step}" · task ${f.golden_task ?? 'none'}${f.golden_task && f.task_status !== undefined ? ` (${f.task_status ?? 'not found'} now)` : ''}`;
  const lines = [
    `window ${args.from}..${args.to} · ${run.scoredNames.join(', ')} · pass ${PRIORITY_PASS_MODEL} · prompt ${args.system_file ? `${args.system_file} ` : ''}${args.system_sha ?? '(not recorded)'} · judge ${JUDGE_MODEL}${rescore ? ' · rescored' : ''}`,
    `recall          ${fmt(s.metrics.recall)}  ${s.recall.matched} of ${s.recall.of} active golden priorities matched   bar ≥ ${BAR.recall}`,
    `precision       ${fmt(s.metrics.precision)}  ${s.precision.matched} of ${s.precision.of} active produced priorities in the golden set's scope matched (${s.unlabeled.length} unlabeled)   bar ≥ ${BAR.precision}`,
    `session mapping ${fmt(s.metrics.sessions)}  ${s.sessions.results.filter((r) => r.correct).length} of ${s.sessions.results.length} labeled sessions in the window (${s.sessions.not_read.length} not read)   bar ≥ ${BAR.sessions}`,
    `step done       ${fmt(s.metrics.step_done)}  over ${s.steps.pairs.length} aligned critical steps`,
    `false done      ${s.metrics.false_done} real · ${s.steps.stale_done.length} where the golden set is stale · ${s.steps.part_done.length} a done part of an open golden step   bar = ${BAR.false_done} real`,
    `cost            pass $${run.passUsd.toFixed(2)} · judge $${spent.usd.toFixed(2)} (${spent.calls} calls)`,
    ...s.recall.missed.map((id) => `  missed     ${id} "${titleOf.get(id)}"`),
    ...s.precision.unmatched.map((k) => `  unmatched  ${k} "${titleOf.get(k)}"${s.standing_like.includes(k) ? ' (mostly standing sessions)' : ''}`),
    ...s.unlabeled.map((k) => `  unlabeled, needs a person  ${k} "${titleOf.get(k)}"`),
    ...s.steps.false_done.map(doneLine('false done')),
    ...s.steps.stale_done.map(doneLine('stale done')),
    ...s.steps.part_done.map(doneLine('part done ')),
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

/** Seeded priorities are numbered from here, clear of the person's real pri-N (a `serves` hint names those). */
export const SEED_BASE = 100_000;

/** The classifier replay's summary: its own scores (scoreClassifier), not the pass's. */
function reportClassifier(golden: Golden, run: PassRun, out: string, rescoredFrom: string | null) {
  const { args, produced, read } = run;
  const held = heldOut(golden, args.holdout ?? 0);
  const s = scoreClassifier(golden, produced, read, held);
  const fmt = (m: { correct: number; of: number; score: number | null }) => `${m.score == null ? '  -  ' : m.score.toFixed(2)}  ${m.correct} of ${m.of}`;
  const placements = (run.workspaces as Array<{ placements?: Array<{ session: string; choice: ClassifierChoice | null; asks: Array<{ trigger: string; choice: ClassifierChoice | null }>; inherited_from?: string }> }>).flatMap((w) => w.placements ?? []);
  const reads = scoreReads(golden, placements, held);
  const titleOf = new Map(golden.priorities.map((g) => [g.id, g.title]));
  const producedTitle = new Map(produced.map((p) => [p.key, p.title]));
  const lines = [
    `window ${args.from}..${args.to} · ${run.scoredNames.join(', ')} · classifier ${args.model}${rescoredFrom ? ' · rescored' : ''} · held out ${held.size ? [...held].join(', ') : 'none'} (every ${args.holdout || '-'})`,
    `placement       ${fmt(s.metrics.placement)} sessions of seeded goals placed under their own goal`,
    `new detection   ${fmt(s.metrics.new)} sessions of held-out goals left unplaced`,
    `combined        ${fmt(s.metrics.combined)} (${s.not_read.length} labeled sessions not read)   bar ≥ ${BAR.sessions}`,
    `standing        ${fmt(s.metrics.standing)} standing sessions left unplaced (never asked about)`,
    `as the pass scores it ${fmt(s.metrics.as_pass)} placement and standing; the pass's seeded run: 0.86 (compare at --holdout 0)`,
    `asks            ${placements.filter((p) => p.asks.length).length} sessions asked (${placements.filter((p) => p.asks.length > 1).length} again at their first pin) · ${placements.filter((p) => p.inherited_from).length} inherited from their parent · ${placements.filter((p) => p.choice && p.choice !== 'new').length} placed, ${placements.filter((p) => p.choice === 'new').length} new, ${placements.filter((p) => !p.choice).length} unreadable`,
    `first read      ${fmt(reads.first)} labeled sessions filed right at their first read (cadence ${args.cadence ?? 'first'})`,
    `over its life   ${reads.life == null ? '  -  ' : reads.life.toFixed(2)}  mean share of a session's reads that filed it right (${reads.reads} reads over ${reads.sessions} sessions)${args.cadence && args.cadence !== 'first' ? '; every replayed read sees the first generated title' : ''}`,
    `cost            classifier $${run.passUsd.toFixed(3)}`,
    ...s.results.filter((r) => !r.correct && r.kind !== 'standing').map((r) => `  wrong ${r.kind.padEnd(9)} ${r.session} "${r.title}" · golden ${r.label} "${titleOf.get(r.label)}" · placed ${r.produced ? `${r.produced} "${producedTitle.get(r.produced)}"` : 'nowhere'}`),
    `verdict         ${s.pass ? 'PASS' : 'FAIL'} (combined)`,
  ];
  console.log(lines.join('\n'));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'result.json'), JSON.stringify({ args, ...(rescoredFrom ? { rescored_from: rescoredFrom } : {}), cost: { pass_usd: run.passUsd }, workspaces: run.workspaces, produced, score: s }, null, 2));
  writeFileSync(join(out, 'summary.txt'), lines.join('\n') + '\n');
  console.error(`wrote ${out}`);
}

/** The golden priorities as the pass would hold them already: titles and critical steps with their tasks, no sessions, nothing done. */
export function seedState(golden: Golden, window_start: number) {
  const priorities: PassPriority[] = golden.priorities.map((g, i) => ({
    short_id: `pri-${SEED_BASE + i + 1}`,
    title: g.title,
    summary: g.title,
    status: g.status === 'done' ? 'done' : 'active',
    rank: null,
    rank_set_by: 'pass',
    serves: null,
    steps: (g.critical ?? []).map((s, j) => ({ key: `s${j + 1}`, title: s.title, tier: 'critical', tier_set_by: 'person', refs: s.task ? [{ kind: 'task', id: s.task }] : [], done: false })),
    last_active_at: window_start,
    sessions: [],
  }));
  return { cursor_at: window_start, priorities, tasks: [], next_id: SEED_BASE + priorities.length };
}

/** The user's workspaces in scope and the window, from the flags. */
function replayScope(golden: Golden, arg: (name: string, fallback?: string) => string) {
  const scope = arg('workspace', 'all');
  const from = arg('from', golden.window[0]);
  const to = arg('to', golden.window[1]);
  const targets = convexRun<{ user_id: string; workspaces: Array<{ workspace: string; name: string }> }>('priorityPassEval:evalTargets', { user: arg('user') });
  const workspaces = scope === 'all'
    ? targets.workspaces
    : scope === 'personal'
      ? targets.workspaces.filter((w) => w.workspace === `user:${targets.user_id}`)
      : targets.workspaces.filter((w) => w.workspace === scope);
  if (!workspaces.length) throw new Error(`no workspace ${scope} for this user`);
  return { scope, from, to, user_id: targets.user_id, workspaces, window_start: Date.parse(`${from}T00:00:00Z`), window_end: Date.parse(`${to}T00:00:00Z`) + DAY };
}

/** What a scored replay produced, keyed `<workspace name>:<pri-N>`. */
function producedOf(runs: Array<{ name: string; priorities: PassPriority[] }>): Produced[] {
  return runs.flatMap((r) => r.priorities.map((p) => ({
    key: `${r.name}:${p.short_id}`,
    workspace: r.name,
    title: p.title,
    summary: p.summary,
    status: p.status,
    steps: p.steps.map((s) => ({ title: s.title, tier: s.tier, done: s.done })),
    sessions: p.sessions.map((s) => s.id),
  })));
}

type ClassifierEval = { placements: Array<{ session: string; title: string; choice: ClassifierChoice | null; asks: Array<{ trigger: string }>; inherited_from?: string }>; priorities: PassPriority[]; sessions_read: Array<{ id: string; title: string }>; cost_usd: number; resume?: unknown };

/** The classifier's seed: the golden priorities but the held-out ones, each open, as it was during the window. */
export function classifierSeed(golden: Golden, window_start: number, held: Set<string>): PassPriority[] {
  return seedState(golden, window_start).priorities.filter((_, i) => !held.has(golden.priorities[i]!.id)).map((p) => ({ ...p, status: 'active' as const }));
}

/** Runs the classifier in production for each workspace in scope against the seeded golden priorities, resuming until each window is read. */
function runClassifier(golden: Golden, goldenPath: string, arg: (name: string, fallback?: string) => string): PassRun {
  const { scope, from, to, user_id, workspaces, window_start, window_end } = replayScope(golden, arg);
  const model = process.argv.includes('--model') ? arg('model') : PRIORITY_CLASSIFIER_MODEL;
  const holdout = Number(arg('holdout', '4'));
  const held = heldOut(golden, holdout);
  const labeled = new Set([...Object.keys(golden.session_labels), ...golden.standing_sessions]);
  const runs: Array<{ workspace: string; name: string; result: ClassifierEval; scored: boolean }> = [];
  for (const w of workspaces) {
    const result: ClassifierEval = { placements: [], priorities: classifierSeed(golden, window_start, held), sessions_read: [], cost_usd: 0 };
    let resume: unknown;
    do {
      console.error(`${w.name}: classifier ${resume ? '(resumed)' : ''}…`);
      const r = convexRun<ClassifierEval>('priorityClassifierEval:evalClassify', { user_id, workspace: w.workspace, window_start, window_end, model, ...(resume ? { resume } : { priorities: result.priorities }) });
      result.placements.push(...r.placements);
      result.priorities = r.priorities;
      result.cost_usd += r.cost_usd;
      result.sessions_read.push(...r.sessions_read);
      resume = r.resume;
    } while (resume);
    const scored = scope !== 'all' || result.sessions_read.some((s) => labeled.has(labelId(s.id)));
    runs.push({ ...w, result, scored });
    const tally = (f: (c: unknown) => boolean) => result.placements.filter((p) => f(p.choice)).length;
    console.error(`${w.name}: ${result.sessions_read.length} sessions, ${result.placements.length} classified (${tally((c) => !!c && c !== 'new')} placed, ${tally((c) => c === 'new')} new, ${tally((c) => !c)} unreadable), $${result.cost_usd.toFixed(3)}${scored ? '' : ' (no golden sessions: not scored)'}`);
  }
  const scoredRuns = runs.filter((r) => r.scored);
  return {
    read: new Map(scoredRuns.flatMap((r) => r.result.sessions_read.map((s) => [s.id, s.title] as [string, string]))),
    produced: producedOf(scoredRuns.map((r) => ({ name: r.name, priorities: r.result.priorities }))),
    scoredNames: scoredRuns.map((r) => r.name),
    workspaces: runs.map((r) => ({ workspace: r.workspace, name: r.name, scored: r.scored, sessions_read: r.result.sessions_read, cost_usd: r.result.cost_usd, placements: r.result.placements })),
    passUsd: runs.reduce((sum, r) => sum + r.result.cost_usd, 0),
    args: { golden: goldenPath, user: arg('user'), workspace: scope, from, to, chunk: null, seed_golden: true, classifier: true, model, holdout },
  };
}

/** What live would ask in one workspace over the window (evalFacts), read once from prod: the classifier's whole input but the priorities. */
type ClassifierFacts = { person: string; sessions: EvalSession[]; tasks: ClassifierTask[]; sessions_read: Array<{ id: string; title: string; kind?: string; asked?: boolean }> };

/** Reads one workspace's facts through passInputs and evalFacts, chunk by chunk as evalClassify does. Read-only. */
function readClassifierFacts(user_id: string, workspace: string, window_start: number, window_end: number, taskIds: string[], everyMessage: boolean): ClassifierFacts {
  const now = Math.min(window_end + 5 * 60_000, Date.now());
  const facts: ClassifierFacts = { person: '', sessions: [], tasks: [], sessions_read: [] };
  let cursor = window_start;
  for (;;) {
    const read = convexRun<{ input: { person: string; sessions: Array<{ id: string; title: string; kind?: string; typed: Array<{ at: number }>; pin_events: Array<{ at: number }>; last_active: number }> }; conversations: Record<string, string>; more: boolean; read_to: number }>(
      'priorityPassInputs:passInputs', { user_id, workspace, now, window_start: cursor });
    facts.person = read.input.person;
    const firstAt = (s: (typeof read.input.sessions)[number]) => Math.min(...[...s.typed, ...s.pin_events].map((r) => r.at), s.last_active);
    const wanted = read.input.sessions.filter((s) => s.kind !== 'role').map((s) => ({ conversation_id: read.conversations[s.id], first_at: firstAt(s) }));
    // An ask per message reads far more per session: a few sessions a call keeps each query inside Convex's read limit.
    const per = everyMessage ? 6 : wanted.length || 1;
    const chunk: { sessions: EvalSession[] } = { sessions: [] };
    for (let i = 0; i < Math.max(wanted.length, 1); i += per) {
      const part = convexRun<{ sessions: EvalSession[]; tasks: ClassifierTask[] }>('priorityClassifierEval:evalFacts', {
        workspace,
        sessions: wanted.slice(i, i + per),
        tasks: facts.tasks.length ? [] : taskIds,
        ...(everyMessage ? { every_message: true, until: window_end } : {}),
      });
      if (!facts.tasks.length) facts.tasks = part.tasks;
      chunk.sessions.push(...part.sessions);
    }
    facts.sessions.push(...chunk.sessions);
    const cut = chunk.sessions.filter((x) => x.truncated).length;
    if (cut) console.error(`${workspace}: ${cut} session(s) had more typed messages in the window than one read scans; read over their first part`);
    const asked = new Set(chunk.sessions.filter((x) => x.asks.length).map((x) => x.id));
    facts.sessions_read.push(...read.input.sessions.map((s) => ({ id: read.conversations[s.id] ?? s.id, title: s.title, kind: s.kind, asked: asked.has(read.conversations[s.id] ?? s.id) })));
    if (!read.more || read.read_to <= cursor) return facts;
    cursor = read.read_to;
  }
}

/**
 * --local: the classifier replay run here, on the working tree's prompt and
 * the evals' key, so a prompt or input change is measured before it deploys.
 * Prod only supplies the facts (read-only), saved to <out>/facts.json and
 * reused with --facts <path>. The loop is evalClassify's: oldest first, a
 * child takes its placed parent's placement, a "new" at the title is asked
 * again at the first pin, and each placement becomes an example for later
 * sessions. Each ask's reason is kept in the result.
 */
async function runClassifierLocal(golden: Golden, goldenPath: string, arg: (name: string, fallback?: string) => string): Promise<PassRun> {
  const key = evalsApiKey();
  if (!key) throw new Error('no evals API key: set CODECAST_EVALS_ANTHROPIC_KEY or the keychain item (./evals doctor)');
  const model = process.argv.includes('--model') ? arg('model') : PRIORITY_CLASSIFIER_MODEL;
  const holdout = Number(arg('holdout', '4'));
  const held = heldOut(golden, holdout);
  const labeled = new Set([...Object.keys(golden.session_labels), ...golden.standing_sessions]);
  const factsPath = process.argv.includes('--facts') ? resolve(arg('facts').replace(/^~/, homedir())) : null;
  type Saved = { args: { from: string; to: string; workspace: string }; window_start: number; every_message?: boolean; workspaces: Array<{ workspace: string; name: string; facts: ClassifierFacts }> };
  // first: live's cadence (the title, then the first pin after a "new"). message, or words:N: re-read the session at each
  // typed message, or once N more words have been typed, the latest read standing (needs facts read with an ask a message).
  const cadence = process.argv.includes('--cadence') ? arg('cadence') : 'first';
  const wordsPer = /^words:(\d+)$/.exec(cadence)?.[1];
  if (cadence !== 'first' && cadence !== 'message' && !wordsPer) throw new Error(`--cadence ${cadence}: first, message or words:N`);
  let saved: Saved;
  if (factsPath) saved = JSON.parse(readFileSync(factsPath, 'utf8'));
  else {
    const { scope, from, to, user_id, workspaces, window_start, window_end } = replayScope(golden, arg);
    const taskIds = [...new Set(golden.priorities.flatMap((g) => (g.critical ?? []).flatMap((s) => (s.task ? [s.task] : []))))];
    saved = { args: { from, to, workspace: scope }, window_start, workspaces: workspaces.map((w) => {
      console.error(`${w.name}: reading facts…`);
      return { ...w, facts: readClassifierFacts(user_id, w.workspace, window_start, window_end, taskIds, cadence !== 'first') };
    }), every_message: cadence !== 'first' };
  }
  if (cadence !== 'first' && !saved.every_message) throw new Error(`--cadence ${cadence} needs facts read with an ask a message: run without --facts first`);
  let usd = 0;
  const ask = async (input: Parameters<typeof classifierRequest>[0]) => {
    for (let attempt = 0; ; attempt++) {
      const res = await postMessages(classifierRequest(input, model), { apiKey: key });
      if (res?.ok) {
        const body = await res.json();
        usd += modelCost(model, body.usage);
        const json = parseJsonBlock(replyText(body));
        return { choice: parseClassifierReply(json, input), reason: String((json as { reason?: unknown })?.reason ?? '') };
      }
      if (attempt >= 3) return { choice: null, reason: `API ${res?.status ?? 'no key'}` };
      await Bun.sleep(2_000 * (attempt + 1));
    }
  };
  const runs = await Promise.all(saved.workspaces.map(async (w) => {
    const priorities = classifierSeed(golden, saved.window_start, held);
    const tasks = new Map(w.facts.tasks.map((t) => [t.short_id, t]));
    const placements: Array<{ session: string; title: string; choice: ClassifierChoice | null; asks: Array<{ trigger: string; choice: ClassifierChoice | null; reason: string }>; inherited_from?: string }> = [];
    const placementOf = (id: string) => {
      for (const p of priorities) for (const s of p.sessions) if (s.id === id) return { priority: p.short_id, step: s.step_key };
      return null;
    };
    if (cadence !== 'first') {
      placements.push(...(await replayReads(w.facts.sessions, priorities, wordsPer ? Number(wordsPer) : null, (held, session) =>
        ask({ person: w.facts.person, priorities: classifierPriorities(held, tasks), session }))));
    } else for (const s of w.facts.sessions) {
      const inherited = s.parent ? placementOf(s.parent) : null;
      let choice: ClassifierChoice | null = inherited;
      const asks: (typeof placements)[number]['asks'] = [];
      if (!inherited) {
        for (const a of s.asks) {
          if (asks.length && choice !== 'new') break;
          const reply = await ask({ person: w.facts.person, priorities: classifierPriorities(priorities, tasks), session: a.session });
          choice = reply.choice;
          asks.push({ trigger: a.trigger, ...reply });
        }
      }
      if (!inherited && !s.asks.length) continue;
      placements.push({ session: s.id, title: s.title, choice, asks, ...(inherited ? { inherited_from: s.parent! } : {}) });
      if (choice && choice !== 'new') priorities.find((x) => x.short_id === choice.priority)?.sessions.unshift({ id: s.id, title: s.title, step_key: choice.step, last_active: s.last_active });
    }
    const scored = saved.args.workspace !== 'all' || w.facts.sessions_read.some((s) => labeled.has(labelId(s.id)));
    return { workspace: w.workspace, name: w.name, scored, sessions_read: w.facts.sessions_read, priorities, placements };
  }));
  const scoredRuns = runs.filter((r) => r.scored);
  const out = resolve(arg('out', join(homedir(), '.codecast', 'emergent-goals', 'calibration', new Date().toISOString().replace(/[:.]/g, '-'))).replace(/^~/, homedir()));
  if (!factsPath) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'facts.json'), JSON.stringify(saved));
    console.error(`facts saved: ${join(out, 'facts.json')} (reuse with --facts)`);
  }
  return {
    read: new Map(scoredRuns.flatMap((r) => r.sessions_read.map((s) => [s.id, s.title] as [string, string]))),
    produced: producedOf(scoredRuns.map((r) => ({ name: r.name, priorities: r.priorities }))),
    scoredNames: scoredRuns.map((r) => r.name),
    workspaces: runs.map(({ priorities: _, ...r }) => r),
    passUsd: usd,
    args: { golden: goldenPath, user: process.argv.includes('--user') ? arg('user') : '', workspace: saved.args.workspace, from: saved.args.from, to: saved.args.to, chunk: null, seed_golden: true, classifier: true, model, holdout, cadence },
  };
}

/** Runs evalPass in production for each workspace the user holds, resuming until each window is read. */
function runPasses(golden: Golden, goldenPath: string, arg: (name: string, fallback?: string) => string): PassRun {
  const { scope, from, to, user_id, workspaces, window_start, window_end } = replayScope(golden, arg);
  const chunk = process.argv.includes('--chunk') ? Number(arg('chunk')) : null;
  // A candidate system prompt replaces the pass's for this replay; the sha says which prompt a result came from.
  const systemFile = process.argv.includes('--system-file') ? resolve(arg('system-file').replace(/^~/, homedir())) : null;
  const system = systemFile ? readFileSync(systemFile, 'utf8') : PRIORITY_PASS_SYSTEM;
  const system_sha = createHash('sha256').update(system).digest('hex').slice(0, 12);

  const seed = process.argv.includes('--seed-golden');
  const labeled = new Set([...Object.keys(golden.session_labels), ...golden.standing_sessions]);
  const runs: Array<{ workspace: string; name: string; result: EvalResult; scored: boolean }> = [];
  for (const w of workspaces) {
    const result: EvalResult = { outputs: [], priorities: [], cost_usd: 0, sessions_read: [], omitted: [] };
    let resume: unknown = seed ? seedState(golden, window_start) : undefined;
    do {
      console.error(`${w.name}: pass ${resume ? '(resumed)' : ''}…`);
      const r = convexRun<EvalResult>('priorityPassEval:evalPass', { user_id, workspace: w.workspace, window_start, window_end, ...(chunk ? { chunk } : {}), ...(resume ? { resume } : {}), ...(systemFile ? { system } : {}) });
      result.outputs.push(...r.outputs);
      result.priorities = r.priorities;
      result.cost_usd += r.cost_usd;
      result.sessions_read.push(...r.sessions_read);
      result.omitted.push(...r.omitted);
      resume = r.resume;
    } while (resume);
    // With every workspace, one that holds none of the golden set's sessions is not scored: its priorities are outside the set.
    const scored = scope !== 'all' || result.sessions_read.some((s) => labeled.has(labelId(s.id)));
    runs.push({ ...w, result, scored });
    console.error(`${w.name}: ${result.sessions_read.length} sessions, ${result.priorities.length} priorities, $${result.cost_usd.toFixed(2)}${scored ? '' : ' (no golden sessions: not scored)'}`);
  }

  const scoredRuns = runs.filter((r) => r.scored);
  return {
    read: new Map(scoredRuns.flatMap((r) => r.result.sessions_read.map((s) => [s.id, s.title] as [string, string]))),
    produced: producedOf(scoredRuns.map((r) => ({ name: r.name, priorities: r.result.priorities }))),
    scoredNames: scoredRuns.map((r) => r.name),
    workspaces: runs.map((r) => ({ workspace: r.workspace, name: r.name, scored: r.scored, sessions_read: r.result.sessions_read, omitted: r.result.omitted, cost_usd: r.result.cost_usd, outputs: r.result.outputs })),
    passUsd: runs.reduce((sum, r) => sum + r.result.cost_usd, 0),
    args: { golden: goldenPath, user: arg('user'), workspace: scope, from, to, chunk, system_file: systemFile, system_sha, seed_golden: seed },
  };
}

if (import.meta.main) await main();
