import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Freeze } from '@platform/evals';

import { parseJsonBlock } from '../../../convex/convex/lib/anthropic';
import { runCall } from '../adapters/dryRun';
import { surfaceRuns, type SurfaceRun } from '../adapters/runs';
import { PROD_DEFAULT_MODEL } from '../models';
import { homePaths, treeRoot } from '../paths';
import { actionsOf } from '../surfaces/guidance';

// Hill-climbs the guidance against the freezes a person's corrections became
// (docs/prompting.md P9, run by a machine): replay them on the tree as it
// stands, hand the failing reps to a rewriter that edits the guidance at the
// instruction that caused the miss, replay again, keep the edit only when the
// corrections score better, and stop when they pass or the rounds run out.
// Each round's replay is a fresh `./evals check` process, because the guidance
// is rendered from source the process imported.

/** The source files the guidance renders from: an edit's text must sit in exactly one place across them. */
export const GUIDANCE_SOURCES = ['packages/shared/contracts/snippets.ts', 'packages/shared/contracts/snippetsWorkflow.ts'];

/** Rendered text as it is written inside a template literal. */
export const sourceForm = (s: string): string => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

export interface Edit {
  find: string;
  replace: string;
}

/** Applies edits to the sources in memory; each find must occur exactly once across them, or the edit is refused with the reason. */
export function applyEdits(files: Record<string, string>, edits: Edit[]): { files: Record<string, string>; refused: Array<{ edit: Edit; why: string }> } {
  const next = { ...files };
  const refused: Array<{ edit: Edit; why: string }> = [];
  for (const edit of edits) {
    const find = sourceForm(edit.find);
    const hits = Object.entries(next).flatMap(([path, text]) => {
      const first = text.indexOf(find);
      if (first < 0) return [];
      return text.indexOf(find, first + 1) >= 0 ? [{ path, many: true }] : [{ path, many: false }];
    });
    if (!edit.find.trim()) refused.push({ edit, why: 'empty find' });
    else if (!hits.length) refused.push({ edit, why: 'the find text is not in the guidance source as written (it may span generated text, like a version stamp or a shared constant): quote a shorter run of plain prose' });
    else if (hits.length > 1 || hits[0]!.many) refused.push({ edit, why: 'the find text occurs more than once: quote more of its sentence' });
    else next[hits[0]!.path] = next[hits[0]!.path]!.replace(find, () => sourceForm(edit.replace));
  }
  return { files: next, refused };
}

export const readSources = (root = treeRoot()): Record<string, string> => Object.fromEntries(GUIDANCE_SOURCES.map((p) => [p, readFileSync(join(root, p), 'utf8')]));

export class SourcesChanged extends Error {}

/**
 * The guidance sources as the climb holds them. Every write first checks that
 * the files still hold what the climb last wrote (or found), so an edit
 * another session made underneath is never overwritten: the write refuses and
 * says which file moved.
 */
export class GuidanceSources {
  private expected: Record<string, string>;
  constructor(
    readonly original: Record<string, string>,
    private readonly root = treeRoot(),
  ) {
    this.expected = original;
  }
  write(files: Record<string, string>): void {
    const disk = readSources(this.root);
    const moved = Object.keys(files).filter((p) => disk[p] !== this.expected[p]);
    if (moved.length) throw new SourcesChanged(`${moved.join(', ')} changed underneath the climb (another edit landed there); nothing was written over it`);
    for (const [p, text] of Object.entries(files)) if (disk[p] !== text) writeFileSync(join(this.root, p), text);
    this.expected = files;
  }
  /** Back to what the climb found; refuses, like write, when the files moved. */
  restore(): void {
    this.write(this.original);
  }
}

/** Whether this checkout is a linked worktree: a climb edits the guidance in place, so it never runs in a shared main checkout. */
export function inWorktree(root = treeRoot()): boolean {
  const q = (arg: string) => spawnSync('git', ['rev-parse', arg], { cwd: root, encoding: 'utf8' }).stdout.trim();
  return q('--git-dir') !== q('--git-common-dir');
}

/** One climb's attempt at a claim, appended to EVALS_HOME/climb/attempts.jsonl whatever it found, so climbs repeated until one wins are visible. */
export interface ClimbAttempt {
  stamp: string;
  base: string;
  final: string | null;
  train: string[];
  heldOut: string[];
  claim: boolean;
  why: string;
}

const attemptsPath = (): string => join(homePaths().root, 'climb', 'attempts.jsonl');

