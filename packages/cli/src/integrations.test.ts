// cast integrations: the pure matcher, the two response shapes the server may
// answer with, and the set command's toggle parsing. Regressions guarded here:
// `candidates`/`import` once read `result.candidates` while the route returns
// the array itself, and `import` printed `source._id` while the server returns
// `{ id }`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let answer: (path: string, body: Record<string, unknown>) => any = () => ({});

// The transport is what gets faked here, never the module.
//
// castApi.js is the CLI's single HTTP entry point and ten commands import
// `apiPost` from it, so mocking that MODULE reaches far outside this file:
// bun's `mock.module` is process-global and never lifts, so every suite loaded
// afterwards saw a stub that answered `{}` to everything. That is not a
// failure, it is a plausible wrong answer — `cast review add` posted nothing
// and printed ok, and reviewCommand.test.ts failed 150 files later on an empty
// batch, taking the runner down with it (ct-49918).
//
// Faking `globalThis.fetch` per test keeps the blast radius inside this file
// and exercises the real `apiPost`, which is the code that actually shapes the
// request. `api_token` is dropped from the record because these tests are
// about what each command sends, not about how it authenticates.
const SITE = "https://x.test";
const realFetch = globalThis.fetch;

const { matchCandidate, registerIntegrationsCommand } = await import("./integrations.js");

const deps = {
  getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }),
  detectCurrentSessionId: () => null,
  resolveProjectId: async (ref: string) => `proj:${ref}`,
} as any;

let logs: string[] = [];
const realLog = console.log;
const realError = console.error;
const realExit = process.exit;

async function run(...argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerIntegrationsCommand(program, deps);
  await program.parseAsync(["node", "cast", "integrations", ...argv]);
}

beforeEach(() => {
  calls.length = 0;
  logs = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    const path = String(url).slice(SITE.length);
    const { api_token: _token, ...body } = JSON.parse(String(init.body));
    calls.push({ path, body });
    return new Response(JSON.stringify(answer(path, body)), { status: 200 });
  }) as typeof fetch;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  process.exit = ((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as never;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  process.exit = realExit;
});

const cands = [
  { kind: "linear_team", external_id: "uuid-1", external_key: "ASH", name: "ASH · Ashot" },
  { kind: "linear_project", external_id: "uuid-2", name: "Wedding" },
  { kind: "github_repo", external_id: "codecast-sh/codecast", name: "codecast-sh/codecast" },
  { kind: "github_repo", external_id: "codecast-sh/codecast-docs", name: "codecast-sh/codecast-docs" },
];

describe("matchCandidate", () => {
  test("exact key, name and id win, case insensitive", () => {
    expect(matchCandidate(cands, "ash")).toEqual({ kind: "one", candidate: cands[0] });
    expect(matchCandidate(cands, "WEDDING")).toEqual({ kind: "one", candidate: cands[1] });
    expect(matchCandidate(cands, "uuid-2")).toEqual({ kind: "one", candidate: cands[1] });
  });
  test("an exact hit beats the substrings it would otherwise be ambiguous with", () => {
    expect(matchCandidate(cands, "codecast-sh/codecast")).toEqual({ kind: "one", candidate: cands[2] });
  });
  test("a unique substring resolves; a shared one is ambiguous; nothing is none", () => {
    expect(matchCandidate(cands, "docs")).toEqual({ kind: "one", candidate: cands[3] });
    expect(matchCandidate(cands, "codecast-sh/").kind).toBe("many");
    expect(matchCandidate(cands, "nope")).toEqual({ kind: "none" });
    expect(matchCandidate(cands, "  ")).toEqual({ kind: "none" });
  });
});

describe("candidates", () => {
  test("reads a bare array from the route", async () => {
    answer = () => cands;
    await run("candidates", "linear");
    expect(logs.join("\n")).toContain("ASH · Ashot");
    expect(logs.join("\n")).not.toContain("Nothing importable");
  });
  test("still reads a { candidates } wrapper", async () => {
    answer = () => ({ candidates: cands });
    await run("candidates", "github", "--json");
    expect(JSON.parse(logs[0]).length).toBe(4);
  });
});

describe("import", () => {
  test("posts the matched candidate and prints the server's source id", async () => {
    answer = (path) => (path.endsWith("/candidates") ? cands : { id: "src_123", project_id: "p1", existing: false });
    await run("import", "linear", "ASH", "--project", "Ashot");
    const add = calls.find((c) => c.path === "/cli/integrations/add-source")!;
    expect(add.body).toMatchObject({ provider: "linear", kind: "linear_team", external_id: "uuid-1", project_id: "proj:Ashot" });
    const out = logs.join("\n");
    expect(out).toContain("src_123");
    expect(out).not.toContain("undefined");
  });
});

describe("set", () => {
  test("maps on/off flags to booleans and sends only what was passed", async () => {
    answer = () => ({});
    await run("set", "src_1", "--auto-spawn", "on", "--push-new-tasks", "off", "--delegate-label", "agent");
    const upd = calls.find((c) => c.path === "/cli/integrations/update-source")!;
    expect(upd.body).toEqual({ id: "src_1", auto_spawn: true, push_new_tasks: false, delegate_label: "agent" });
  });
  test("refuses a bad toggle value and an empty set", async () => {
    answer = () => ({});
    await expect(run("set", "src_1", "--auto-spawn", "maybe")).rejects.toThrow(/exit/);
    expect(calls.length).toBe(0);
    await expect(run("set", "src_1")).rejects.toThrow(/exit/);
    expect(calls.length).toBe(0);
  });
});
