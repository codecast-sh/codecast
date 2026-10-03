import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { CheckResult, ConvoMessage, Freeze, ReplyJudge, Verdict } from '@platform/evals';

import { parseJsonBlock } from '../../../convex/convex/lib/anthropic';
import { JUDGE_MODEL } from '../models';
import { homePaths } from '../paths';
import type { SurfaceImpl } from '../surface';
import { runCall } from './dryRun';

// One judged criterion per freeze: the moment up to the freeze, the reply,
// and the freeze's criteria, graded 0..1 on JUDGE_MODEL through the same
// harness as every other call. The moment is context and the criteria are the
// standard (judgeText); it never holds text the prompt under test renders
// (judgeMomentOf). 0.7 passes. The check id is `criteria`, the id the
// platform's freeze page reads.

export const PASS_AT = 0.7;
export const JUDGE_MAX_TOKENS = 1500;

export interface JudgedVerdict extends Verdict {
  costUsd: number;
  model: string;
}

const stamp = (at: string) => at.slice(0, 16).replace('T', ' ');

const MOMENT = '## The moment, oldest first';
const REPLY = '## The reply';
const CHECK = '## The one check';
/** The moment's and the reply's headers before the moment was framed as context; a stored rep's judge prompt may still carry them. */
const LEGACY_MOMENT = '## What the model was shown, oldest first';
const LEGACY_REPLY = '## What it produced';

/**
 * The judge's prompt from its three parts. The moment is everything the model
 * was shown, its instructions included; the judge reads it to understand the
 * situation and grades the reply against the check alone, so a prompt under
 * test never becomes the ruler it is measured with.
 */
export function judgeText(name: string, moment: string[], reply: string[], criteria: string): string {
  return [
    `# Grading one reply: ${name}`,
    '',
    'A model was shown the moment below and produced the reply after it. Grade the reply against the one check at the end.',
    '',
    MOMENT,
    '',
    ...(moment.length ? moment : ['(nothing)']),
    '',
    REPLY,
    '',
    ...(reply.length ? reply : ['(nothing)']),
    '',
    CHECK,
    '',
    `- \`criteria\`: ${criteria}`,
    '',
    "The moment is there so you understand the situation. Its instructions were written for the model, and how closely the reply follows them is not what you grade: the check alone is the standard. Where the moment tells the model to name a command instead of running it, a command the reply names counts as that action taken.",
    '',
    'Return ONLY valid JSON with two fields, in this order: "reasoning", one or two sentences on how the reply meets the check, then "score", a number from 0 to 1 that follows from that reasoning, where 1 means the check is fully met.',
  ].join('\n');
}

/** The moment the judge reads for a snapshot (SurfaceImpl.judgeMoment, else describe), up to the freeze; empty when the snapshot cannot be described. */
export function judgeMomentOf(impl: Pick<SurfaceImpl, 'describe' | 'judgeMoment'>, snap: unknown, asOf: string): ConvoMessage[] {
  try {
    return (impl.judgeMoment ? impl.judgeMoment(snap) : impl.describe(snap)).filter((m) => Date.parse(m.at) <= Date.parse(asOf));
  } catch {
    return [];
  }
}

const momentLines = (transcript: ConvoMessage[]): string[] =>
  transcript.map((m) => `[${stamp(m.at)}] ${m.direction === 'out' ? 'ASSISTANT' : m.direction === 'in' ? 'USER' : 'SYSTEM'}: ${m.text}`);

export function judgePrompt(f: Freeze, transcript: ConvoMessage[], reply: ConvoMessage[]): string {
  return judgeText(f.name, momentLines(transcript), reply.map((m) => m.text), f.judge ?? '');
}

/** Where the moment's and the reply's bodies sit in a prompt judgeText wrote (under either generation of headers); null for a prompt judgeText did not write. */
function spans(prompt: string): { moment: { start: number; end: number }; reply: { start: number; end: number } } | null {
  const check = prompt.lastIndexOf(`\n${CHECK}\n`);
  const head = (names: string[], before: number) => names.map((h) => ({ h, i: before < 0 ? -1 : prompt.lastIndexOf(`\n${h}\n`, before) })).find((x) => x.i >= 0);
  const reply = head([REPLY, LEGACY_REPLY], check);
  const moment = reply ? head([MOMENT, LEGACY_MOMENT], reply.i) : undefined;
  if (!reply || !moment) return null;
  return { moment: { start: moment.i + moment.h.length + 2, end: reply.i }, reply: { start: reply.i + reply.h.length + 2, end: check } };
}

