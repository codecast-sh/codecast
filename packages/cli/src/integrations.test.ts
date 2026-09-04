// cast integrations: the pure matcher, the two response shapes the server may
// answer with, and the set command's toggle parsing. Regressions guarded here:
// `candidates`/`import` once read `result.candidates` while the route returns
// the array itself, and `import` printed `source._id` while the server returns
// `{ id }`.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let answer: (path: string, body: Record<string, unknown>) => any = () => ({});

mock.module("./publish.js", () => ({
  apiPost: async (_deps: unknown, path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return answer(path, body);
  },
}));

const { matchCandidate, registerIntegrationsCommand } = await import("./integrations.js");

const deps = {
  getCliEndpoint: () => ({ siteUrl: "https://x.test", apiToken: "t" }),
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
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  process.exit = ((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as never;
});
afterEach(() => {
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
