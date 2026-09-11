// line.cast (docs/architecture/the-line.md L1) ships inside the binary and
// resolves by name. These tests parse it, check its stations and edges, and
// drive it offline through the runner's session path with a fake API so the
// analyze → implement → verify → review → exit routing on the task's verdict
// is exercised without a daemon.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseWorkflowSource, validateWorkflow } from "./parser";
import { expandScriptVars, runWorkflow } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES, resolveWorkflowSource } from "./templates";

describe("line.cast template", () => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);

  test("resolves by bare name, with .cast, and never for a path", () => {
    expect(resolveWorkflowSource("line")?.label).toBe("builtin:line");
    expect(resolveWorkflowSource("line.cast")?.source).toBe(BUILTIN_WORKFLOW_TEMPLATES.line);
    expect(resolveWorkflowSource("./nope/line.cast")).toBeNull();
    expect(resolveWorkflowSource("feature")?.label).toBe("builtin:feature");
  });

  test("parses and validates with the five stations", () => {
    expect(graph.name).toBe("line");
    expect(validateWorkflow(graph)).toEqual([]);
    expect([...graph.nodes.keys()]).toEqual(["start", "exit", "analyze", "implement", "verify", "review"]);
    expect(graph.nodes.get("analyze")?.type).toBe("agent");
    expect(graph.nodes.get("verify")?.type).toBe("command");
    expect(graph.nodes.get("verify")?.script).toContain("cast ws check");
  });

  test("hands are unattended sessions; implement is isolated with two retries; review sees only branch, title, criteria", () => {
    for (const id of ["analyze", "implement", "review"]) {
      expect(graph.nodes.get(id)?.backend).toBe("session");
      expect(graph.nodes.get(id)?.agent).toBe("claude");
    }
    const implement = graph.nodes.get("implement")!;
    expect(implement.isolated).toBe(true);
    expect(implement.max_visits).toBe(3);
    expect(implement.prompt).toContain("cast task handoff $task_id");
    const review = graph.nodes.get("review")!;
    expect(review.isolated).toBeUndefined();
    expect(review.prompt).toContain("$branch");
    expect(review.prompt).toContain("$task_title");
    expect(review.prompt).toContain("$acceptance_criteria");
    expect(review.prompt).not.toContain("$task_description");
    expect(review.prompt).toContain("cast task verdict $task_id approve|changes|reject --note -");
    expect(graph.nodes.get("analyze")?.prompt).toContain("cast task update $task_id --steps -");
  });

  test("edges route on the verdict: changes loops to implement, approve and reject exit", () => {
    const from = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => `${e.to}:${e.condition ?? ""}`);
    expect(from("verify")).toEqual(["review:outcome = success", "implement:outcome = failure"]);
    expect(from("review")).toEqual(["exit:review_verdict = approve", "implement:review_verdict = changes", "exit:review_verdict = reject"]);
  });

  test("script variables expand shell-quoted and leave $( alone", () => {
    expect(expandScriptVars("cd \"$(cast ws path $worktree)\" && echo $task_title", { worktree: "line-ct-1", task_title: "it's; rm -rf" }))
      .toBe("cd \"$(cast ws path 'line-ct-1')\" && echo 'it'\\''s; rm -rf'");
  });
});

