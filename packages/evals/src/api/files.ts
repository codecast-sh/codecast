import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  GUARD_STATUSES,
  type AgentDetail,
  type AgentItem,
  type CallDetail,
  type GuardEntry,
  type GuardStatus,
  type RunFileEntry,
  type RunFileResponse,
  type RunJson,
  type RunResultJson,
  type RunRow,
  type RunSendView,
  type ScoreJson,
  type ScoreVersion,
  type TokenUsage,
} from '@codecast/shared/contracts/evalsApi';

import { readAgentRun, readCallRun } from '../adapters/dryRun';
import { harnessExit, harnessTookMs, thenFiles, unitDirs } from '../layout';
import { homePaths } from '../paths';
import type { SurfaceRequest } from '../surface';
import { callsByTurn } from '../surfaces/roleWake/actions';

// One run folder under EVALS_HOME/runs, read for the run page: the request
// and reply of every call, every agent turn, the judge, the guard's log, the
// score and each version of it, and the folder's own tree. Every path is
// built from a run id the index holds, never from the client; a file the
// client names is resolved with realpath and must stay inside its folder.

export const runDir = (id: string): string => join(homePaths().runs, id);

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export const readJsonFile = <T>(path: string): T | null => {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The usage block an out.json carries, as the run page counts it. */
export function tokensOf(outs: Array<{ usage?: Record<string, unknown> } | null>): TokenUsage {
  const sum = (k: string): number | null => {
    const vals = outs.map((o) => numOrNull(o?.usage?.[k])).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return { input: sum('input_tokens'), output: sum('output_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens') };
}

/** A unit folder's number: `call3` is 3. */
const unitNo = (name: string): number => Number(/\d+$/.exec(name)![0]);

/** Every `callN` folder: the request as sent, the rendered prompt, and the reply (captures.json for a dry call, the harness's out.json for a real one). */
export function callsOf(dir: string): CallDetail[] {
  const captures = readJsonFile<Array<{ label?: string; reply?: string }>>(join(dir, 'captures.json')) ?? [];
  return unitDirs(dir, 'call').map((name) => {
    const unit = join(dir, name);
    const req = readJsonFile<SurfaceRequest>(join(unit, 'request.json'));
    const run = join(unit, 'run');
    const ran = existsSync(join(run, 'out.json'));
    const read = req && ran ? readCallRun(req, run, harnessExit(run), harnessTookMs(run) ?? 0) : null;
    const captured = captures.find((c) => c.label === name)?.reply;
    return {
      n: unitNo(name),
      dir: name,
      request: { model: req?.model ?? '', max_tokens: req?.max_tokens ?? 0, temperature: numOrNull(req?.temperature) },
      system: readText(join(unit, 'system.md')),
      prompt: readText(join(unit, 'prompt.md')) ?? req?.prompt ?? '',
      reply: captured ?? read?.text ?? '',
      stopReason: read?.stopReason ?? null,
      tokens: tokensOf([readJsonFile(join(run, 'out.json'))]),
      costUsd: read?.costUsd ?? 0,
      realMs: ran ? harnessTookMs(run) : null,
      isError: read?.isError ?? false,
      harnessFailure: read?.harnessFailure ?? null,
    };
  });
}

type StreamBlock = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: { text?: unknown }) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '');

/** One turn's stream.jsonl as the items the loop produced: text, thinking, and each tool call with its result. Subagent messages are left out. */
export function agentItemsOf(stream: string): AgentItem[] {
  const items: AgentItem[] = [];
  const tools = new Map<string, Extract<AgentItem, { kind: 'tool' }>>();
  for (const line of stream.split('\n')) {
    if (!line.trim()) continue;
    let e: { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.parent_tool_use_id || (e.type !== 'assistant' && e.type !== 'user')) continue;
    const content = Array.isArray(e.message?.content) ? (e.message!.content as StreamBlock[]) : [];
    for (const c of content) {
      if (e.type === 'assistant' && c.type === 'text' && c.text) items.push({ kind: 'text', text: c.text });
      else if (e.type === 'assistant' && c.type === 'thinking' && c.thinking) items.push({ kind: 'thinking', text: c.thinking });
      else if (e.type === 'assistant' && c.type === 'tool_use') {
        const item = { kind: 'tool' as const, name: String(c.name ?? ''), input: c.input ?? null, output: null as string | null, isError: false };
        tools.set(String(c.id), item);
        items.push(item);
      } else if (e.type === 'user' && c.type === 'tool_result') {
        const item = tools.get(String(c.tool_use_id));
        if (item) {
          item.output = resultText(c.content);
          item.isError = c.is_error === true;
        }
      }
    }
  }
  return items;
}

