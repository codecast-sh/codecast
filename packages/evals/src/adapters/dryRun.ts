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

/** A run the model never answered says nothing about the prompt: the rep is a crash, not a 0 on every gate. */
export function assertAnswered(r: CallResult | AgentResult, label: string): void {
  if (r.harnessFailure) throw new Error(`${label} never reached the model: ${r.harnessFailure}; see ${'runSubdir' in r ? r.runSubdir : r.dir}`);
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
    realMs: Date.now() - started,
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
  // Turn 1 writes out.json and said.json, turn N outN.json and saidN.json.
  const names = ['', ...thenFiles.map((_, i) => String(i + 2))];
  const outs = names.map((n) => readJson(join(runSubdir, `out${n}.json`)));
  const turns = names.map((n) => ((readJson(join(runSubdir, `said${n}.json`)) ?? []) as string[]).map((s) => s.trim()).filter(Boolean));
  const last = outs.at(-1);
  return {
    runSubdir,
    said: turns.flat(),
    turns,
    calls: readText(join(runSubdir, 'calls.log')).split('\n').filter(Boolean),
    costUsd: outs.reduce((sum, o) => sum + Number(o?.total_cost_usd ?? 0), 0),
    modelUsage: mergeUsage(outs.map(usageOf)),
    isError: Boolean(last?.is_error) || exitCode !== 0 || !last,
    // A later turn missing its out.json may only follow an earlier turn's own failure.
    harnessFailure: outs.map((o, i) => (o || i === 0 ? harnessFailure(o, exitCode) : undefined)).find(Boolean),
    exitCode,
    model: opts.model,
    realMs: Date.now() - started,
  };
}
