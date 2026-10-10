// `cast signal` (the-line-end-to-end.md LE3): the argument rules and what each
// verb posts. The transport is faked at globalThis.fetch, never the module, so
// the real command shapes the request.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatSignalList, signalAddBody, type SignalRow } from "./signalCommand.js";

describe("signalAddBody", () => {
  test("source, kind and title are required and named when missing", () => {
    expect(() => signalAddBody({ source: "sentry", kind: "bug" })).toThrow("needs --title");
    expect(() => signalAddBody({})).toThrow("--source, --kind, --title");
  });

  test("a hand-filed signal without a fingerprint keys on its source and title", () => {
    expect(signalAddBody({ source: "person", kind: "bug", title: "Checkout  Throws!" }).fingerprint).toBe("person:checkout-throws");
  });

  test("a product's finding files under its issue key, with its judge, version and severity (learning-loop.md LL3)", () => {
    expect(signalAddBody({ source: "agentwatch", kind: "bug", title: "Narrates effort", issue: " union:cluster:a ", judge: "comms", judgeVersion: "v7", severity: "8" })).toEqual({
      source: "agentwatch", kind: "bug", title: "Narrates effort", fingerprint: "union:cluster:a", issue: true, judge: "comms", judge_version: "v7", severity: 8,
    });
    expect(() => signalAddBody({ source: "agentwatch", kind: "bug", title: "t", issue: "union:cluster:a", fingerprint: "x" })).toThrow("not both");
    expect(() => signalAddBody({ source: "agentwatch", kind: "bug", title: "t", severity: "high" })).toThrow("--severity takes a number");
  });

  test("an unknown kind is refused with the list", () => {
    expect(() => signalAddBody({ source: "s", kind: "feeling", fingerprint: "f", title: "t" })).toThrow("Kinds: bug, regression, prompt_miss, ux, cohesion, request");
  });

  test("optional fields map to their wire names and blanks are dropped", () => {
    expect(signalAddBody({ source: " evals ", kind: "Prompt_Miss", fingerprint: "title:check-3", title: " Title drifts ", detail: "## Seen\nthree reps", url: "https://x", subject: "title", goalHint: " ", })).toEqual({
      source: "evals",
      kind: "prompt_miss",
      fingerprint: "title:check-3",
      title: "Title drifts",
      detail_md: "## Seen\nthree reps",
      evidence_url: "https://x",
      subject: "title",
    });
  });
});

describe("formatSignalList", () => {
  const row: SignalRow = {
    short_id: "sg-4", source: "sentry", kind: "bug", fingerprint: "e1", title: "Checkout throws",
    observed_at: 0, created_at: 0, attach: "fingerprint", reopened: true, task_short_id: "ct-9",
  };
  test("one line per signal names the cause and how it attached", () => {
    expect(formatSignalList([row], 120_000)).toBe("sg-4  sentry/bug  Checkout throws  → ct-9 (same fingerprint, reopened it; 2m ago)");
    expect(formatSignalList([])).toContain("cast signal add");
  });
});

