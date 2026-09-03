// `cast integrations` runs through commander with a fake fetch, so every test
// exercises the real option parsing and the real request body. The server is
// a route table keyed by url path; process.exit is a thrown sentinel so a
// `fail()` inside an action surfaces as a rejected parse instead of killing
// the test runner.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { matchCandidate, registerIntegrationsCommand } from "./integrations.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realError = console.error;

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

type Call = { path: string; body: Record<string, unknown> };
let calls: Call[];
let routes: Record<string, unknown>;
let out: string[];
let err: string[];

beforeEach(() => {
  calls = [];
  routes = {};
  out = [];
  err = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    delete body.api_token;
    delete body.device_id;
    calls.push({ path, body });
    if (!(path in routes)) return new Response(JSON.stringify({ error: `no route ${path}` }), { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  }) as unknown as typeof fetch;
  process.exit = ((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never;
  console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.join(" ")); };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.exit = realExit;
  console.log = realLog;
  console.error = realError;
});

const resolvedProjects: string[] = [];

function run(...argv: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  registerIntegrationsCommand(program, {
    getCliEndpoint: () => ({ siteUrl: "https://x", apiToken: "tok" }),
    detectCurrentSessionId: () => null,
    resolveProjectId: async (ref) => {
      resolvedProjects.push(ref);
      return `proj_${ref}`;
    },
  });
  return program.parseAsync(["node", "cast", "integrations", ...argv]);
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const bodyFor = (path: string) => calls.find((c) => c.path === path)?.body;

const CANDIDATES = [
  { kind: "linear_team", external_id: "team-1", external_key: "ENG", name: "Engineering", url: "https://linear.app/eng" },
  { kind: "linear_team", external_id: "team-2", external_key: "API", name: "API" },
  { kind: "linear_project", external_id: "proj-3", name: "API Gateway" },
  { kind: "linear_project", external_id: "proj-4", name: "Mobile app" },
  { kind: "linear_project", external_id: "proj-5", name: "Mobile web" },
];

describe("matchCandidate", () => {
  it("resolves by external_key", () => {
    expect(matchCandidate(CANDIDATES, "ENG")).toEqual({ kind: "one", candidate: CANDIDATES[0] });
  });

  it("resolves by exact name, and an exact hit beats a substring hit", () => {
    // "API" is both a team's name and a substring of "API Gateway".
    expect(matchCandidate(CANDIDATES, "API")).toEqual({ kind: "one", candidate: CANDIDATES[1] });
    expect(matchCandidate(CANDIDATES, "API Gateway")).toEqual({ kind: "one", candidate: CANDIDATES[2] });
  });

  it("resolves by external_id", () => {
    expect(matchCandidate(CANDIDATES, "proj-3")).toEqual({ kind: "one", candidate: CANDIDATES[2] });
  });

  it("matches a name substring case insensitively when it is unique", () => {
    expect(matchCandidate(CANDIDATES, "gateway")).toEqual({ kind: "one", candidate: CANDIDATES[2] });
    expect(matchCandidate(CANDIDATES, "  engin ")).toEqual({ kind: "one", candidate: CANDIDATES[0] });
  });

  it("reports many when a substring hits two candidates", () => {
    const match = matchCandidate(CANDIDATES, "mobile");
    expect(match.kind).toBe("many");
    expect((match as any).matches).toEqual([CANDIDATES[3], CANDIDATES[4]]);
  });

  it("reports none for no hit or an empty ref", () => {
    expect(matchCandidate(CANDIDATES, "nothing-here")).toEqual({ kind: "none" });
    expect(matchCandidate(CANDIDATES, "   ")).toEqual({ kind: "none" });
  });
});

describe("cast integrations candidates", () => {
  it("accepts the server's bare array", async () => {
    routes["/cli/integrations/candidates"] = CANDIDATES;
    await run("candidates", "linear", "--json");
    expect(JSON.parse(out[0])).toEqual(CANDIDATES);
    expect(bodyFor("/cli/integrations/candidates")).toEqual({ provider: "linear" });
  });

  it("accepts a { candidates: [...] } wrapper", async () => {
    routes["/cli/integrations/candidates"] = { candidates: CANDIDATES };
    await run("candidates", "linear", "--json");
    expect(JSON.parse(out[0])).toEqual(CANDIDATES);
  });

  it("lists key, name, kind and id in the human view", async () => {
    routes["/cli/integrations/candidates"] = CANDIDATES;
    await run("candidates", "github");
    const text = out.map(strip).join("\n");
    expect(text).toContain("ENG  Engineering  linear_team  team-1");
    expect(text).toContain("cast integrations import github <key or name>");
  });

  it("points at connect when nothing is importable", async () => {
    routes["/cli/integrations/candidates"] = { candidates: [] };
    await run("candidates", "linear");
    expect(strip(out[0])).toContain("cast integrations connect linear");
  });

  it("rejects a provider that carries no issues", async () => {
    await expect(run("candidates", "slack")).rejects.toBeInstanceOf(ExitSentinel);
    expect(err[0]).toContain('Unknown provider "slack"');
    expect(calls).toHaveLength(0);
  });
});

describe("cast integrations import", () => {
  const added = { id: "src_new", project_id: "proj_Core", existing: false };

  it("matches against the server's bare array and prints the source id", async () => {
    routes["/cli/integrations/candidates"] = CANDIDATES;
    routes["/cli/integrations/add-source"] = added;
    await run("import", "linear", "ENG", "--project", "Core");
    expect(bodyFor("/cli/integrations/add-source")).toEqual({
      provider: "linear",
      kind: "linear_team",
      external_id: "team-1",
      external_key: "ENG",
      name: "Engineering",
      url: "https://linear.app/eng",
      project_id: "proj_Core",
    });
    expect(resolvedProjects.at(-1)).toBe("Core");
    const text = out.map(strip).join("\n");
    expect(text).toContain("Importing Engineering (linear_team) as src_new");
    expect(text).toContain("cast integrations sync src_new");
    expect(text).not.toContain("undefined");
  });

  it("matches against a { candidates: [...] } wrapper", async () => {
    routes["/cli/integrations/candidates"] = { candidates: CANDIDATES };
    routes["/cli/integrations/add-source"] = added;
    await run("import", "linear", "proj-3");
    const body = bodyFor("/cli/integrations/add-source")!;
    expect(body.external_id).toBe("proj-3");
    expect(body).not.toHaveProperty("project_id");
    expect(body).not.toHaveProperty("external_key");
    expect(strip(out[0])).toContain("as src_new");
  });

  it("falls back to _id when the server row carries no id", async () => {
    routes["/cli/integrations/candidates"] = CANDIDATES;
    routes["/cli/integrations/add-source"] = { _id: "src_legacy" };
    await run("import", "linear", "ENG");
    expect(strip(out[0])).toContain("as src_legacy");
  });

  it("narrows the pool with --kind and rejects an unknown kind", async () => {
    routes["/cli/integrations/candidates"] = CANDIDATES;
    routes["/cli/integrations/add-source"] = added;
    // Without --kind "API" is the team; with --kind linear_project the only hit is the substring match.
    await run("import", "linear", "API", "--kind", "linear_project");
    expect(bodyFor("/cli/integrations/add-source")!.external_id).toBe("proj-3");
    await expect(run("import", "linear", "API", "--kind", "jira_board")).rejects.toBeInstanceOf(ExitSentinel);
    expect(err.at(-1)).toContain('Unknown --kind "jira_board"');
  });

  it("fails on no match without calling add-source", async () => {
    routes["/cli/integrations/candidates"] = CANDIDATES;
    await expect(run("import", "linear", "nope")).rejects.toBeInstanceOf(ExitSentinel);
    expect(err[0]).toContain('No Linear candidate matching "nope"');
    expect(bodyFor("/cli/integrations/add-source")).toBeUndefined();
  });

  it("lists the matches on an ambiguous ref", async () => {
    routes["/cli/integrations/candidates"] = CANDIDATES;
    await expect(run("import", "linear", "mobile")).rejects.toBeInstanceOf(ExitSentinel);
    expect(err[0]).toContain('Ambiguous "mobile"');
    expect(err).toContain("  proj-4  Mobile app");
    expect(err).toContain("  proj-5  Mobile web");
    expect(bodyFor("/cli/integrations/add-source")).toBeUndefined();
  });
});

describe("cast integrations set", () => {
  beforeEach(() => {
    routes["/cli/integrations/update-source"] = { ok: true };
  });

  it("maps --auto-spawn and --push-new-tasks on|off to booleans", async () => {
    await run("set", "src1", "--auto-spawn", "on", "--push-new-tasks", "off");
    expect(bodyFor("/cli/integrations/update-source")).toEqual({ id: "src1", auto_spawn: true, push_new_tasks: false });
    expect(strip(out[0])).toBe("ok Updated src1");
  });

  it("accepts true/false and yes/no spellings, any case", async () => {
    await run("set", "src1", "--auto-spawn", "FALSE", "--push-new-tasks", "Yes");
    expect(bodyFor("/cli/integrations/update-source")).toEqual({ id: "src1", auto_spawn: false, push_new_tasks: true });
  });

  it("sends no toggle field when the flag is absent", async () => {
    await run("set", "src1", "--delegate-label", "agent", "--delegate-assignee", "cast-bot");
    expect(bodyFor("/cli/integrations/update-source")).toEqual({ id: "src1", delegate_label: "agent", delegate_assignee: "cast-bot" });
  });

  it("fails on an invalid toggle value before calling the server", async () => {
    await expect(run("set", "src1", "--auto-spawn", "maybe")).rejects.toBeInstanceOf(ExitSentinel);
    expect(err[0]).toBe('Invalid --auto-spawn "maybe" — pass on or off');
    await expect(run("set", "src1", "--push-new-tasks", "1")).rejects.toBeInstanceOf(ExitSentinel);
    expect(err[1]).toBe('Invalid --push-new-tasks "1" — pass on or off');
    expect(calls).toHaveLength(0);
  });

  it("refuses to run with nothing to set", async () => {
    await expect(run("set", "src1")).rejects.toBeInstanceOf(ExitSentinel);
    expect(err[0]).toContain("Nothing to set");
    expect(calls).toHaveLength(0);
  });
});