interface StoredArgs {
  model?: string;
  call?: boolean;
  maxOutputTokens?: number | null;
  tools?: string[] | null;
  maxTurns?: number | null;
  serve?: string | null;
  guard?: string | null;
}

/** Every `agentN` folder: the opening prompt and each later turn, the turns as the stream recorded them, what the agent said, and the harness's args. */
export function agentsOf(dir: string, runModel: string | null): AgentDetail[] {
  const brief = readText(join(dir, 'brief.md'));
  return unitDirs(dir, 'agent').map((name) => {
    const unit = join(dir, name);
    const sub = join(unit, 'agent');
    const then = thenFiles(unit);
    const args = readJsonFile<StoredArgs>(join(sub, 'args.json')) ?? {};
    const model = args.model ?? runModel ?? '';
    const turnCount = 1 + then.length;
    const ran = existsSync(sub);
    const read = ran ? readAgentRun(sub, model, turnCount, harnessExit(sub), harnessTookMs(sub) ?? 0) : null;
    const names = Array.from({ length: turnCount }, (_, i) => (i === 0 ? '' : String(i + 1)));
    return {
      n: unitNo(name),
      dir: name,
      model,
      prompt: readText(join(unit, 'prompt.md')) ?? '',
      then: then.map((f) => readText(join(unit, f)) ?? ''),
      turns: ran ? names.map((k) => agentItemsOf(readText(join(sub, `stream${k}.jsonl`)) ?? '')).filter((t, i) => i === 0 || t.length) : [],
      said: read?.said ?? [],
      brief: readText(join(sub, 'brief.md')) ?? brief,
      args: { model, call: args.call === true, maxOutputTokens: args.maxOutputTokens ?? null, tools: args.tools ?? null, maxTurns: args.maxTurns ?? null, serve: args.serve ?? null, guard: args.guard ?? null },
      tokens: tokensOf(names.map((k) => readJsonFile(join(sub, `out${k}.json`)))),
      costUsd: read?.costUsd ?? 0,
    };
  });
}

/** A marked calls.log line: `<STATUS> <argv>` (the guard's `mark`). */
const GUARD_MARK = new RegExp(`^(${GUARD_STATUSES.join('|')})(?: (.*))?$`);

/**
 * calls.log as entries: the guard logs each argv, then one marked line for
 * its outcome, and the harness writes `# turn N` before turn N's calls. An
 * argv with no mark after it (the guard died, or a write it never got to)
 * keeps a null status.
 */
export function guardEntriesOf(lines: string[]): GuardEntry[] {
  const out: GuardEntry[] = [];
  callsByTurn(lines).forEach((turnLines, i) => {
    let open: GuardEntry | null = null;
    for (const line of turnLines) {
      const m = GUARD_MARK.exec(line);
      if (m && open && open.status === null && (m[2] ?? '') === open.argv) {
        open.status = m[1] as GuardStatus;
        continue;
      }
      open = { seq: out.length + 1, turn: i + 1, argv: line, status: null };
      out.push(open);
    }
  });
  return out;
}

export function guardOf(dir: string): GuardEntry[] {
  const lines = unitDirs(dir, 'agent').flatMap((name) => (readText(join(dir, name, 'agent', 'calls.log')) ?? '').split('\n').filter(Boolean));
  return guardEntriesOf(lines);
}

/** The judge's request, prompt and reply, from the folder's judge/ unit. */
export function judgeOf(dir: string): { model: string | null; prompt: string; reply: string | null; costUsd: number | null } | null {
  const unit = join(dir, 'judge');
  const prompt = readText(join(unit, 'prompt.md'));
  if (prompt === null) return null;
  const req = readJsonFile<SurfaceRequest>(join(unit, 'request.json'));
  const run = join(unit, 'run');
  const out = readJsonFile<{ result?: unknown; total_cost_usd?: unknown }>(join(run, 'out.json'));
  return { model: req?.model ?? null, prompt, reply: out ? String(out.result ?? '') : readText(join(run, 'reply.txt')), costUsd: out ? numOrNull(out.total_cost_usd) : null };
}

const SCORE_FILE = /^score(?:\.(.+))?\.json$/;

/**
 * Every score the rep was given, oldest first: each kept rescore and rejudge
 * (`score.<stamp>.json`), the older before-files, and score.json last. A
 * folder from before every version was kept holds only the first and the
 * latest, and says so.
 */
