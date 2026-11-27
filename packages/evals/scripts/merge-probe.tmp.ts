// Throwaway probe (not committed): does the pass merge when `merges` is required in its schema?
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPriorityPassPrompt, PRIORITY_PASS_SCHEMA, PRIORITY_PASS_MODEL, PRIORITY_PASS_CAPS } from '../../convex/convex/lib/priorityPass';
import { modelCost, parseJsonBlock, postMessages, replyText } from '../../convex/convex/lib/anthropic';
import { evalsApiKey } from '../src/adapters/apiCall';
import { convexRun, replayScope } from './priorities-measure';

const HOME = process.env.HOME!;
const replay = JSON.parse(readFileSync(`${HOME}/.codecast/ct-102390/base90/replay.json`, 'utf8'));
const w = replay.workspaces.find((x: any) => x.name === 'Codecast');
const state = w.state;
const scope = replayScope({ window: ['2026-11-10', '2026-11-24'] } as any, (n: string, f?: string) => (n === 'user' ? 'jasoncbenn@gmail.com' : n === 'workspace' ? w.workspace : f!));
const end = Date.parse('2026-11-25T00:00:00Z');
const read: any = convexRun('priorityPassInputs:passInputs', { user_id: scope.user_id, workspace: w.workspace, window_start: end - 3 * 86_400_000, now: end });
const input = { ...read.input, priorities: state.priorities, step_tasks: [], corrections: [], sessions: read.input.sessions.map(({ placed: _p, not_for: _n, ...s }: any) => s) };
const { prompt } = buildPriorityPassPrompt(input);
const system = readFileSync(`${HOME}/.codecast/ct-102390/prompts/v3.txt`, 'utf8');
const required = structuredClone(PRIORITY_PASS_SCHEMA) as any;
required.properties.priorities.items.required = [...required.properties.priorities.items.required, 'merges'];
const apiKey = evalsApiKey()!;
const out: any[] = [];
for (const [label, effort] of [['effort-low', 'low'], ['effort-medium', 'medium']] as const) {
  for (let i = 0; i < 2; i++) {
    const res = await postMessages({ model: PRIORITY_PASS_MODEL, max_tokens: 32_000, system, prompt, output_schema: PRIORITY_PASS_SCHEMA as any, effort }, { apiKey });
    const body = await res!.json();
    const json: any = parseJsonBlock(replyText(body));
    const merges = (json?.priorities ?? []).flatMap((p: any) => (p.merges ?? []).map((m: string) => `${m} → ${p.short_id ?? 'new'} "${p.title}"`));
    out.push({ label, i, merges, returned: json?.priorities?.length, cost: modelCost(PRIORITY_PASS_MODEL, body.usage) });
    console.log(label, i, 'returned', json?.priorities?.length, 'merges', merges.length, merges.slice(0, 8));
  }
}
console.log('sessions in step', input.sessions.length, 'priorities shown', input.priorities.length);
writeFileSync(`${HOME}/.codecast/ct-102390/merge-probe/result.json`, JSON.stringify({ out, prompt_chars: prompt.length }, null, 1));
