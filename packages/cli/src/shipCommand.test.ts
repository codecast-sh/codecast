import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAddedBy, markBody, readChanges, registerShipCommand, type LocalCheckout } from "./shipCommand";
import { clearWorkspaceCache } from "./resolveWorkspace";

const SHA = "ca172db32aa0e4b1c0de5e1f00d2a7c3b4e5f601";
const HERE: LocalCheckout = { repository: "codecast-sh/codecast", head: SHA };

describe("markBody", () => {
  test("the checkout supplies repository and HEAD; flags win", () => {
    expect(markBody({ surface: "backend" }, HERE)).toEqual({ repository: "codecast-sh/codecast", surface: "backend", sha: SHA });
    expect(markBody({ surface: "web", sha: "abc1234", repo: "o/r", version: "1.2.3" }, HERE)).toEqual({ repository: "o/r", surface: "web", sha: "abc1234", version: "1.2.3" });
  });

  test("a push's own record names its machine, path and what it changed; a plain mark does not", () => {
    expect(markBody({ surface: "backend", via: "dev watcher", dirty: "3" }, HERE, { adds: ["table:voiceprints"], drops: [] }, "box-1")).toEqual({
      repository: "codecast-sh/codecast", surface: "backend", sha: SHA, dirty: 3, via: "dev watcher", machine: "box-1", adds: ["table:voiceprints"], drops: [],
    });
    // A push whose diff did not run sends no lists at all, so nobody reads it as "dropped nothing".
    expect(markBody({ surface: "backend", via: "deploy.sh" }, HERE, {}, "box-1")).not.toHaveProperty("drops");
    expect(markBody({ surface: "backend", machine: "named" }, HERE, {}, "box-1")).toMatchObject({ machine: "named" });
    expect(markBody({ surface: "backend" }, HERE, {}, "box-1")).not.toHaveProperty("machine");
  });

  test("--changes reads prod-diff's JSON and keeps only names", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-changes-"));
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ adds: ["fn:a:b", 7], drops: ["index:t.i"], tree_ms: 9 }));
    expect(readChanges(file)).toEqual({ adds: ["fn:a:b"], drops: ["index:t.i"] });
    expect(readChanges(undefined)).toEqual({});
    writeFileSync(file, JSON.stringify({ adds: [] }));
    expect(readChanges(file)).toEqual({});
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

describe("cast ship added-by", () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  let calls: Array<{ url: string; body: any }>;
  let printed: string[];
  const FOUND = [{ name: "index:voiceprints.by_user", deploy: "dp-2372", by: "Ashot Petrosian", machine: "MacBook-Pro-182", via: "deploy.sh", at: Date.UTC(2026, 10, 22, 5, 21), dirty: 78 }];

  beforeEach(() => {
    calls = [];
    printed = [];
    console.log = (...args: unknown[]) => { printed.push(args.join(" ")); };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ found: FOUND }), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; console.log = realLog; });

  const run = async (...argv: string[]) => {
    const program = new Command().exitOverride();
    registerShipCommand(program, { getCliEndpoint: () => ({ siteUrl: "https://cast.example", apiToken: "tok" }), detectCurrentSessionId: () => null, checkout: async () => HERE });
    await program.parseAsync(["bun", "cast", "ship", "added-by", ...argv]);
  };

  test("asks for the names given and the drops in --names, and says who put each there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-added-"));
    const file = join(dir, "d.json");
    writeFileSync(file, JSON.stringify({ adds: ["fn:x:y"], drops: ["table:voiceprints"] }));
    await run("--surface", "backend", "--names", file, "index:voiceprints.by_user");
    expect(calls).toEqual([{ url: "https://cast.example/cli/deploys/added-by", body: { api_token: "tok", repository: "codecast-sh/codecast", surface: "backend", names: ["index:voiceprints.by_user", "table:voiceprints"] } }]);
    expect(printed.at(-1)).toContain("index:voiceprints.by_user  dp-2372 push with 78 uncommitted files by Ashot Petrosian on MacBook-Pro-182");
  });

  test("with nothing to ask it posts nothing", async () => {
    await run("--surface", "backend", "--json");
    expect(calls).toEqual([]);
    expect(JSON.parse(printed.at(-1)!)).toEqual({ found: [] });
  });

  test("a watcher push reads as one", () => {
    expect(formatAddedBy([{ ...FOUND[0], via: "dev watcher", dirty: 0 }])).toContain("dp-2372 dev watcher push by Ashot Petrosian");
    expect(formatAddedBy([{ ...FOUND[0], committed_in: "dp-2380" }])).toContain("; committed since (dp-2380 carried it)");
  });
});
