// `cast signal` (the-line-end-to-end.md LE3): the argument rules and what each
// verb posts. The transport is faked at globalThis.fetch, never the module, so
// the real command shapes the request.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatSignalList, signalAddBody, type SignalRow } from "./signalCommand.js";

describe("signalAddBody", () => {
  test("the four typed fields are required and named when missing", () => {
    expect(() => signalAddBody({ source: "sentry", kind: "bug" })).toThrow("--fingerprint, --title");
    expect(() => signalAddBody({})).toThrow("--source, --kind, --fingerprint, --title");
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
    expect(logs.join("\n")).toContain("--kind, --fingerprint, --title");
  });

  test("ls --task reads one cause's signals; ls --source reads the workspace", async () => {
    answer = () => ({ signals: [] });
    await run("ls", "--task", "ct-7");
    await run("ls", "--source", "evals", "--json");
    expect(calls[0]).toEqual({ path: "/cli/signal/ls", body: { task: "ct-7" } });
    expect(calls[1]).toEqual({ path: "/cli/signal/ls", body: { source: "evals", project_path: "/repo", conversation_id: "s1" } });
  });

  test("show posts the ref", async () => {
    answer = () => ({ signal: { short_id: "sg-2", source: "s", kind: "bug", fingerprint: "f", title: "t", observed_at: 0, created_at: Date.now(), attach: "judge", reopened: false, task_short_id: "ct-1", task_status: "open" }, cause: { signal_count: 2, fingerprints: ["f", "g"] } });
    await run("show", "sg-2");
    expect(calls).toEqual([{ path: "/cli/signal/show", body: { signal: "sg-2" } }]);
    expect(logs.join("\n")).toContain("judged the same problem");
  });
});
