import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Freeze, RunEvent, RunSend, Score } from '@platform/evals';

import type { AgentResult, CallResult, ReplayResult } from './surface';

// One replay rep as a folder in the platform's run layout (the files and
// field names writeFixtureRun in @platform/evals/fixture writes), so every
// `runs` and `freeze` view reads it with no codecast code: result.json,
// events.jsonl, sends.json, captures.json, score.json, run.json, run.log.

const stampOf = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** `<surface>-<freeze8>-seed<rep>-<stamp>`: the name fs/runs.ts parses. */
export function runFolderName(surfaceId: string, freezeId: string, rep: number, at: number): string {
  return `${surfaceId}-${freezeId.slice(0, 8)}-seed${rep}-${stampOf(at)}`;
}

export interface RunJson {
  freezeId: string;
  notes: string | null;
  model: string;
  route: 'call' | 'agent';
  sourceHash: string;
  promptSha: string | null;
  judgeModel: string | null;
  budgetUsd: number | null;
  gitHead: string;
  dirty: boolean;
  /** A --dry rep: canned output that proves the wiring and grades nothing (its status is `dry`). */
  dry: boolean;
  /** The temperature each prompt-under-test call sent, as prod's builder set it. */
  temperatureProd: Array<number | 'api-default'>;
  temperatureReplay: 'cli-default';
  /** Agent reads that went to the live workspace: more than 0 and the rep is not reproducible. */
  liveReads: number;
  batch: string;
  /** The standing run this rep belongs to (check --cadence, e.g. the nightly): its batches are weighed against their own pooled history, which no other run joins. Null for any other run. */
  cadence?: string | null;
  title: string;
}

export interface RunRecord {
  dir: string;
  freeze: Freeze;
  scenario: string;
  rep: number;
  startedAt: number;
  endedBecause: 'done' | 'failed' | 'budget';
  result?: ReplayResult;
  error?: string;
  score?: Score;
  run: RunJson;
}

const readText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** took.txt says "<n>s". */
const tookMs = (a: AgentResult): number => {
  const m = /(\d+)s/.exec(readText(join(a.runSubdir, 'took.txt')));
  return m ? Number(m[1]) * 1000 : a.realMs;
};

export function writeRunFolder(rec: RunRecord): string {
  mkdirSync(rec.dir, { recursive: true });
  // A replay has no simulated clock: it runs now, on the moment its freeze
  // names (freeze.asOf, which the freeze keeps). Its virtual time is wall
  // time, so `startedAt` is when the rep began and a run lists on the day it
  // ran, never on the frozen moment's date.
  const startedAt = new Date(rec.startedAt).toISOString();
  const events: RunEvent[] = [];
  const sends: RunSend[] = [];
  const emit = (kind: string, payload: Record<string, unknown>) => {
    const at = new Date().toISOString();
    events.push({ seq: events.length + 1, virtualAt: at, realAt: at, kind, payload });
  };
  const send = (text: string, label: string) => {
    emit('send_captured', { label, detail: { to: 'owner', text, rail: 'session' } });
    const { seq, virtualAt: at } = events.at(-1)!;
    sends.push({ seq, at, label, rail: 'session', to: 'owner', text, chars: text.length, isGroup: false, audience: 'owner' });
  };
  const calls: CallResult[] = rec.result?.calls ?? [];
  const agents: AgentResult[] = rec.result?.agents ?? [];

  emit('run_started', { scenario: rec.scenario, seed: rec.rep, freezeId: rec.freeze.id, model: rec.run.model, route: rec.run.route });
  calls.forEach((c, i) => emit('model_call', { n: i + 1, model: c.request.model, max_tokens: c.request.max_tokens, outputTokens: c.outputTokens, stopReason: c.stopReason, costUsd: c.costUsd, isError: c.isError, dir: c.dir }));
  for (const a of agents) for (const line of a.calls) emit('cast_call', { argv: line });
  if (rec.result) {
    if (agents.length) for (const a of agents) for (const s of a.said) send(s, 'agent');
    else if (rec.result.reply) send(rec.result.reply, 'reply');
  }
  if (rec.error) emit('job_failed', { error: rec.error });
  emit('run_finished', { endedBecause: rec.endedBecause });

  const costUsd = calls.reduce((s, c) => s + c.costUsd, 0) + agents.reduce((s, a) => s + a.costUsd, 0);
  const realElapsedMs = Math.max(Date.now() - rec.startedAt, calls.reduce((s, c) => s + c.realMs, 0) + agents.reduce((s, a) => s + tookMs(a), 0));
  const result = { scenario: rec.scenario, seed: rec.rep, title: rec.freeze.name, startedAt, endedBecause: rec.endedBecause, stopReason: rec.error ?? null, steps: calls.length + agents.length, virtualElapsedMs: 0, realElapsedMs, costUsd, captures: calls.length + agents.length };

  writeFileSync(join(rec.dir, 'result.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(rec.dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  writeFileSync(join(rec.dir, 'sends.json'), JSON.stringify(sends, null, 2));
  writeFileSync(
    join(rec.dir, 'captures.json'),
    JSON.stringify(
      [
        ...calls.map((c, i) => ({ label: `call${i + 1}`, request: c.request, reply: c.text, stopReason: c.stopReason, modelUsage: c.modelUsage })),
        ...agents.map((a, i) => ({ label: `agent${i + 1}`, model: a.model, said: a.said, modelUsage: a.modelUsage })),
      ],
      null,
      2,
    ),
  );
  if (rec.score) writeFileSync(join(rec.dir, 'score.json'), JSON.stringify({ ...rec.score, scenario: rec.scenario, title: rec.freeze.name, seed: rec.rep }, null, 2));
  writeFileSync(join(rec.dir, 'run.json'), JSON.stringify(rec.run, null, 2));
  const log = [rec.error ?? '', ...agents.map((a) => readText(join(a.runSubdir, 'err.txt')))].filter(Boolean).join('\n');
  if (log) writeFileSync(join(rec.dir, 'run.log'), `${log}\n`);
  return rec.dir;
}
