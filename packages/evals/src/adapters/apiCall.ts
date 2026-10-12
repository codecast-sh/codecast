import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { modelCost, postMessages, replyText } from '../../../convex/convex/lib/anthropic';
import { testMode } from '../registry';
import type { SurfaceRequest } from '../surface';

// A call rep posted straight to the Messages API with the evals' own key: the
// body is anthropicBody's, byte for byte what prod sends (thinking off on the
// cheap model included), which a replay through Claude Code cannot match.
// It writes the files a harness --call run writes, so readCallRun reads both.

const KEYCHAIN_SERVICE = 'codecast-evals-anthropic-key';

let cachedKey: string | null | undefined;

/**
 * The evals' API key: CODECAST_EVALS_ANTHROPIC_KEY, else the macOS keychain
 * item; none in test mode. Never ANTHROPIC_API_KEY, which a harness child
 * would read and bill agent reps to.
 */
export function evalsApiKey(): string | null {
  // A test run never reaches the API, whatever key the machine holds.
  if (testMode()) return null;
  if (cachedKey !== undefined) return cachedKey;
  const fromEnv = process.env.CODECAST_EVALS_ANTHROPIC_KEY?.trim();
  if (fromEnv) return (cachedKey = fromEnv);
  if (process.platform !== 'darwin') return (cachedKey = null);
  const r = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' });
  return (cachedKey = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null);
}

/** Statuses worth another try: the request was fine, the service was not. */
const RETRY = new Set([429, 500, 502, 503, 504, 529]);

/** Post one call rep into `run`, the way the harness's --call mode leaves it. Resolves to its exit code. */
export async function postCall(req: SurfaceRequest, run: string, apiKey: string): Promise<number> {
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'args.json'), JSON.stringify({ model: req.model, call: true, via: 'messages-api', maxOutputTokens: req.max_tokens }, null, 1) + '\n');
  const started = Date.now();
  let status = 0;
  let data: any = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    try {
      const res = await postMessages(req, { apiKey });
      status = res?.status ?? 0;
      data = res ? await res.json().catch(() => null) : null;
    } catch (e) {
      status = 0;
      data = { error: { message: e instanceof Error ? e.message : String(e) } };
    }
    if (status === 200 || !RETRY.has(status)) break;
  }
  const ok = status === 200;
  const usage = { input_tokens: data?.usage?.input_tokens ?? 0, output_tokens: data?.usage?.output_tokens ?? 0 };
  const costUsd = ok ? modelCost(req.model, usage) : 0;
  const text = ok ? replyText(data) : String(data?.error?.message ?? '');
  writeFileSync(
    join(run, 'out.json'),
    JSON.stringify(
      {
        result: text,
        stop_reason: data?.stop_reason ?? null,
        usage: data?.usage ?? usage,
        total_cost_usd: costUsd,
        is_error: !ok,
        terminal_reason: ok ? 'completed' : 'api_error',
        ...(ok ? {} : { api_error_status: status || null }),
        modelUsage: { [req.model]: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costUSD: costUsd } },
      },
      null,
      1,
    ),
  );
  writeFileSync(join(run, 'reply.txt'), text);
  const exitCode = ok ? 0 : 1;
  writeFileSync(join(run, 'exit.txt'), `${exitCode}\n`);
  writeFileSync(join(run, 'took.txt'), `${Math.round((Date.now() - started) / 1000)}s\n`);
  return exitCode;
}