export function readAttempts(): ClimbAttempt[] {
  if (!existsSync(attemptsPath())) return [];
  return readFileSync(attemptsPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ClimbAttempt);
}

export function recordAttempt(a: ClimbAttempt): void {
  mkdirSync(join(homePaths().root, 'climb'), { recursive: true });
  appendFileSync(attemptsPath(), `${JSON.stringify(a)}\n`);
}

/** Earlier attempts that weighed any of these held-out freezes: each one is another draw at the same test. */
export function priorWeighings(heldOut: string[], attempts = readAttempts()): ClimbAttempt[] {
  return attempts.filter((a) => a.final && a.heldOut.some((f) => heldOut.includes(f)));
}

/** A batch's scored reps on this surface: pass or fail, never a crash, a dry rep or an unscored one. */
export async function scoredRuns(batch: string): Promise<SurfaceRun[]> {
  return (await surfaceRuns('guidance')).filter((r) => r.batch === batch && (r.status === 'pass' || r.status === 'fail'));
}

/** Freezes the batch did not score `reps` times: a batch with any is incomplete, and an incomplete batch is no claim. */
export function missingReps(runs: Pick<SurfaceRun, 'freezeId'>[], freezes: string[], reps: number): string[] {
  return freezes.filter((f) => runs.filter((r) => r.freezeId === f).length < reps);
}

/**
 * Why a recorded batch cannot be a climb's baseline, or null: it must hold
 * `reps` scored reps on every freeze, and every rep must have recorded the
 * guidance it ran as `sha`. A rep that recorded none ran something unknown.
 */
export function baselineProblem(runs: Pick<SurfaceRun, 'freezeId' | 'promptSha'>[], freezes: string[], reps: number, sha: string): string | null {
  const missing = missingReps(runs, freezes, reps);
  if (missing.length) return `lacks ${reps} scored reps on ${missing.length} freeze(s) (${missing.map((m) => m.slice(0, 8)).join(', ')}): it cannot weigh the final`;
  const other = runs.filter((r) => r.promptSha !== sha);
  if (other.length) return `has ${other.length} rep(s) that did not record this tree's guidance (promptSha ${other[0]!.promptSha?.slice(0, 12) ?? 'none recorded'}, the tree renders ${sha.slice(0, 12)}): run the climb on the tree it measured`;
  return null;
}

/** What a batch cost, its judge included: every rep it started, a crashed one too. */
export const spentOn = (runs: Pick<SurfaceRun, 'costUsd'>[]): number => runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);

/** Every rep a batch started, whatever became of it: what its spend is counted over. */
export async function batchRuns(batch: string): Promise<SurfaceRun[]> {
  return (await surfaceRuns('guidance')).filter((r) => r.batch === batch);
}

/** The sha a guidance rep records for the prompt it ran (the rendered file, surfaces/guidance). */
export const guidanceSha = (rendered: string): string => createHash('sha256').update(rendered).digest('hex');

export interface Rendered {
  text: string;
  /** The installed file's length, as its budget test measures it. */
  size: number;
  max: number;
  /** Sections whose body is over the per-section budget. */
  sectionsOver: string[];
}

const RENDER = `import { renderGuidanceFile, guideTopics, GUIDANCE_MAX_CHARS, GUIDANCE_SECTION_MAX_CHARS } from './packages/shared/contracts/snippets';
process.stdout.write(JSON.stringify({ text: renderGuidanceFile('full', 'eval'), size: renderGuidanceFile('full', '0.0.0').length, max: GUIDANCE_MAX_CHARS, sectionsOver: guideTopics().filter((t) => t.section.body.length >= GUIDANCE_SECTION_MAX_CHARS).map((t) => t.slug) }));`;

