import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DRY_RUN_SCRIPT } from '../paths';
import type { AgentOptions, AgentResult, CallResult, SurfaceRequest } from '../surface';

// Every model call an eval makes goes through packages/cli/scripts/
// prompt-dry-run.ts (pl-810): a private config dir, no hooks, a guard `cast`,
// and nothing reaching the founder's inbox. A call surface uses its --call
// mode; an agent surface runs a full turn against a served world. --dry
// returns canned output without spawning, so tests and wiring checks spend
// nothing.

const readJson = (path: string): any => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const readText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

// CODECAST_EVALS_ACCOUNT names a saved profile whose setup token every run
// spends (prompt-dry-run.ts --account). The machine login's access token is
// copied at spawn and dies when another session refreshes it, so a long agent
// run on it can end mid-turn with "OAuth token revoked"; a setup token cannot.
async function harness(args: string[], cwd: string): Promise<number> {
  const account = process.env.CODECAST_EVALS_ACCOUNT;
  const proc = Bun.spawn(['bun', DRY_RUN_SCRIPT, ...args, ...(account ? ['--account', account] : [])], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  writeFileSync(join(cwd, 'harness.log'), `${out}${err}`);
  return code;
}

const usageOf = (out: any): CallResult['modelUsage'] => (out?.modelUsage ?? {}) as CallResult['modelUsage'];

/** Each turn's usage summed per model, so a run of several turns reports what all of them spent. */
function mergeUsage(all: CallResult['modelUsage'][]): CallResult['modelUsage'] {
  const merged: CallResult['modelUsage'] = {};
  for (const usage of all) {
    for (const [model, u] of Object.entries(usage)) {
      const m = (merged[model] ??= {});
      for (const k of ['outputTokens', 'inputTokens', 'costUSD'] as const) if (u?.[k] !== undefined) m[k] = (m[k] ?? 0) + Number(u[k]);
    }
  }
  return merged;
}

/**
 * Why a harness run never got the model's answer for a reason the prompt did
 * not cause, or undefined: no out.json at all, or an API error such as a
 * revoked login, a rate limit or an overloaded server. A 400 or 413 is the
 * request's own fault, so it stays a graded failure.
 */
export function harnessFailure(out: any, exitCode: number): string | undefined {
  if (!out) return `the harness wrote no out.json (exit ${exitCode})`;
  if (out.terminal_reason !== 'api_error' || out.api_error_status === 400 || out.api_error_status === 413) return undefined;
  return `API error ${out.api_error_status ?? 'with no status'}: ${String(out.result ?? '').slice(0, 200)}`;
}

/** A run the model never answered, or one that left its world, says nothing about the prompt: the rep is a crash, not a 0 on every gate. */
export function assertAnswered(r: CallResult | AgentResult, label: string): void {
  if (r.harnessFailure) throw new Error(`${label} cannot grade the prompt: ${r.harnessFailure}; see ${'runSubdir' in r ? r.runSubdir : r.dir}`);
}

/** One single-call run: the request's prompt (and system) as files, the harness's --call mode, out.json read back. */
export async function runCall(req: SurfaceRequest, dir: string, opts: { dry: boolean }): Promise<CallResult> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prompt.md'), req.prompt);
  if (req.system) writeFileSync(join(dir, 'system.md'), req.system);
  writeFileSync(join(dir, 'request.json'), JSON.stringify(req, null, 1));
  const started = Date.now();
  if (opts.dry) {
    const outputTokens = Math.min(req.max_tokens, Math.ceil(req.prompt.length / 4));
    return { request: req, text: req.prompt, outputTokens, stopReason: 'end_turn', modelUsage: { [req.model]: { outputTokens } }, costUsd: 0, isError: false, exitCode: 0, dir, realMs: 0 };
  }
  const run = join(dir, 'run');
  const exitCode = await harness(
    ['--run', run, '--prompt', join(dir, 'prompt.md'), '--call', ...(req.system ? ['--system', join(dir, 'system.md')] : []), '--model', req.model, '--max-output-tokens', String(req.max_tokens)],
    dir,
  );
  return readCallRun(req, run, exitCode, Date.now() - started);
}

/** What a finished call run wrote, read back: a fresh call and `rescore` read it the same way. */
export function readCallRun(req: SurfaceRequest, run: string, exitCode: number, realMs: number): CallResult {
  const out = readJson(join(run, 'out.json'));
  return {
    request: req,
    text: String(out?.result ?? ''),
    outputTokens: Number(out?.usage?.output_tokens ?? 0),
    stopReason: out?.stop_reason ?? null,
    modelUsage: usageOf(out),
    costUsd: Number(out?.total_cost_usd ?? 0),
    isError: Boolean(out?.is_error) || exitCode !== 0 || !out,
    harnessFailure: harnessFailure(out, exitCode),
    exitCode,
    dir: run,
    realMs,
  };
}

