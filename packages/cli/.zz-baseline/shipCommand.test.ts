import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { markBody, registerShipCommand, type LocalCheckout } from "./shipCommand";
import { clearWorkspaceCache } from "./resolveWorkspace";

const SHA = "ca172db32aa0e4b1c0de5e1f00d2a7c3b4e5f601";
const HERE: LocalCheckout = { repository: "codecast-sh/codecast", head: SHA };

describe("markBody", () => {
  test("the checkout supplies repository and HEAD; flags win", () => {
    expect(markBody({ surface: "backend" }, HERE)).toEqual({ repository: "codecast-sh/codecast", surface: "backend", sha: SHA });
    expect(markBody({ surface: "web", sha: "abc1234", repo: "o/r", version: "1.2.3" }, HERE)).toEqual({ repository: "o/r", surface: "web", sha: "abc1234", version: "1.2.3" });
  });

  test("outside a GitHub checkout it says what to pass", () => {
    expect(() => markBody({ surface: "backend" }, { repository: null, head: SHA })).toThrow("--repo");
    expect(() => markBody({ surface: "backend" }, { repository: "o/r", head: null })).toThrow("--sha");
  });
});

describe("cast ship mark", () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  let calls: Array<{ url: string; body: any }>;
  let printed: string[];

  beforeEach(() => {
    calls = [];
    printed = [];
    clearWorkspaceCache();
    console.log = (...args: unknown[]) => { printed.push(args.join(" ")); };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      const answer = url.endsWith("/cli/teams")
        ? { teams: [{ _id: "team_codecast", name: "codecast" }, { _id: "team_union", name: "Union" }], active_team_id: null }
        : { ok: true, event_id: "ev_1", team_id: body.team_id ?? "team_codecast", repository: body.repository, surface: body.surface, sha: body.sha, version: body.version ?? null };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
  });

  const run = async (...argv: string[]) => {
    const program = new Command().exitOverride();
    registerShipCommand(program, {
      getCliEndpoint: () => ({ siteUrl: "https://cast.example", apiToken: "tok" }),
      detectCurrentSessionId: () => null,
      checkout: async () => HERE,
    });
    await program.parseAsync(["bun", "cast", "ship", "mark", ...argv]);
  };

  test("posts the marker with the caller's token and prints what it marked", async () => {
    await run("--surface", "backend");
    expect(calls).toEqual([{
      url: "https://cast.example/cli/changes/mark-deploy",
      body: { api_token: "tok", repository: "codecast-sh/codecast", surface: "backend", sha: SHA },
    }]);
    expect(printed.at(-1)).toContain("Marked backend at ca172db on codecast-sh/codecast");
  });

  test("--team resolves a name the person sees to the team id", async () => {
    await run("--surface", "web", "--version", "1.2.3", "--team", "union", "--json");
    expect(calls.map((c) => c.url)).toEqual(["https://cast.example/cli/teams", "https://cast.example/cli/changes/mark-deploy"]);
    expect(calls[1].body).toMatchObject({ team_id: "team_union", version: "1.2.3" });
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ ok: true, team_id: "team_union", surface: "web" });
  });

  test("an unknown --team is refused with the real choices, before anything is posted", async () => {
    await expect(run("--surface", "web", "--team", "nope")).rejects.toThrow('No team matching "nope"');
    expect(calls.map((c) => c.url)).toEqual(["https://cast.example/cli/teams"]);
  });

  test("--dry-run prints the marker and posts nothing", async () => {
    await run("--surface", "backend", "--sha", "abc1234", "--dry-run");
    expect(calls).toEqual([]);
    expect(printed).toEqual(["Would mark backend at abc1234 on codecast-sh/codecast"]);
  });
});
