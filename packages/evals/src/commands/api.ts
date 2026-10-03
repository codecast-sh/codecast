import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import type { Command } from 'commander';
import type { EvalsBridgeRequest, EvalsBridgeResponse } from '@codecast/shared/contracts/evalsApi';

// `./evals api --stdio`: the process the daemon's /evals bridge talks to
// (evals-ui.md sections 2 and 3.5). One EvalsBridgeRequest JSON line in per
// request on stdin, one EvalsBridgeResponse JSON line out per answer on
// stdout, matched by id; answers may arrive out of order. It exits when its
// stdin closes, which is how it dies with the daemon even after a hard exit.
// Nothing else may reach stdout: console.log goes to stderr while it serves.

/** How long answers still in flight may finish once stdin has closed: the bridge's own request timeout. */
const DRAIN_MS = 120_000;

function parseRequest(line: string): EvalsBridgeRequest | { id: number; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { id: -1, error: 'not a JSON line' };
  }
  const r = v as Partial<EvalsBridgeRequest>;
  const id = typeof r?.id === 'number' ? r.id : -1;
  if (id < 0) return { id, error: 'a request needs a numeric id' };
  if (r.method !== 'GET' && r.method !== 'POST') return { id, error: 'method is GET or POST' };
  if (typeof r.path !== 'string') return { id, error: 'path is required' };
  const query: Record<string, string> = {};
  for (const [k, val] of Object.entries(r.query ?? {})) if (typeof val === 'string') query[k] = val;
  return { id, method: r.method, path: r.path, query, body: r.body };
}

/**
 * Serves requests from `input` until it closes, then waits for the answers
 * in flight (at most DRAIN_MS). Resolves when it is done.
 */
export async function serveStdio(input: Readable = process.stdin, write: (line: string) => void = (l) => process.stdout.write(l)): Promise<void> {
  const { handleRequest } = await import('../api/handlers');
  const send = (r: EvalsBridgeResponse) => write(`${JSON.stringify(r)}\n`);
  const inFlight = new Set<Promise<void>>();
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const req = parseRequest(line);
    if ('error' in req) {
      send({ id: req.id, status: 400, body: { error: req.error, reason: 'bad-request' } });
      return;
    }
    const p = handleRequest(req).then(send, (e: unknown) => send({ id: req.id, status: 500, body: { error: e instanceof Error ? e.message : String(e) } }));
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  });
  await new Promise<void>((resolve) => rl.once('close', resolve));
  const drained = Promise.all([...inFlight]).then(() => undefined);
  await Promise.race([drained, new Promise<void>((r) => setTimeout(r, DRAIN_MS).unref())]);
}

/** Runs the server as this process's whole job: stdout carries answers only, and the process ends once stdin closes. */
export async function apiMain(argv: string[]): Promise<number> {
  if (!argv.includes('--stdio')) {
    process.stderr.write('evals api: only --stdio is served; the daemon starts it as `api --stdio`\n');
    return 2;
  }
  console.log = console.error;
  console.info = console.error;
  await serveStdio();
  // A detached spawn or a lingering handle must not keep a child alive after its daemon is gone.
  setTimeout(() => process.exit(0), 1000).unref();
  return 0;
}

export function registerApi(program: Command): void {
  program
    .command('api')
    .description("serve the Evals UI to the daemon's /evals bridge: one JSON request per stdin line, one answer per stdout line")
    .option('--stdio', 'speak line-delimited JSON on stdin and stdout (the only transport)')
    .action(async (flags: { stdio?: boolean }) => {
      process.exitCode = await apiMain(flags.stdio ? ['--stdio'] : []);
    });
}

// Until main.ts registers `api` (wave 3), `bun packages/evals/src/commands/api.ts --stdio` runs it directly.
if (import.meta.main) process.exitCode = await apiMain(process.argv.slice(2));