/** One agent turn against a served world; said.json and calls.log come back for layout.ts to fold in. */
export async function runAgent(opts: AgentOptions, dir: string, flags: { dry: boolean }): Promise<AgentResult> {
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, 'prompt.md');
  writeFileSync(promptFile, opts.prompt);
  const runSubdir = join(dir, 'agent');
  const started = Date.now();
  if (flags.dry) {
    return { runSubdir, said: ['(dry run: no agent ran)'], turns: [['(dry run: no agent ran)']], calls: [], costUsd: 0, modelUsage: { [opts.model]: { outputTokens: 1 } }, isError: false, exitCode: 0, model: opts.model, realMs: 0 };
  }
  const thenFiles = (opts.then ?? []).map((text, i) => {
    const file = join(dir, `then${i + 2}.md`);
    writeFileSync(file, text);
    return file;
  });
  const exitCode = await harness(
    [
      '--run', runSubdir,
      '--prompt', promptFile,
      '--model', opts.model,
      ...(opts.serveDir ? ['--serve', opts.serveDir] : []),
      ...(opts.maxTurns ? ['--max-turns', String(opts.maxTurns)] : []),
      ...(opts.tools ? ['--tools', opts.tools.join(',')] : []),
      ...thenFiles.flatMap((f) => ['--then', f]),
    ],
    dir,
  );
  return readAgentRun(runSubdir, opts.model, 1 + thenFiles.length, exitCode, Date.now() - started);
}

/**
 * The model each top-level assistant message of a run answered on, counted
 * by message (the stream repeats a message once per content block). A
 * message an `Agent` subagent wrote carries its parent's tool use id, so it
 * is the subagent's, not the loop's.
 */
export function loopTurnsOf(streamText: string): Record<string, number> {
  const seen = new Map<string, string>();
  for (const line of streamText.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== 'assistant' || e.parent_tool_use_id || !e.message?.model) continue;
    seen.set(String(e.message.id ?? `${seen.size}`), String(e.message.model));
  }
  const turns: Record<string, number> = {};
  for (const model of seen.values()) turns[model] = (turns[model] ?? 0) + 1;
  return turns;
}

/**
 * The real CLI's answer with no sign-in: what any `cast` the guard did not
 * answer prints, because the harness gives the agent an empty state
 * directory. Matched as a whole line, so a file or transcript that merely
 * quotes the words is not a hit.
 */
const REAL_CLI_SIGNED_OUT = /^(?:Error: )?Not authenticated\. Run:? '?cast auth'?(?: first\.)?$/;

/**
 * The commands of a run whose `cast` reached the real CLI rather than the
 * guard, read from the stream: each tool result with the real CLI's signed-out
 * answer on a line of its own, named by the command that produced it. Such a
 * run read none of its world there and did something prod never would next,
 * so it says nothing about the prompt. calls.log cannot show it: the real CLI
 * writes nothing there.
 */
export function outsideWorldCommands(streamText: string): string[] {
  const commands = new Map<string, string>();
  const hits: string[] = [];
  for (const line of streamText.split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('Not authenticated')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    for (const c of content) {
      if (c?.type === 'tool_use') commands.set(String(c.id), String(c.input?.command ?? JSON.stringify(c.input ?? {})));
      if (c?.type !== 'tool_result') continue;
      const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '';
      if (text.split('\n').some((l: string) => REAL_CLI_SIGNED_OUT.test(l.replace(/\x1b\[[0-9;]*m/g, '').trim()))) hits.push(commands.get(String(c.tool_use_id)) ?? 'a command the stream does not name');
    }
  }
  return hits;
}

/** What a finished agent run of `turnCount` turns wrote, read back: a fresh run and `rescore` read it the same way. */
export function readAgentRun(runSubdir: string, model: string, turnCount: number, exitCode: number, realMs: number): AgentResult {
  // Turn 1 writes out.json, said.json and stream.jsonl, turn N outN.json, saidN.json and streamN.jsonl.
  const names = Array.from({ length: turnCount }, (_, i) => (i === 0 ? '' : String(i + 1)));
  const outs = names.map((n) => readJson(join(runSubdir, `out${n}.json`)));
  const turns = names.map((n) => ((readJson(join(runSubdir, `said${n}.json`)) ?? []) as string[]).map((s) => s.trim()).filter(Boolean));
  const last = outs.at(-1);
  const stream = names.map((n) => readText(join(runSubdir, `stream${n}.jsonl`))).join('\n');
  const outside = outsideWorldCommands(stream);
  return {
    runSubdir,
    said: turns.flat(),
    turns,
    calls: readText(join(runSubdir, 'calls.log')).split('\n').filter(Boolean),
    costUsd: outs.reduce((sum, o) => sum + Number(o?.total_cost_usd ?? 0), 0),
    modelUsage: mergeUsage(outs.map(usageOf)),
    loopTurns: loopTurnsOf(stream),
    isError: Boolean(last?.is_error) || exitCode !== 0 || !last,
    // A later turn missing its out.json may only follow an earlier turn's own failure. A run whose
    // agent reached the real CLI answered, but outside the world it is graded in.
    harnessFailure:
      outs.map((o, i) => (o || i === 0 ? harnessFailure(o, exitCode) : undefined)).find(Boolean) ??
      (outside.length ? `the agent's cast reached the real CLI outside the served world ${outside.length} time(s), first on: ${outside[0]!.slice(0, 200)}` : undefined),
    exitCode,
    model,
    realMs,
  };
}
