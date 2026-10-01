import { join } from 'node:path';

import type { ConvoMessage, Freeze, ReplyJudge, Verdict } from '@platform/evals';

import { parseJsonBlock } from '../../../convex/convex/lib/anthropic';
import { JUDGE_MODEL } from '../models';
import { homePaths } from '../paths';
import { runCall } from './dryRun';

// One judged criterion per freeze: the transcript up to the moment, the
// reply, and the freeze's criteria, graded 0..1 on JUDGE_MODEL through the
// same harness as every other call. 0.7 passes. The check id is `criteria`,
// the id the platform's freeze page reads.

export const PASS_AT = 0.7;
export const JUDGE_MAX_TOKENS = 1500;

export interface JudgedVerdict extends Verdict {
  costUsd: number;
  model: string;
}

const stamp = (at: string) => at.slice(0, 16).replace('T', ' ');

export function judgePrompt(f: Freeze, transcript: ConvoMessage[], reply: ConvoMessage[]): string {
  return [
    `# A frozen moment: ${f.name}`,
    '',
    '## What the model was shown, oldest first',
    '',
    ...(transcript.length ? transcript.map((m) => `[${stamp(m.at)}] ${m.direction === 'out' ? 'ASSISTANT' : m.direction === 'in' ? 'USER' : 'SYSTEM'}: ${m.text}`) : ['(nothing)']),
    '',
    '## What it produced',
    '',
    ...(reply.length ? reply.map((m) => m.text) : ['(nothing)']),
    '',
    '## The one check',
    '',
    `- \`criteria\`: ${f.judge}`,
    '',
    'Return ONLY valid JSON: {"score": 0.0, "reasoning": "one or two sentences"}, where score is 0..1 and 1 means the criteria are fully met.',
  ].join('\n');
}

/** Grades a reply; `dir` holds the judge's harness run. */
export async function judgeReply(f: Freeze, transcript: ConvoMessage[], reply: ConvoMessage[], opts: { dir: string; dry: boolean }): Promise<JudgedVerdict> {
  if (!f.judge) return { score: 0, pass: false, reasoning: 'no criteria set', costUsd: 0, model: JUDGE_MODEL };
  if (opts.dry) return { score: 1, pass: true, reasoning: 'dry run: the judge was not called', costUsd: 0, model: JUDGE_MODEL };
  const r = await runCall({ model: JUDGE_MODEL, prompt: judgePrompt(f, transcript, reply), max_tokens: JUDGE_MAX_TOKENS }, opts.dir, { dry: false });
  // A judge that never answered says nothing about the reply: the rep is a crash, not a 0.
  if (r.isError) throw new Error(`the judge run failed (exit ${r.exitCode}${r.text ? `: ${r.text.slice(0, 200)}` : ''}); see ${r.dir}`);
  const parsed = parseJsonBlock(r.text) as { score?: unknown; reasoning?: unknown } | null;
  const score = typeof parsed?.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : null;
  if (score === null) return { score: 0, pass: false, reasoning: `the judge returned no score: ${r.text.slice(0, 200)}`, costUsd: r.costUsd, model: JUDGE_MODEL };
  return { score, pass: score >= PASS_AT, reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning : null, costUsd: r.costUsd, model: JUDGE_MODEL };
}

/** The platform's ReplyJudge (production replies, `freeze judge --rejudge`), with the moment from the freeze's snapshot. */
export function codecastReplyJudge(describe: (f: Freeze) => Promise<ConvoMessage[] | null>): ReplyJudge {
  return {
    async judge(f, messages) {
      const transcript = ((await describe(f)) ?? []).filter((m) => Date.parse(m.at) <= Date.parse(f.asOf));
      const dir = join(homePaths().scratch, 'judge', `${f.id.slice(0, 8)}-${Date.now()}`);
      return judgeReply(f, transcript, messages, { dir, dry: false });
    },
  };
}