export function scoreVersionsOf(dir: string): ScoreVersion[] {
  const files = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => SCORE_FILE.test(f));
  const legacy = !files.some((f) => f !== 'score.json' && !f.startsWith('score.before-')) && files.some((f) => f.startsWith('score.before-'));
  const versions = files.flatMap((file) => {
    const s = readJsonFile<Partial<ScoreJson>>(join(dir, file));
    if (!s || typeof s.score !== 'number') return [];
    return [{ file, scoredAt: s.scoredAt ?? null, judgeModel: s.judgeModel ?? null, score: s.score, pass: s.pass === true, legacy } satisfies ScoreVersion];
  });
  const rank = (v: ScoreVersion) => (v.file === 'score.json' ? '￿' : v.scoredAt ?? (v.file.startsWith('score.before-') ? '' : v.file));
  return versions.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
}

/** sends.json as the run page lists it. */
export function sendsOf(dir: string): RunSendView[] {
  const sends = readJsonFile<Array<Partial<RunSendView> & { isGroup?: boolean }>>(join(dir, 'sends.json')) ?? [];
  return sends.map((s, i) => ({ seq: s.seq ?? i + 1, at: s.at ?? '', label: s.label ?? null, rail: s.rail ?? null, to: s.to ?? null, audience: String(s.audience ?? 'unknown'), text: s.text ?? '', chars: s.chars ?? (s.text ?? '').length }));
}

/** What the rep replied: its sends joined, else the captured replies. */
export function replyOf(dir: string): string | null {
  const sends = sendsOf(dir);
  if (sends.length) return sends.map((s) => s.text).join('\n\n');
  const captures = readJsonFile<Array<{ reply?: string; said?: string[] }>>(join(dir, 'captures.json'));
  const text = (captures ?? []).map((c) => c.reply ?? (c.said ?? []).join('\n\n')).filter(Boolean).join('\n\n');
  return text || null;
}

/** The last lines of run.log, or null when the rep left none. */
export function logTailOf(dir: string, lines = 40): string | null {
  const text = readText(join(dir, 'run.log'));
  return text ? text.split('\n').filter(Boolean).slice(-lines).join('\n') : null;
}

/** The folder's tree, depth first, at most `cap` entries; symlinks are listed, never followed. */
export function filesOf(dir: string, cap = 2000): RunFileEntry[] {
  const out: RunFileEntry[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      if (out.length >= cap) return;
      const path = join(at, name);
      const st = lstatSync(path);
      const kind = st.isDirectory() ? 'dir' : 'file';
      out.push({ path: relative(dir, path), kind, size: kind === 'dir' ? 0 : st.size });
      if (kind === 'dir') walk(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The largest file the run page reads whole. */
export const FILE_CAP = 2 * 1024 * 1024;

export class OutsideRunFolder extends Error {}

/**
 * One file inside a run folder. The path is resolved with realpath, so
 * neither `../` nor a symlink can lead outside the folder. Text past
 * FILE_CAP is cut and marked; a file with a NUL byte in its first 8 KiB is
 * binary and comes back with no text.
 */
export function runFile(id: string, path: string): RunFileResponse {
  const base = realpathSync(runDir(id));
  let target: string;
  try {
    target = realpathSync(join(base, path));
  } catch {
    throw new OutsideRunFolder(`no file ${path} in ${id}`);
  }
  if (target !== base && !target.startsWith(base + sep)) throw new OutsideRunFolder(`${path} is outside the run folder`);
  const st = statSync(target);
  if (!st.isFile()) throw new OutsideRunFolder(`${path} is not a file`);
  const bytes = readFileSync(target);
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return { path, size: st.size, text: null, truncated: false };
  return { path, size: st.size, text: bytes.subarray(0, FILE_CAP).toString('utf8'), truncated: st.size > FILE_CAP };
}

/** run.json, or the facts the index holds for a rep that died before writing it. */
export function runJsonOf(dir: string, row: RunRow, route: 'call' | 'agent'): RunJson {
  const run = readJsonFile<RunJson>(join(dir, 'run.json'));
  if (run) return run;
  return {
    freezeId: row.freezeId,
    notes: null,
    model: row.model ?? '',
    route,
    sourceHash: row.sourceHash ?? '',
    sourceHashDisk: row.sourceHashDisk,
    treePatch: row.treePatch,
    freezeSha: row.freezeSha,
    promptSha: row.promptSha,
    judgeModel: row.judgeModel,
    budgetUsd: null,
    gitHead: row.gitHead ?? '',
    dirty: row.dirty,
    temperatureProd: [],
    temperatureReplay: 'cli-default',
    liveReads: row.liveReads,
    batch: row.batch ?? '',
    cadence: row.cadence,
    title: row.freezeName,
  };
}

export const resultOf = (dir: string): RunResultJson | null => readJsonFile<RunResultJson>(join(dir, 'result.json'));
export const scoreOf = (dir: string): ScoreJson | null => readJsonFile<ScoreJson>(join(dir, 'score.json'));
