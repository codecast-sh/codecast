/**
 * The on-disk run layout, and a `RunSource` over a folder of them.
 *
 * A harness that writes this layout gets every read view for free: the
 * terminal, the pages, the diffs. One folder per run, named
 * `<scenario>-seed<n>-<stamp>`; the name is the run id and any prefix of it
 * is a handle.
 *
 *   result.json    counters: scenario, seed, endedBecause, steps, costUsd, ...
 *   events.jsonl   one RunEvent per line, virtual and real time on each
 *   sends.json     RunSend[]: everything that would have reached somebody
 *   score.json     the Score, with scenario, title, hunts, seed on it
 *   captures.json  every call the boundary caught
 *   runs.json      the assistant's own runs inside the simulation (optional)
 *   steps.json     their tool calls (optional)
 *   roster.json    who was in the run (optional; derived when absent)
 *   run.json       replay bookkeeping: freezeId, notes, model (optional)
 *   report.html    the page (optional; `html` writes it)
 *
 * Listing reads only the small files, so a root with thousands of runs
 * answers in well under a second; events load on `get`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentRunRecord, RunCounters, RunDetail, RunEvent, RunSend, RunSource, RunStatus, RunSummary, Score } from '../model';
import { buildStory, deriveParticipants, type Roster } from '../story';

const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const readJsonl = <T>(path: string): T[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
};

const FOLDER = /^(.+)-seed(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

/** `<scenario>-seed<n>-<stamp>` → its parts, or null for a folder that is not a run. */
export function parseRunId(name: string): { scenario: string; seed: number; stamp: string; createdAt: string } | null {
  const m = FOLDER.exec(name);
  if (!m) return null;
  const stamp = m[3]!;
  const createdAt = `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20, 23)}Z`;
  return { scenario: m[1]!, seed: Number(m[2]), stamp, createdAt };
}

interface StoredScore extends Score {
  scenario?: string;
  title?: string;
  hunts?: string | null;
  seed?: number;
  evidenceDir?: string | null;
}

interface StoredResult extends RunCounters {
  scenario: string;
  seed: number;
  title?: string;
  startedAt?: string;
}

interface StoredMeta {
  freezeId?: string | null;
  notes?: string | null;
  model?: string | null;
  title?: string | null;
  /** A wiring run on canned output: its score says nothing about the prompt. */
  dry?: boolean;
}

const statusOf = (score: StoredScore | null, result: StoredResult | null, finished: boolean, dry: boolean): RunStatus => {
  if (score) return dry ? 'dry' : score.pass ? 'pass' : 'fail';
  if (!finished) return 'running';
  if (!result) return 'crash';
  return result.endedBecause === 'failed' || result.endedBecause === 'real-budget' ? 'crash' : 'unscored';
};

/** The first event's virtual instant is where the run's clock began. */
const startedAtOf = (dir: string, result: StoredResult | null): string => {
  if (result?.startedAt) return result.startedAt;
  const path = join(dir, 'events.jsonl');
  if (!existsSync(path)) return '';
  const fd = readFileSync(path, 'utf8');
  const first = fd.slice(0, fd.indexOf('\n') > 0 ? fd.indexOf('\n') : undefined);
  try {
    return String((JSON.parse(first) as RunEvent).virtualAt ?? '');
  } catch {
    return '';
  }
};

export function summarizeRunFolder(root: string, name: string): RunSummary | null {
  const parsed = parseRunId(name);
  if (!parsed) return null;
  const dir = join(root, name);
  if (!statSync(dir).isDirectory()) return null;
  const result = readJson<StoredResult>(join(dir, 'result.json'));
  const score = readJson<StoredScore>(join(dir, 'score.json'));
  const meta = readJson<StoredMeta>(join(dir, 'run.json'));
  const sends = readJson<RunSend[]>(join(dir, 'sends.json'));
  // A run is running while nothing terminal has been written and the folder
  // is young; a folder with no result and no score that stopped changing
  // more than an hour ago crashed before it could write either.
  const ageMs = Date.now() - statSync(dir).mtimeMs;
  const finished = Boolean(result || score) || ageMs > 3_600_000;
  return {
    id: name,
    scenario: result?.scenario ?? score?.scenario ?? parsed.scenario,
    title: score?.title ?? meta?.title ?? result?.title ?? parsed.scenario,
    hunts: score?.hunts ?? null,
    seed: result?.seed ?? score?.seed ?? parsed.seed,
    startedAt: startedAtOf(dir, result),
    createdAt: parsed.createdAt,
    status: statusOf(score, result, finished, meta?.dry === true),
    score: score ? score.score : null,
    gatesFailed: score ? score.gates.filter((g) => !g.pass).map((g) => g.id) : [],
    missedFloors: score?.missedFloors?.map((f) => f.id) ?? [],
    sends: sends?.length ?? result?.captures ?? 0,
    costUsd: (result?.costUsd ?? 0) + (score?.judgeCostUsd ?? 0),
    realMs: result?.realElapsedMs ?? 0,
    virtualMs: result?.virtualElapsedMs ?? 0,
    freezeId: meta?.freezeId ?? null,
    notes: meta?.notes ?? null,
    model: meta?.model ?? null,
  };
}

const lastLines = (text: string, n: number): string => text.split('\n').filter(Boolean).slice(-n).join('\n');

