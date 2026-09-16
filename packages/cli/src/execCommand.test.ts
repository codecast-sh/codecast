import { describe, expect, test } from "bun:test";
import { parseExecTimeout, parseOutputFormat, resolveExecPrompt, resolveExecPrompts } from "./execCommand.js";

describe("resolveExecPrompt", () => {
  test("joins positional words into one prompt", () => {
    expect(resolveExecPrompt(["summarize", "this", "repo"], { stdinIsTTY: true, readStdin: () => "" }))
      .toEqual({ prompt: "summarize this repo", inheritStdin: false });
  });

  test("'-' reads stdin as the prompt and does not inherit it", () => {
    expect(resolveExecPrompt(["-"], { stdinIsTTY: false, readStdin: () => "from stdin\n" }))
      .toEqual({ prompt: "from stdin", inheritStdin: false });
  });

  test("a prompt with piped stdin inherits stdin for the child", () => {
    expect(resolveExecPrompt(["summarize"], { stdinIsTTY: false, readStdin: () => "FILE" }))
      .toEqual({ prompt: "summarize", inheritStdin: true });
  });

  test("no prompt and piped stdin uses stdin as the prompt", () => {
    expect(resolveExecPrompt([], { stdinIsTTY: false, readStdin: () => "hello\n" }))
      .toEqual({ prompt: "hello", inheritStdin: false });
  });

  test("no prompt on a tty is empty", () => {
    expect(resolveExecPrompt([], { stdinIsTTY: true, readStdin: () => "should not read" }))
      .toEqual({ prompt: "", inheritStdin: false });
  });
});

describe("parseExecTimeout", () => {
  test("accepts seconds, minutes, hours, and a bare number of seconds", () => {
    expect(parseExecTimeout("30s")).toBe(30_000);
    expect(parseExecTimeout("2m")).toBe(120_000);
    expect(parseExecTimeout("1h")).toBe(3_600_000);
    expect(parseExecTimeout("45")).toBe(45_000);
  });

  test("rejects junk", () => {
    expect(parseExecTimeout("soon")).toBeUndefined();
    expect(parseExecTimeout("")).toBeUndefined();
  });
});

describe("parseOutputFormat", () => {
  test("accepts the three unified formats", () => {
    expect(parseOutputFormat("text")).toBe("text");
    expect(parseOutputFormat("JSON")).toBe("json");
    expect(parseOutputFormat("stream-json")).toBe("stream-json");
  });

  test("rejects unknown values", () => {
    expect(parseOutputFormat("yaml")).toBeUndefined();
    expect(parseOutputFormat(undefined)).toBeUndefined();
  });
});

describe("resolveExecPrompts (parallel mode)", () => {
  test("every positional is its own prompt", () => {
    expect(resolveExecPrompts(["a", "b c", " "], { stdinIsTTY: true, readStdin: () => "" })).toEqual(["a", "b c"]);
  });
  test("several '-' arguments split stdin on --- lines", () => {
    expect(resolveExecPrompts(["-", "-"], { stdinIsTTY: false, readStdin: () => "first\n---\nsecond\n" })).toEqual(["first", "second"]);
  });
  test("no arguments with piped stdin splits the whole body on --- lines", () => {
    expect(resolveExecPrompts([], { stdinIsTTY: false, readStdin: () => "one\n---\ntwo\n" })).toEqual(["one", "two"]);
  });
});

// ─── the-line.md L7: a chain is a run ───────────────────────────────────────
//
// `globalThis.fetch` is faked so the real `apiPost` shapes every request
// (mock.module is banned here, see mockModule.guard.test.ts). The step
// command is started through the `launch` seam, so no agent needs to be on
// PATH; the resolved argv still goes through the real `resolveLaunch`.

import { afterEach, beforeEach } from "bun:test";
import { runChain } from "./execCommand.js";

const SITE = "https://x.test";
const realFetch = globalThis.fetch;
const realStderrWrite = process.stderr.write;
const realStdoutWrite = process.stdout.write;
const realLog = console.log;

const deps = {
  getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }),
  detectCurrentSessionId: () => "sess-me",
  resolveProjectId: async (ref: string) => ref,
} as any;

const chainResolve = {
  chain: {
    name: "implement",
    description: "Plan then code",
    steps: [
      { agent: "planner", prompt: "Plan: {task}" },
      { agent: "coder", prompt: "Do: {previous}" },
    ],
  },
  definitions: {
    planner: { name: "planner", description: "" },
    coder: { name: "coder", description: "" },
  },
};

let calls: Array<{ path: string; body: any }> = [];
let stderr: string[] = [];
let stdout: string[] = [];
let failHttp = false;

