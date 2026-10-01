import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readPrinciples } from "./goalsCommand.js";

describe("cast goals", () => {
  const SITE = "https://x.test";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  const realWrite = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  const realCwd = process.env.CODECAST_CWD;
  let out = "";
  let repo = "";
  const deps = { getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }), detectCurrentSessionId: () => "s1" } as any;
  const rows = {
    workspace: "team:t1",
    initiatives: [{ short_id: "in-1", title: "Grow", priority: "p0", health: "none", metrics: [{ key: "teams", name: "Teams", target: "100" }], project_short_ids: [] }],
    projects: [],
  };

  async function run(...argv: string[]) {
    const { Command } = await import("commander");
    const { registerGoalsCommand } = await import("./goalsCommand.js");
    const program = new Command();
    program.exitOverride();
    registerGoalsCommand(program, deps);
    await program.parseAsync(["node", "cast", "goals", ...argv]);
  }

  beforeEach(() => {
    calls.length = 0;
    out = "";
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "goals-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.mkdirSync(path.join(repo, "docs", "sub"), { recursive: true });
    process.env.CODECAST_CWD = path.join(repo, "docs", "sub");
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
      const { api_token: _token, ...body } = JSON.parse(String(init.body));
      calls.push({ path: String(url).slice(SITE.length), body });
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as typeof fetch;
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as any;
    console.log = (...args: unknown[]) => { out += `${args.map(String).join(" ")}\n`; };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.stdout.write = realWrite as any;
    console.log = realLog;
    if (realCwd === undefined) delete process.env.CODECAST_CWD;
    else process.env.CODECAST_CWD = realCwd;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("reads the brief for the directory and session, and renders it", async () => {
    await run("--brief");
    expect(calls).toEqual([{ path: "/cli/goals/brief", body: { project_path: path.join(repo, "docs", "sub"), conversation_id: "s1" } }]);
    expect(out).toContain("### in-1 Grow (p0)\n- `in-1:teams` Teams: not reported yet, target 100\n");
    expect(out).not.toContain("## Principles");
  });

  test("principles come from docs/principles.md at the repository root", async () => {
    fs.writeFileSync(path.join(repo, "docs", "principles.md"), "# Principles\n\nOne fact, one home.\n");
    await run();
    expect(out.endsWith("## Principles\n\nOne fact, one home.\n")).toBe(true);
    out = "";
    await run("--json");
    expect(JSON.parse(out).principles).toBe("# Principles\n\nOne fact, one home.\n");
  });

  test("no repository, no principles", () => {
    expect(readPrinciples(null)).toBeNull();
    expect(readPrinciples(repo)).toBeNull();
  });
});