export function loadRunFolder(root: string, name: string): RunDetail | null {
  const summary = summarizeRunFolder(root, name);
  if (!summary) return null;
  const dir = join(root, name);
  const events = readJsonl<RunEvent>(join(dir, 'events.jsonl'));
  const sends = readJson<RunSend[]>(join(dir, 'sends.json')) ?? sendsFromEvents(events);
  const score = readJson<StoredScore>(join(dir, 'score.json'));
  const result = readJson<StoredResult>(join(dir, 'result.json'));
  const roster = readJson<Roster>(join(dir, 'roster.json'));
  const captures = readJson<Array<{ label: string }>>(join(dir, 'captures.json')) ?? [];
  const participants = deriveParticipants(events, sends, roster);
  const byLabel = new Map<string, number>();
  for (const c of captures) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + 1);
  const log = existsSync(join(dir, 'run.log')) ? readFileSync(join(dir, 'run.log'), 'utf8') : null;
  return {
    ...summary,
    participants,
    messages: buildStory(events, sends, participants),
    events,
    sendsList: sends,
    verdict: score ? { ...score } : null,
    counters: result ? { ...result } : null,
    captures: [...byLabel.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    blocked: events.filter((e) => e.kind === 'boundary_blocked').map((e) => ({ at: e.virtualAt, host: String(e.payload.host ?? ''), method: String(e.payload.method ?? ''), url: String(e.payload.url ?? '') })),
    agentRuns: agentRunsOf(dir),
    evidenceDir: dir,
    error: summary.status === 'crash' && log ? lastLines(log, 12) : null,
  };
}

/** A run whose sends.json was never written still has every capture in its events. */
function sendsFromEvents(events: RunEvent[]): RunSend[] {
  return events
    .filter((e) => e.kind === 'send_captured')
    .map((e) => {
      const detail = (e.payload.detail ?? {}) as Record<string, unknown>;
      const text = typeof detail.text === 'string' ? detail.text : '';
      return {
        seq: e.seq,
        at: e.virtualAt,
        label: typeof e.payload.label === 'string' ? e.payload.label : null,
        rail: typeof detail.rail === 'string' ? detail.rail : null,
        to: typeof detail.to === 'string' ? detail.to : null,
        text,
        chars: text.length,
        channelId: typeof detail.channelId === 'string' ? detail.channelId : null,
        isGroup: Boolean(detail.isGroup),
        audience: 'unknown' as const,
      };
    })
    .filter((s) => s.to || s.text);
}

interface StoredAgentRun {
  id: string;
  at: string;
  triggerType?: string | null;
  status: string;
  totalCost?: number | null;
  model?: string | null;
  totalTokensIn?: number | null;
  totalTokensOut?: number | null;
  durationMs?: number | null;
  result?: { textResponse?: string | null } | null;
}
interface StoredStep {
  runId: string;
  stepNumber: number;
  toolName: string | null;
  toolInput?: unknown;
  toolOutput?: unknown;
  gate?: unknown;
  thinking?: string | null;
}

function agentRunsOf(dir: string): AgentRunRecord[] {
  const runs = readJson<StoredAgentRun[]>(join(dir, 'runs.json')) ?? [];
  const steps = readJson<StoredStep[]>(join(dir, 'steps.json')) ?? [];
  return runs.map((r) => ({
    id: r.id,
    at: r.at,
    triggerType: r.triggerType ?? null,
    status: r.status,
    costUsd: r.totalCost ?? null,
    model: r.model ?? null,
    tokensIn: r.totalTokensIn ?? null,
    tokensOut: r.totalTokensOut ?? null,
    durationMs: r.durationMs ?? null,
    reply: r.result?.textResponse ?? null,
    steps: steps
      .filter((s) => s.runId === r.id)
      .sort((a, b) => a.stepNumber - b.stepNumber)
      .map((s) => ({ n: s.stepNumber, tool: s.toolName, input: s.toolInput, output: s.toolOutput, gate: s.gate, thinking: s.thinking ?? null })),
  }));
}

export interface FsRunSourceOptions {
  root: string;
}

/** Every run under `root`, newest first; a prefix of a folder name finds it. */
export function fsRunSource(opts: FsRunSourceOptions): RunSource {
  const names = (): string[] => (existsSync(opts.root) ? readdirSync(opts.root).filter((n) => parseRunId(n)) : []);
  return {
    async list(filter = {}) {
      const all = names()
        .map((n) => ({ n, parsed: parseRunId(n)! }))
        .filter(({ parsed }) => !filter.scenario || parsed.scenario === filter.scenario || parsed.scenario.startsWith(`${filter.scenario}`))
        .filter(({ parsed }) => !filter.since || Date.parse(parsed.createdAt) >= filter.since)
        .sort((a, b) => (a.parsed.stamp < b.parsed.stamp ? 1 : -1));
      const out: RunSummary[] = [];
      for (const { n } of all) {
        const s = summarizeRunFolder(opts.root, n);
        if (!s) continue;
        if (filter.freezeId && s.freezeId !== filter.freezeId && !(s.freezeId ?? '').startsWith(filter.freezeId)) continue;
        if (filter.status && s.status !== filter.status) continue;
        out.push(s);
        if (filter.limit && out.length >= filter.limit) break;
      }
      return out;
    },
    async get(ref) {
      const exact = names().find((n) => n === ref);
      if (exact) return loadRunFolder(opts.root, exact);
      const matches = names().filter((n) => n.startsWith(ref));
      if (matches.length === 1) return loadRunFolder(opts.root, matches[0]!);
      if (matches.length > 1) {
        // Newest wins when the prefix is a scenario name; an ambiguous id prefix is an error worth surfacing.
        const sorted = matches.sort((a, b) => (parseRunId(a)!.stamp < parseRunId(b)!.stamp ? 1 : -1));
        if (parseRunId(ref) === null && !/seed\d/.test(ref)) return loadRunFolder(opts.root, sorted[0]!);
        throw new Error(`${matches.length} runs match ${ref}: ${sorted.slice(0, 5).join(', ')}${sorted.length > 5 ? ', …' : ''}`);
      }
      return null;
    },
  };
}