beforeEach(() => {
  calls = [];
  stderr = [];
  stdout = [];
  failHttp = false;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    const path = String(url).slice(SITE.length);
    const { api_token: _token, device_id: _device, ...body } = JSON.parse(String(init.body));
    if (path === "/cli/chains/resolve") return new Response(JSON.stringify(chainResolve), { status: 200 });
    if (failHttp) throw new Error("ECONNREFUSED");
    calls.push({ path, body });
    if (path === "/cli/workflows/upsert") return new Response(JSON.stringify({ id: "wf-1" }), { status: 200 });
    if (path === "/cli/workflow-runs/create") return new Response(JSON.stringify({ run_id: "run-1" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  process.stderr.write = ((chunk: any) => { stderr.push(String(chunk)); return true; }) as any;
  process.stdout.write = ((chunk: any) => { stdout.push(String(chunk)); return true; }) as any;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.stderr.write = realStderrWrite;
  process.stdout.write = realStdoutWrite;
  console.log = realLog;
});

const launched: Array<{ binary: string; args: string[] }> = [];
const fakeLaunch = (outputs: Array<{ code: number; output: string }>) => async (binary: string, args: string[]) => {
  launched.push({ binary, args });
  return outputs[launched.length - 1];
};

describe("runChain records the chain as a run (the-line.md L7)", () => {
  test("posts upsert, create, then running and completed per step, then the terminal status", async () => {
    launched.length = 0;
    const code = await runChain(deps, "implement", "ship it", {
      flags: {}, dir: "/tmp/proj", quiet: true, taskId: "ct-7",
      launch: fakeLaunch([{ code: 0, output: "the plan\n" }, { code: 0, output: "x".repeat(900) }]),
    });
    expect(code).toBe(0);
    expect(launched).toHaveLength(2);
    expect(calls.map((c) => c.path)).toEqual([
      "/cli/workflows/upsert",
      "/cli/workflow-runs/create",
      "/cli/workflow-runs/progress",
      "/cli/workflow-runs/progress",
      "/cli/workflow-runs/progress",
      "/cli/workflow-runs/progress",
      "/cli/workflow-runs/progress",
      "/cli/workflow-runs/progress",
    ]);
    const upsert = calls[0].body;
    expect(upsert.name).toBe("chain-implement");
    expect(upsert.slug).toBe("chain-implement");
    expect(upsert.nodes.map((n: any) => n.id)).toEqual(["start", "step-1", "step-2", "exit"]);
    expect(upsert.nodes[1]).toMatchObject({ type: "agent", shape: "box", definition: "planner", prompt: "Plan: {task}" });
    expect(calls[1].body).toEqual({
      workflow_name: "chain-implement",
      workflow_goal: "Plan then code",
      workflow_id: "wf-1",
      task_id: "ct-7",
      project_path: "/tmp/proj",
      spawner_session: "sess-me",
    });
    const progress = calls.slice(2).map((c) => c.body);
    // The run is created pending; the start node post flips it to running (mirrors runner.ts).
    expect(progress[0]).toEqual({ run_id: "run-1", current_node_id: "start", node_id: "start", node_status: "running", run_status: "running" });
    expect(progress[1]).toEqual({ run_id: "run-1", current_node_id: "step-1", node_id: "step-1", node_status: "running" });
    expect(progress[2]).toEqual({ run_id: "run-1", current_node_id: "step-1", node_id: "step-1", node_status: "completed", outcome: "success", result_preview: "the plan" });
    expect(progress[3]).toMatchObject({ node_id: "step-2", node_status: "running" });
    expect(progress[4]).toMatchObject({ node_id: "step-2", node_status: "completed", outcome: "success" });
    expect(progress[4].result_preview).toHaveLength(800);
    expect(progress[5]).toEqual({ run_id: "run-1", current_node_id: "exit", node_id: "exit", node_status: "completed", run_status: "completed" });
    // stdout is unchanged: the last step's output.
    expect(stdout.join("")).toBe("x".repeat(900) + "\n");
  });

  test("a failed step fails its node and the run, and the chain's exit code is the step's", async () => {
    launched.length = 0;
    const code = await runChain(deps, "implement", "ship it", {
      flags: { outputFormat: "json" }, dir: "/tmp/proj", quiet: true, planId: "pl-3",
      launch: fakeLaunch([{ code: 2, output: "boom" }]),
    });
    expect(code).toBe(2);
    expect(launched).toHaveLength(1);
    expect(calls[1].body).toMatchObject({ plan_id: "pl-3" });
    expect(calls[1].body.task_id).toBeUndefined();
    const progress = calls.slice(2).map((c) => c.body);
    expect(progress).toEqual([
      { run_id: "run-1", current_node_id: "start", node_id: "start", node_status: "running", run_status: "running" },
      { run_id: "run-1", current_node_id: "step-1", node_id: "step-1", node_status: "running" },
      { run_id: "run-1", current_node_id: "step-1", node_id: "step-1", node_status: "failed", outcome: "failure", result_preview: "boom", fail_reason: "planner exited 2" },
      { run_id: "run-1", current_node_id: "step-1", node_id: "step-1", node_status: "failed", run_status: "failed", fail_reason: "planner exited 2" },
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ chain: "implement", ok: false });
  });

  test("an http failure does not stop the chain and prints one note", async () => {
    launched.length = 0;
    failHttp = true;
    const code = await runChain(deps, "implement", "ship it", {
      flags: {}, dir: "/tmp/proj",
      launch: fakeLaunch([{ code: 0, output: "one" }, { code: 0, output: "two" }]),
    });
    expect(code).toBe(0);
    expect(launched).toHaveLength(2);
    expect(calls).toEqual([]);
    expect(stdout.join("")).toBe("two\n");
    const notes = stderr.filter((l) => l.includes("run not recorded"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("ECONNREFUSED");
  });

  test("a dry run records nothing", async () => {
    launched.length = 0;
    const code = await runChain(deps, "implement", "ship it", { flags: {}, dir: "/tmp/proj", quiet: true, dryRun: true, launch: fakeLaunch([]) });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(launched).toHaveLength(0);
  });
});
