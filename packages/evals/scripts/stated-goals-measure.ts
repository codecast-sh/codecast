#!/usr/bin/env bun
// Measures the stated goals read (packages/convex/convex/lib/statedGoals.ts)
// against a hand-labelled set of a workspace's real lines: precision and
// recall per source, run-to-run stability, and what the old keyword filter
// would have kept. The set lives in EVALS_HOME/labels/stated-goals/<ws>.json
// (real content, never in git): { items: [{ kind, at, by, where, text, direction }] }.
//
//   bun packages/evals/scripts/stated-goals-measure.ts [--ws union] [--runs 5] [--model <id>] [--out <file>]
//
// Calls go out on the evals' API key (CODECAST_EVALS_ANTHROPIC_KEY or the keychain), as prod posts them.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { postMessages, replyText } from '../../convex/convex/lib/anthropic';
import { pickStatedGoals, type GoalCandidate } from '../../convex/convex/lib/statedGoals';
import { evalsApiKey } from '../src/adapters/apiCall';
import { homePaths } from '../src/paths';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const ws = arg('ws', 'union');
const runs = Number(arg('runs', '5'));
const key = evalsApiKey();
if (!key) throw new Error('no evals API key: set CODECAST_EVALS_ANTHROPIC_KEY or the keychain item (./evals doctor)');

type Item = GoalCandidate & { direction: boolean };
const items: Item[] = JSON.parse(readFileSync(join(homePaths().labels, 'stated-goals', `${ws}.json`), 'utf8')).items;
const candidates: GoalCandidate[] = items.map(({ direction: _d, ...c }) => c);
const id = (c: { where: string; text?: string; line?: string }, i: number) => `${i}`;

/** The keyword filter the read replaced, for comparison. */
const GOAL_RE = /\b(goals?|initiatives?|priorities|north star|objectives?|milestones?|mission|metrics?)\b/i;

/** --model ablates the model the read runs on. */
const model = arg('model', '');
async function ask(req: any): Promise<string | null> {
  const res = await postMessages(model ? { ...req, model } : req, { apiKey: key! });
  if (!res?.ok) { console.error('call failed', res?.status, await res?.text()); return null; }
  return replyText(await res.json()) || null;
}

/** Which candidates a run picked, by index: a pick names its candidate by where and its own words. */
function pickedIndexes(lines: Array<{ where: string; line: string }>): Set<number> {
  const out = new Set<number>();
  for (const l of lines) {
    const i = candidates.findIndex((c, k) => !out.has(k) && c.where === l.where && c.text.replace(/\s+/g, ' ').includes(l.line.replace(/\s+/g, ' ').slice(0, 200)));
    if (i >= 0) out.add(i);
  }
  return out;
}

function score(picked: Set<number>) {
  const kinds = [...new Set(items.map((x) => x.kind)), 'all'] as const;
  return Object.fromEntries(kinds.map((k) => {
    const idx = items.map((x, i) => [x, i] as const).filter(([x]) => k === 'all' || x.kind === k);
    const tp = idx.filter(([x, i]) => x.direction && picked.has(i)).length;
    const fp = idx.filter(([x, i]) => !x.direction && picked.has(i)).length;
    const fn = idx.filter(([x, i]) => x.direction && !picked.has(i)).length;
    return [k, { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null }];
  }));
}

const picks: Set<number>[] = [];
for (let r = 0; r < runs; r++) {
  const goals = await pickStatedGoals(candidates, false, 'Union', ask);
  picks.push(pickedIndexes(goals.lines));
  console.error(`run ${r + 1}: ${goals.lines.length} lines`);
}
const regex = new Set(items.map((x, i) => (GOAL_RE.test(x.text) ? i : -1)).filter((i) => i >= 0));
const all = new Set(picks.flatMap((p) => [...p]));
const always = [...all].filter((i) => picks.every((p) => p.has(i)));
const fmt = (n: number | null) => (n == null ? '  -  ' : n.toFixed(2));
const report: string[] = [];
const table = (name: string, s: ReturnType<typeof score>) => {
  for (const [k, v] of Object.entries(s)) report.push(`${name.padEnd(8)} ${k.padEnd(9)} P ${fmt(v.precision)}  R ${fmt(v.recall)}  (tp ${v.tp}, fp ${v.fp}, fn ${v.fn})`);
};
picks.forEach((p, r) => table(`run ${r + 1}`, score(p)));
table('regex', score(regex));
report.push(`stability: ${always.length} of ${all.size} picked lines were picked in every run`);
const flaky = [...all].filter((i) => !always.includes(i));
for (const i of flaky) report.push(`  flaky (${picks.filter((p) => p.has(i)).length}/${runs}) ${items[i]!.direction ? 'DIR ' : 'not '} ${items[i]!.kind} ${items[i]!.where}: ${items[i]!.text.slice(0, 110).replace(/\n/g, ' ')}`);
const missedEvery = items.map((x, i) => [x, i] as const).filter(([x, i]) => x.direction && picks.every((p) => !p.has(i)));
for (const [x] of missedEvery) report.push(`  missed every run: ${x.kind} ${x.where}: ${x.text.slice(0, 110).replace(/\n/g, ' ')}`);
const wrongEvery = items.map((x, i) => [x, i] as const).filter(([x, i]) => !x.direction && picks.every((p) => p.has(i)));
for (const [x] of wrongEvery) report.push(`  wrong every run: ${x.kind} ${x.where}: ${x.text.slice(0, 110).replace(/\n/g, ' ')}`);
console.log(report.join('\n'));
const out = arg('out', '');
if (out) writeFileSync(out, report.join('\n') + '\n');
void id;