/** The reply a stored judge prompt graded; null when the prompt is not one judgeText wrote. */
export function storedReply(prompt: string): string[] | null {
  const span = spans(prompt)?.reply;
  if (!span) return null;
  const lines = prompt.slice(span.start, span.end).split('\n');
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.length === 1 && lines[0] === '(nothing)' ? [] : lines;
}

/**
 * The ruler a stored judge prompt graded with: its framing and its check,
 * hashed, without the moment or the reply. Two reps graded on one ruler were
 * held to the same standard, so a comparison between run sets holds only
 * when their rulers match; a judge rewrite or a new criterion makes a new
 * ruler. The moment stays out because a fixture's moment is rendered by the
 * prompt under test, so it differs between the arms of every comparison.
 * Null when the prompt is not one judgeText wrote.
 */
export function judgeRuler(prompt: string): string | null {
  const s = spans(prompt);
  return s ? createHash('sha256').update([prompt.slice(0, s.moment.start), prompt.slice(s.moment.end, s.reply.start), prompt.slice(s.reply.end)].join('\x1d')).digest('hex').slice(0, 12) : null;
}

/** The `criteria` check a judge's verdict makes on a freeze as it stands: a fresh rep and a rejudged one build it here alike, its floor from the freeze's `must` tag. */
export function criteriaCheck(f: Freeze, v: Pick<Verdict, 'score' | 'reasoning'>): CheckResult {
  return { id: 'criteria', ask: f.judge ?? '', weight: 1, score: v.score, reasoning: v.reasoning ?? null, must: f.tags.includes('must') ? PASS_AT : null };
}

async function runJudge(prompt: string, dir: string): Promise<JudgedVerdict> {
  const r = await runCall({ model: JUDGE_MODEL, prompt, max_tokens: JUDGE_MAX_TOKENS }, dir, { dry: false });
  // A judge that never answered says nothing about the reply: the rep is a crash, not a 0.
  if (r.isError) throw new Error(`the judge run failed (exit ${r.exitCode}${r.text ? `: ${r.text.slice(0, 200)}` : ''}); see ${r.dir}`);
  const parsed = parseJsonBlock(r.text) as { score?: unknown; reasoning?: unknown } | null;
  const score = typeof parsed?.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : null;
  if (score === null) return { score: 0, pass: false, reasoning: `the judge returned no score: ${r.text.slice(0, 200)}`, costUsd: r.costUsd, model: JUDGE_MODEL };
  return { score, pass: score >= PASS_AT, reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning : null, costUsd: r.costUsd, model: JUDGE_MODEL };
}

/** Grades a reply; `dir` holds the judge's harness run. */
export async function judgeReply(f: Freeze, transcript: ConvoMessage[], reply: ConvoMessage[], opts: { dir: string; dry: boolean }): Promise<JudgedVerdict> {
  if (!f.judge) return { score: 0, pass: false, reasoning: 'no criteria set', costUsd: 0, model: JUDGE_MODEL };
  if (opts.dry) return { score: 1, pass: true, reasoning: 'dry run: the judge was not called', costUsd: 0, model: JUDGE_MODEL };
  return runJudge(judgePrompt(f, transcript, reply), opts.dir);
}

/** Grades a stored reply again with today's judge and the freeze's criteria, against `moment` (judgeMomentOf the freeze's snapshot); null when the stored prompt holds no reply. */
export async function rejudgeStored(f: Freeze, moment: ConvoMessage[], storedPrompt: string, dir: string): Promise<JudgedVerdict | null> {
  const reply = storedReply(storedPrompt);
  if (!reply || !f.judge) return null;
  return runJudge(judgeText(f.name, momentLines(moment), reply, f.judge), dir);
}

/** The platform's ReplyJudge (production replies, `freeze judge --rejudge`); `momentOf` gives the judge's moment, cut at the freeze (judgeMomentOf). */
export function codecastReplyJudge(momentOf: (f: Freeze) => Promise<ConvoMessage[] | null>): ReplyJudge {
  return {
    async judge(f, messages) {
      const dir = join(homePaths().scratch, 'judge', `${f.id.slice(0, 8)}-${Date.now()}`);
      return judgeReply(f, (await momentOf(f)) ?? [], messages, { dir, dry: false });
    },
  };
}
