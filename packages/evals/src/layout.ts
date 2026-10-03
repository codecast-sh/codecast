import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Freeze, RunEvent, RunSend, Score } from '@platform/evals';

import type { AgentResult, CallResult, ReplayResult } from './surface';

// One replay rep as a folder in the platform's run layout (the files and
// field names writeFixtureRun in @platform/evals/fixture writes), so every
// `runs` and `freeze` view reads it with no codecast code: result.json,
// events.jsonl, sends.json, captures.json, score.json, run.json, run.log.

/** An instant as a file name part: ISO with `:` and `.` as `-`. */
export const stampOf = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** `<surface>-<freeze8>-seed<rep>-<stamp>`: the name fs/runs.ts parses. */
export function runFolderName(surfaceId: string, freezeId: string, rep: number, at: number): string {
  return `${surfaceId}-${freezeId.slice(0, 8)}-seed${rep}-${stampOf(at)}`;
}

export interface RunJson {
  freezeId: string;
  notes: string | null;
  model: string;
  route: 'call' | 'agent';
  /** The surface's declared sources at HEAD (state.ts sourceHashes): what staleness reads, and not what a dirty checkout ran. */
  sourceHash: string;
  /** The declared sources plus the fixtures and freezes, hashed as the disk held them (provenance.ts diskSources): what the rep ran. Null when git could not say; absent on runs before it was recorded. */
  sourceHashDisk?: string | null;
  /** sha256 of the patch that rebuilds that disk on gitHead, kept at EVALS_HOME/trees/<sha>.patch; null when the disk matched HEAD. */
  treePatch?: string | null;
  /** The freeze JSON and its snapshot content (provenance.ts freezeSha): a changed moment reads as its own cause. */
  freezeSha?: string | null;
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

/** A kept score version beside score.json: `score.<stamp of its scoredAt>.json` (rescore and rejudge write one each). */
export const scoreVersionName = (scoredAt: string | null | undefined): string => `score.${stampOf(scoredAt ? Date.parse(scoredAt) : Date.now())}.json`;

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

// A rep folder's units and the harness files inside them, read the same way
// by everything that reads a rep back (grade, the api child, this writer).

/** A rep folder's numbered units (`call1`, `call2`, … or `agent1`, …), in number order; none when the folder is absent. */
export function unitDirs(dir: string, kind: 'call' | 'agent'): string[] {
  const re = new RegExp(`^${kind}(\\d+)$`);
  return (existsSync(dir) ? readdirSync(dir) : []).filter((n) => re.test(n)).sort((a, b) => Number(a.slice(kind.length)) - Number(b.slice(kind.length)));
}

/** An agent unit's follow-up turn files (`then2.md`, `then3.md`, …), in turn order. */
export function thenFiles(unitDir: string): string[] {
  return (existsSync(unitDir) ? readdirSync(unitDir) : []).filter((f) => /^then\d+\.md$/.test(f)).sort((a, b) => Number(a.slice(4, -3)) - Number(b.slice(4, -3)));
}

/** The harness's exit code in its run folder (exit.txt); 1 when it left none or garbage, so a harness that died before writing it reads as failed. */
export function harnessExit(runDir: string): number {
  const text = readText(join(runDir, 'exit.txt')).trim();
  const n = Number(text);
  return text && Number.isInteger(n) ? n : 1;
}

/** The harness's wall time in its run folder: took.txt says "<n>s". Null when it left none. */
export function harnessTookMs(runDir: string): number | null {
  const m = /(\d+(?:\.\d+)?)s/.exec(readText(join(runDir, 'took.txt')));
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

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
  const realElapsedMs = Math.max(Date.now() - rec.startedAt, calls.reduce((s, c) => s + c.realMs, 0) + agents.reduce((s, a) => s + (harnessTookMs(a.runSubdir) ?? a.realMs), 0));
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
