import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { renderGoalsBrief } from "@codecast/shared/contracts/goalsBrief";
import SHARED from "../../../docs/principles.md" with { type: "text" };
import { readPrinciples } from "./goalsCommand.js";
import { CODECAST_PRINCIPLES, loadLineProfile } from "./lineProfile.js";

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
    expect(out).toContain("## Principles\n\n- Product: PR-product-1");
  });

  test("the shared set ships with the CLI; a repo's own docs/principles.md is read only when its profile names it", async () => {
    fs.writeFileSync(path.join(repo, "docs", "principles.md"), "# Principles\n\nOne fact, one home.\n");
    await run("--json");
    expect(JSON.parse(out).principles).toBe(SHARED);
  });

  test("--project asks for one project's brief; without it the profile's [line] project, and its principles join the shared set", async () => {
    await run("--project", "pj-3");
    expect(calls[0].body.project).toBe("pj-3");
    calls.length = 0;
    fs.mkdirSync(path.join(repo, ".codecast"));
    fs.mkdirSync(path.join(repo, "outreach"));
    fs.writeFileSync(path.join(repo, ".codecast", "line.toml"), `[line]\nproject = "Agent Quality"\nprinciples = ["outreach/principles.md"]\n`);
    fs.writeFileSync(path.join(repo, "outreach", "principles.md"), "UN-1 Project one.\n");
    out = "";
    await run("--json");
    expect(calls[0].body.project).toBe("Agent Quality");
    expect(JSON.parse(out).principles).toBe(`${SHARED}\nUN-1 Project one.\n`);
  });

  test("readPrinciples: the shared set first, the profile's files that exist after it, never the shared set twice", () => {
    fs.writeFileSync(path.join(repo, "own.md"), "CC-1 Own.\n");
    fs.writeFileSync(path.join(repo, "copy.md"), "PR-1 Shared.\n");
    expect(readPrinciples(repo, ["own.md", "missing.md", "copy.md"], "PR-1 Shared.\n")).toEqual({
      text: "PR-1 Shared.\n\nCC-1 Own.\n",
      from: [CODECAST_PRINCIPLES, "own.md"],
    });
    expect(readPrinciples(null, ["own.md"], "PR-1 Shared.\n")?.from).toEqual([CODECAST_PRINCIPLES]);
    expect(readPrinciples(null, [], "")).toBeNull();
    expect(readPrinciples(repo, [], "")).toBeNull();
  });

  test("codecast's profile: the shared set holds PR- ids only, its own file CC- ids only, and both fit the brief whole", () => {
    const root = path.resolve(import.meta.dir, "../../..");
    const paths = loadLineProfile(root).profile.principles;
    expect(paths).toEqual(["docs/line/principles.md"]);
    const own = fs.readFileSync(path.join(root, paths[0]), "utf8");
    const ids = (text: string) => [...text.matchAll(/^### (\S+)/gm)].map((m) => m[1]);
    expect(ids(SHARED).every((id) => id.startsWith("PR-"))).toBe(true);
    expect(ids(own).every((id) => id.startsWith("CC-"))).toBe(true);
    expect(new Set(ids(own)).size).toBe(ids(own).length);
    const p = readPrinciples(root, paths)!;
    const brief = renderGoalsBrief({ initiatives: [], projects: [] } as any, { brief: true, principles: p.text, principlesFrom: p.from });
    for (const id of [...ids(SHARED), ...ids(own)]) expect(brief).toContain(`${id} `);
    expect(brief).toContain(`Full text: ${CODECAST_PRINCIPLES}, docs/line/principles.md.`);
  });
});
