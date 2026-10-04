// The fake transport the external data command tests share: the real command
// shapes each request, globalThis.fetch answers it, and console and exit are
// captured. Same technique as signalCommand.test.ts, held once for five
// modules.
import { afterEach, beforeEach } from "bun:test";
import type { Command } from "commander";

export const SITE = "https://x.test";

export interface Harness {
  calls: Array<{ path: string; body: Record<string, any> }>;
  logs: string[];
  answer: (path: string, body: Record<string, any>) => any;
  run: (...argv: string[]) => Promise<void>;
  out: () => string;
}

export function useCliHarness(group: string, load: () => Promise<(program: Command, deps: any) => void>): Harness {
  const h: Harness = {
    calls: [],
    logs: [],
    answer: () => ({}),
    run: async (...argv: string[]) => {
      const { Command } = await import("commander");
      const program = new Command();
      program.exitOverride();
      (await load())(program, deps);
      await program.parseAsync(["node", "cast", group, ...argv]);
    },
    out: () => h.logs.join("\n"),
  };
  const deps = { getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }), detectCurrentSessionId: () => "s1" };
  const real = { fetch: globalThis.fetch, log: console.log, error: console.error, exit: process.exit, cwd: process.env.CODECAST_CWD };

  beforeEach(() => {
    h.calls.length = 0;
    h.logs.length = 0;
    h.answer = () => ({});
    process.env.CODECAST_CWD = "/repo";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).startsWith(SITE) ? String(url).slice(SITE.length) : String(url);
      const parsed = init?.body ? JSON.parse(String(init.body)) : {};
      const { api_token: _token, ...body } = parsed;
      h.calls.push({ path, body });
      const answer = h.answer(path, body);
      if (answer instanceof Response) return answer;
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    console.log = (...args: unknown[]) => { h.logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { h.logs.push(args.map(String).join(" ")); };
    process.exit = ((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as never;
  });
  afterEach(() => {
    globalThis.fetch = real.fetch;
    console.log = real.log;
    console.error = real.error;
    process.exit = real.exit;
    if (real.cwd === undefined) delete process.env.CODECAST_CWD;
    else process.env.CODECAST_CWD = real.cwd;
  });
  return h;
}

/** The scope every read and write carries from /repo and session s1. */
export const SCOPE = { project_path: "/repo", conversation_id: "s1" };