/** The guidance as the tree renders it now, and its size against the budget, from a fresh process (this one imported the sources before any edit). */
export function renderNow(root = treeRoot()): Rendered {
  const r = spawnSync('bun', ['-e', RENDER], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`rendering the guidance failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  return JSON.parse(r.stdout) as Rendered;
}

/** Why a rewrite is over the budget, or null. A file already over at the start may not grow: the budget never moves to fit a rewrite. */
export function overBudget(now: Pick<Rendered, 'size' | 'sectionsOver'>, start: Pick<Rendered, 'size' | 'max' | 'sectionsOver'>): string | null {
  const cap = Math.max(start.max, start.size);
  if (now.size > cap) return `the guidance is ${now.size} characters, ${now.size - cap} over its ${cap} limit: replace text rather than add it`;
  const grew = now.sectionsOver.filter((s) => !start.sectionsOver.includes(s));
  return grew.length ? `section ${grew.join(', ')} is over its per-section budget` : null;
}

/** The size line the rewriter reads: its room, or what it must cut. */
export function budgetLine(r: Pick<Rendered, 'size' | 'max'>): string {
  const cap = Math.max(r.max, r.size);
  const room = cap - r.size;
  return `The guidance is ${r.size} characters, and every session reads every one of them, so it has a budget of ${r.max}. ${room > 0 ? `Your edits may add at most ${room} characters in total.` : 'It is at its limit: your edits together must not make it longer, so pay for each sentence you add by tightening or removing words elsewhere, in the same section where you can.'}`;
}

/** One `./evals check guidance` as its own process, on these freezes, named `batch`; its output streams to the terminal. */
export function checkBatch(freezes: string[], batch: string, reps: number, extra: string[] = []): number {
  const args = ['check', 'guidance', '--batch', batch, '--reps', String(reps), '--no-state', ...freezes.flatMap((f) => ['--freeze', f]), ...extra];
  const r = spawnSync(join(treeRoot(), 'evals'), args, { cwd: treeRoot(), stdio: 'inherit' });
  return r.status ?? 1;
}

export interface RepView {
  freeze: string;
  score: number;
  pass: boolean;
  actions: string[];
  said: string;
  checks: Array<{ id: string; score: number; evidence: string }>;
}

function findFile(dir: string, name: string, depth = 4): string | null {
  if (!existsSync(dir) || depth < 0) return null;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === name) return p;
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** A scored rep as the rewriter reads it: the first actions, the last thing said, and every check with its evidence. */
export function repView(r: SurfaceRun): RepView | null {
  const dir = join(homePaths().runs, r.id);
  const scorePath = join(dir, 'score.json');
  if (!existsSync(scorePath)) return null;
  const score = JSON.parse(readFileSync(scorePath, 'utf8')) as { score: number; pass: boolean; checks?: Array<{ id: string; score: number; evidence?: unknown; reasoning?: string }>; gates?: Array<{ id: string; pass: boolean; evidence?: { summary?: string } }> };
  const stream = findFile(dir, 'stream.jsonl');
  const captures = existsSync(join(dir, 'captures.json')) ? (JSON.parse(readFileSync(join(dir, 'captures.json'), 'utf8')) as Array<{ said?: string[] }>) : [];
  const said = captures.flatMap((c) => c.said ?? []).at(-1) ?? '';
  const ev = (e: unknown): string => (typeof e === 'string' ? e : JSON.stringify(e ?? '')).slice(0, 600);
  return {
    freeze: r.freezeId ?? '',
    score: score.score,
    pass: score.pass,
    actions: stream ? actionsOf({ runSubdir: join(stream, '..') }).slice(0, 8).map((a) => a.slice(0, 300)) : [],
    said: said.slice(0, 1200),
    checks: [...(score.gates ?? []).filter((g) => !g.pass).map((g) => ({ id: `gate ${g.id}`, score: 0, evidence: g.evidence?.summary ?? '' })), ...(score.checks ?? []).map((c) => ({ id: c.id, score: c.score, evidence: ev(c.evidence ?? c.reasoning) }))],
  };
}

export async function batchReps(batch: string): Promise<RepView[]> {
  return (await scoredRuns(batch)).map(repView).filter((x): x is RepView => Boolean(x));
}

export interface FreezeTally {
  freeze: string;
  reps: number;
  passed: number;
  mean: number;
}

export function tally(reps: RepView[]): FreezeTally[] {
  const by = new Map<string, RepView[]>();
  for (const r of reps) by.set(r.freeze, [...(by.get(r.freeze) ?? []), r]);
  return [...by.entries()].map(([freeze, rs]) => ({ freeze, reps: rs.length, passed: rs.filter((r) => r.pass).length, mean: rs.reduce((s, r) => s + r.score, 0) / rs.length }));
}

/** The climb's objective: the mean score over every rep, so a freeze that moves from 1 of 3 to 2 of 3 counts. */
export const objective = (reps: RepView[]): number => (reps.length ? reps.reduce((s, r) => s + r.score, 0) / reps.length : 0);

export const REWRITE_PROMPT = `You maintain the codecast guidance: the sections codecast installs into the global CLAUDE.md of every AI coding agent that uses it. Agents read it at the start of every session, and it decides how they work with codecast and with the person.

People corrected agents for the habits below. Each correction became a test: a request a fresh agent receives, and the check a correct answer passes. Some tests fail on the guidance as it stands. Your job is to change the guidance so an agent reading it does the right thing in those situations, while everything it already does well stays as it is.

How codecast writes prompts (follow it; it is the standard every guidance change is reviewed against):
<standard>
{STANDARD}
</standard>

The guidance as it stands:
<guidance>
{GUIDANCE}
</guidance>

{BUDGET}

The tests, with how the latest replays did:
{CASES}
{HISTORY}
Work in this order:
1. For each failing test, find what in the guidance leads an agent to the wrong action, or what is missing that would lead it to the right one. Read the agent's actions and reply: the cause is in the text it read, not in the agent.
2. Decide the smallest change at that site, stated as the general principle and its reason, so it holds for every situation of that kind and not only for these requests. Never mention a test, a request or an incident. Prefer sharpening or replacing a sentence to adding a new one, and keep the section's voice.
3. Check the change against the other tests and against what the guidance already asks elsewhere, so it does not swing an agent into the opposite mistake.

Answer with one JSON object and nothing else:
{"diagnosis": "<for each failing test, one line: what in the guidance caused it>", "edits": [{"find": "<an exact, unique run of the guidance text above, a sentence or less, plain prose with no code fence>", "replace": "<the text that takes its place>"}]}
Each find must be copied exactly from the guidance above and occur in it once. To add a sentence, find the sentence it follows and replace it with that sentence plus the new one.`;

export interface CaseView {
  freeze: Freeze;
  request: string;
  want: string[];
  avoid: string[];
  reps: RepView[];
}

export function caseBlock(c: CaseView, i: number): string {
  const passed = c.reps.filter((r) => r.pass).length;
  const lines = [`<test n="${i + 1}" passed="${passed} of ${c.reps.length}">`, `Request: ${c.request}`];
  if (c.freeze.judge) lines.push(`A correct reply: ${c.freeze.judge}`);
  if (c.want.length) lines.push(`Right first action matches: ${c.want.join(' | ')}`);
  if (c.avoid.length) lines.push(`Wrong first action matches: ${c.avoid.join(' | ')}`);
  for (const r of c.reps.filter((x) => !x.pass).slice(0, 2)) {
    lines.push('A failing replay:', `  actions: ${r.actions.length ? r.actions.join(' ; ') : '(none)'}`, `  said: ${r.said.replace(/\s+/g, ' ')}`);
    for (const k of r.checks.filter((x) => x.score < 1)) lines.push(`  ${k.id} ${k.score.toFixed(2)}: ${k.evidence.replace(/\s+/g, ' ')}`);
  }
  lines.push('</test>');
  return lines.join('\n');
}

export async function proposeEdits(o: { guidance: Rendered; cases: CaseView[]; history: string[]; dir: string }): Promise<{ diagnosis: string; edits: Edit[]; costUsd: number }> {
  const standard = readFileSync(join(treeRoot(), 'docs', 'prompting.md'), 'utf8');
  const prompt = REWRITE_PROMPT.replace('{STANDARD}', standard)
    .replace('{GUIDANCE}', o.guidance.text)
    .replace('{BUDGET}', budgetLine(o.guidance))
    .replace('{CASES}', o.cases.map(caseBlock).join('\n\n'))
    .replace('{HISTORY}', o.history.length ? `\nEdits tried in earlier rounds and what they did (do not repeat one that did not help):\n${o.history.join('\n')}\n` : '');
  const r = await runCall({ model: PROD_DEFAULT_MODEL, max_tokens: 32000, prompt }, o.dir, { dry: false });
  if (r.isError) throw new Error(`the rewriter call failed: ${r.harnessFailure ?? r.text.slice(0, 200)}`);
  const parsed = parseJsonBlock(r.text) as { diagnosis?: unknown; edits?: Array<{ find?: unknown; replace?: unknown }> } | null;
  if (!parsed) throw new Error(`the rewriter returned no JSON: ${r.text.slice(0, 200)}`);
  const diagnosis = Array.isArray(parsed.diagnosis) ? parsed.diagnosis.join('\n') : String(parsed.diagnosis ?? '');
  return { diagnosis, edits: (parsed.edits ?? []).map((e) => ({ find: String(e.find ?? ''), replace: String(e.replace ?? '') })), costUsd: r.costUsd };
}