describe("line.cast offline run through the session path", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let calls: Array<{ route: string; body: any }>;
  let task: any;
  let spawnCount: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "line-"));
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = () => {};
    calls = [];
    spawnCount = 0;
    task = { short_id: "ct-7", title: "Add the thing", status: "open", steps: [] };
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      calls.push({ route, body });
      let out: any = {};
      if (route === "/cli/work/get") out = task;
      else if (route === "/cli/spawn") { spawnCount++; out = { conversation_id: `conv_${spawnCount}`, short_id: `s${spawnCount}` }; }
      else if (route === "/cli/inbox") {
        // Each hand settles at once; its side effect on the task is what the
        // real hand would have written through the CLI.
        const id = body.session_ids[0];
        if (id === "conv_1") task = { ...task, steps: [{ title: "A works" }, { title: "B works" }] };
        if (id === "conv_2") task = { ...task, status: "in_review", execution_status: "done" };
        if (id === "conv_3") task = { ...task, status: "done", review_verdict: { verdict: "approve", at: Date.now() + 1 } };
        out = { sessions: [{ id, work_state: "done", is_live: false }] };
      }
      else if (route === "/cli/sessions/state/get") out = { status: "done", text: "" };
      else if (route === "/cli/work/update" || route === "/cli/work/comment") out = { success: true };
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("three hands run in order, implement gets the line worktree, review reads the criteria, approve exits", async () => {
    const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
    graph.nodes.get("verify")!.script = "true";
    const outcome = await runWorkflow(graph, { cwd: tmpDir, taskId: "ct-7", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
    expect(outcome).toBe("completed");
    const spawns = calls.filter((c) => c.route === "/cli/spawn").map((c) => c.body);
    expect(spawns).toHaveLength(3);
    expect(spawns[0].prompt).toContain("UNATTENDED run");
    expect(spawns[0].prompt).toContain("cast task update ct-7 --steps -");
    expect(spawns[1].isolated).toBe(true);
    expect(spawns[1].worktree_name).toBe("line-ct-7");
    expect(spawns[2].isolated).toBeUndefined();
    expect(spawns[2].prompt).toContain("Branch: codecast/line-ct-7");
    expect(spawns[2].prompt).toContain("- A works\n- B works");
    expect(spawns[2].prompt).toContain("Add the thing");
    expect(spawns.every((s) => s.agent_type === "claude_code")).toBe(true);
    // Nothing was returned to open: the run completed.
    expect(calls.some((c) => c.route === "/cli/work/update")).toBe(false);
  });

  test("a review round with no fresh verdict fails the run and returns the task to open with a comment", async () => {
    const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
    graph.nodes.get("verify")!.script = "true";
    const settle = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      const r = await settle(url, init);
      if (String(url).endsWith("/cli/inbox") && JSON.parse(init.body).session_ids[0] === "conv_3") {
        task = { ...task, review_verdict: undefined };
      }
      return r;
    }) as typeof fetch;
    const outcome = await runWorkflow(graph, { cwd: tmpDir, taskId: "ct-7", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
    expect(outcome).toBe("failed");
    const update = calls.find((c) => c.route === "/cli/work/update")?.body;
    expect(update).toMatchObject({ short_id: "ct-7", status: "open" });
    const comment = calls.find((c) => c.route === "/cli/work/comment")?.body;
    expect(comment?.comment_type).toBe("blocker");
    expect(comment?.text).toContain("no outgoing edge from review");
  });

  test("a hand that never settles is killed and the task returns to open", async () => {
    const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
    const settle = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/inbox")) {
        calls.push({ route: "/cli/inbox", body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ sessions: [{ id: "conv_1", work_state: "working", is_live: true }] }), { status: 200 });
      }
      return settle(url, init);
    }) as typeof fetch;
    const outcome = await runWorkflow(graph, { cwd: tmpDir, taskId: "ct-7", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, agentTimeout: 30 });
    expect(outcome).toBe("failed");
    expect(calls.some((c) => c.route === "/cli/sessions/kill" && c.body.session === "conv_1")).toBe(true);
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "open" });
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body.text).toContain("killed");
    expect(calls.filter((c) => c.route === "/cli/spawn")).toHaveLength(1);
  }, 30000);

  test("retries exhausted parks the task in review as blocked", async () => {
    const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
    graph.nodes.get("verify")!.script = "false";
    const outcome = await runWorkflow(graph, { cwd: tmpDir, taskId: "ct-7", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
    expect(outcome).toBe("failed");
    expect(calls.filter((c) => c.route === "/cli/spawn")).toHaveLength(4); // analyze + 3 implement visits
    expect(calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ short_id: "ct-7", status: "in_review", execution_status: "blocked" });
    expect(calls.find((c) => c.route === "/cli/work/comment")?.body.text).toContain("retries exhausted");
  }, 30000);
});