describe("cast signal on the wire", () => {
  const SITE = "https://x.test";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let answer: (path: string) => any = () => ({});
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  const realCwd = process.env.CODECAST_CWD;
  let logs: string[] = [];
  const deps = { getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }), detectCurrentSessionId: () => "s1" } as any;

  async function run(...argv: string[]) {
    const { Command } = await import("commander");
    const { registerSignalCommand } = await import("./signalCommand.js");
    const program = new Command();
    program.exitOverride();
    registerSignalCommand(program, deps);
    await program.parseAsync(["node", "cast", "signal", ...argv]);
  }

  beforeEach(() => {
    calls.length = 0;
    logs = [];
    answer = () => ({});
    process.env.CODECAST_CWD = "/repo";
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
      const path = String(url).slice(SITE.length);
      const { api_token: _token, ...body } = JSON.parse(String(init.body));
      calls.push({ path, body });
      return new Response(JSON.stringify(answer(path)), { status: 200 });
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
    if (realCwd === undefined) delete process.env.CODECAST_CWD;
    else process.env.CODECAST_CWD = realCwd;
  });

  test("add posts the typed signal with the directory and the session", async () => {
    answer = () => ({ short_id: "sg-1", task_short_id: "ct-7", attach: "new", signal_count: 1, reopened: false });
    await run("add", "--source", "person", "--kind", "ux", "--fingerprint", "nav:back", "--title", "Back loses scroll", "--subject", "web/inbox", "--goal-hint", "retention");
    expect(calls).toEqual([{ path: "/cli/signal/add", body: {
      source: "person", kind: "ux", fingerprint: "nav:back", title: "Back loses scroll", subject: "web/inbox", goal_hint: "retention",
      project_path: "/repo", conversation_id: "s1",
    } }]);
    expect(logs.join("\n")).toContain("sg-1 → ct-7 (new cause; 1 signal)");
  });

  test("add without the required flags posts nothing", async () => {
    await expect(run("add", "--source", "person")).rejects.toThrow(/exit 1/);
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("--kind, --title");
  });

  test("move sends the key, the cause it leaves, and where it goes", async () => {
    answer = () => ({ from: "ct-7", to: "ct-9", moved: 2, created: true });
    await run("move", "--fingerprint", "union:cluster:c1", "--from", "ct-7", "--title", "Held call cards dial outside hours", "--json");
    expect(calls[0]).toEqual({ path: "/cli/signal/move", body: { fingerprint: "union:cluster:c1", from: "ct-7", title: "Held call cards dial outside hours", project_path: "/repo", conversation_id: "s1" } });
  });

  test("ls --fingerprint asks the server for that one key in the workspace", async () => {
    answer = () => ({ signals: [] });
    await run("ls", "--fingerprint", "union:cluster:c1", "-n", "1", "--json");
    expect(calls[0]).toEqual({ path: "/cli/signal/ls", body: { fingerprint: "union:cluster:c1", limit: 1, project_path: "/repo", conversation_id: "s1" } });
  });

  test("ls --task reads one cause's signals; ls --source reads the workspace", async () => {
    answer = () => ({ signals: [] });
    await run("ls", "--task", "ct-7");
    await run("ls", "--source", "evals", "--json");
    expect(calls[0]).toEqual({ path: "/cli/signal/ls", body: { task: "ct-7" } });
    expect(calls[1]).toEqual({ path: "/cli/signal/ls", body: { source: "evals", project_path: "/repo", conversation_id: "s1" } });
  });

  test("add --project sends the ref for the server to resolve in the write workspace; ls --project reads one project", async () => {
    answer = (path) => (path === "/cli/signal/ls" ? { signals: [] } : { short_id: "sg-3", task_short_id: "ct-8", attach: "new", signal_count: 1 });
    // The argv Union's finder door sends (outreach/backend/src/lib/line/signal.ts signalAddArgv), less the stdin detail.
    await run("add", "--source", "agentwatch", "--kind", "prompt_miss", "--fingerprint", "union:cluster:c1", "--title", "Agent repeats itself", "--url", "https://u.test/c1", "--subject", "outreach.reply", "--goal-hint", "reply_rate", "--project", "Agent Quality", "--json");
    await run("ls", "--project", "Agent Quality");
    expect(calls[0].body).toMatchObject({ source: "agentwatch", fingerprint: "union:cluster:c1", project: "Agent Quality", project_path: "/repo" });
    expect(calls[1]).toEqual({ path: "/cli/signal/ls", body: { project: "Agent Quality", project_path: "/repo", conversation_id: "s1" } });
  });

  test("without --project, add takes the repo profile's [line] project and team; ls stays workspace wide", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "signal-profile-"));
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, ".codecast"));
    fs.writeFileSync(path.join(repo, ".codecast", "line.toml"), `[line]\nteam = "Union"\nproject = "Agent Quality"\n`);
    process.env.CODECAST_CWD = repo;
    answer = (path) => (path === "/cli/teams" ? { teams: [{ _id: "team1", name: "Union" }], user_id: "u1" } : path === "/cli/signal/ls" ? { signals: [] } : { short_id: "sg-4", task_short_id: "ct-9", attach: "fingerprint", signal_count: 2 });
    await run("add", "--source", "person", "--kind", "bug", "--title", "Checkout breaks");
    await run("ls");
    const add = calls.find((c) => c.path === "/cli/signal/add")!;
    expect(add.body).toMatchObject({ project: "Agent Quality", workspace: "team", team_id: "team1" });
    const ls = calls.find((c) => c.path === "/cli/signal/ls")!;
    expect(ls.body.project).toBeUndefined();
    expect(ls.body).toMatchObject({ workspace: "team", team_id: "team1" });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("--team naming another workspace drops the profile's project; naming the profile's team keeps it", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "signal-profile-"));
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, ".codecast"));
    fs.writeFileSync(path.join(repo, ".codecast", "line.toml"), `[line]\nteam = "Union"\nproject = "Agent Quality"\n`);
    process.env.CODECAST_CWD = repo;
    answer = (path) => (path === "/cli/teams" ? { teams: [{ _id: "team1", name: "Union" }], user_id: "u1" } : { short_id: "sg-5", task_short_id: "ct-9", attach: "new", signal_count: 1 });
    await run("add", "--source", "person", "--kind", "bug", "--title", "x", "--team", "personal");
    await run("add", "--source", "person", "--kind", "bug", "--title", "y", "--team", "union");
    const adds = calls.filter((c) => c.path === "/cli/signal/add");
    expect(adds[0].body.project).toBeUndefined();
    expect(adds[0].body).toMatchObject({ workspace: "personal" });
    expect(adds[1].body).toMatchObject({ project: "Agent Quality", team_id: "team1" });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("a malformed profile stops the write with the profile's own error", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "signal-profile-"));
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, ".codecast"));
    fs.writeFileSync(path.join(repo, ".codecast", "line.toml"), `[line]\nprojet = "Agent Quality"\n`);
    process.env.CODECAST_CWD = repo;
    await expect(run("add", "--source", "person", "--kind", "bug", "--title", "x")).rejects.toThrow(/exit 1/);
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain('[line] has unknown key "projet"');
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("show posts the ref", async () => {
    answer = () => ({ signal: { short_id: "sg-2", source: "s", kind: "bug", fingerprint: "f", title: "t", observed_at: 0, created_at: Date.now(), attach: "judge", reopened: false, task_short_id: "ct-1", task_status: "open" }, cause: { signal_count: 2, fingerprints: ["f", "g"] } });
    await run("show", "sg-2");
    expect(calls).toEqual([{ path: "/cli/signal/show", body: { signal: "sg-2" } }]);
    expect(logs.join("\n")).toContain("judged the same problem");
  });

  // Improving a judge (learning-loop.md LL11).
  test("judge-defects posts the run's file with the run; diagnosis takes the graph's JSON result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-defects-"));
    const file = path.join(dir, "judge-defects.json");
    fs.writeFileSync(file, JSON.stringify([{ judge: "comms", finding: "sg-4", sentence: " The reply reports no problem. ", name: "C97 voicemail" }]));
    answer = (p) => (p === "/cli/signal/judge-defects"
      ? [{ finding: "sg-4", short_id: "sg-4", state: "waiting", waiting_on: "@quality's line is off; the diagnosis starts when it is on." }]
      : { review: { trigger: "dissolve", state: "diagnosed", answer: "misread", against: "judge", fact: "No meeting was booked." }, case_short_id: "sg-12", task_short_id: "ct-30" });
    await run("judge-defects", file, "--run", "run_1");
    await run("diagnosis", "sg-4", "--result", JSON.stringify({ answer: "Misread", fact: "No meeting was booked.", why: "" }));
    expect(calls).toEqual([
      { path: "/cli/signal/judge-defects", body: { defects: [{ finding: "sg-4", judge: "comms", sentence: "The reply reports no problem.", name: "C97 voicemail" }], run_id: "run_1" } },
      { path: "/cli/signal/diagnosis", body: { signal: "sg-4", answer: "misread", fact: "No meeting was booked." } },
    ]);
    expect(logs.join("\n")).toContain("sg-4 marked wrong; waiting: @quality's line is off");
    expect(logs.join("\n")).toContain("the judge misread what it saw; filed against the judge's prompt. Fact: No meeting was booked. → sg-12 on ct-30");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("diagnosis refuses an answer outside the three, and a result that is not JSON, before posting", async () => {
    await expect(run("diagnosis", "sg-4", "--answer", "maybe")).rejects.toThrow(/exit 1/);
    await expect(run("diagnosis", "sg-4", "--result", "$diagnose.json")).rejects.toThrow(/exit 1/);
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("The answer is one of missing, misread, upheld");
    expect(logs.join("\n")).toContain("--result is a JSON object");
  });
});
