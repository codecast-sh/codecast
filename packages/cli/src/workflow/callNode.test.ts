// The call node (learning-loop.md LL1): one prompt, one answer, no tools, no
// session, through the server's one call path.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseWorkflowSource, validateWorkflow } from "./parser";
import { callNodeBody, runWorkflow } from "./runner";

const GRAPH = `digraph g {
  goal="Grade the reply"
  start [shape=Mdiamond]
  grade [shape=note, model="claude-haiku-5-5", max_tokens=200, system="You grade replies.", prompt="Grade this reply from $who."]
  pass  [shape=parallelogram, script="echo verdict=$grade.json.verdict cost=$grade.cost_usd"]
  fail  [shape=parallelogram, script="echo call-failed"]
  done  [shape=Msquare]
  start -> grade
  grade -> pass [condition="outcome = success"]
  grade -> fail [condition="outcome = failure"]
  pass -> done
  fail -> done
}`;

describe("parsing a call node", () => {
  test("shape=note is a call with its own cap, system prompt and output", () => {
    const g = parseWorkflowSource(GRAPH);
    const node = g.nodes.get("grade")!;
    expect(node.type).toBe("call");
    expect(node.max_tokens).toBe(200);
    expect(node.system).toBe("You grade replies.");
    expect(validateWorkflow(g)).toEqual([]);
  });

  test("a call without a prompt is refused", () => {
    const g = parseWorkflowSource(`digraph g { start [shape=Mdiamond] c [shape=note] done [shape=Msquare] start -> c -> done }`);
    expect(validateWorkflow(g)).toContain("Call node 'c' has no prompt attribute");
  });

  test("the body is the node's words with $vars expanded and nothing appended", () => {
    const g = parseWorkflowSource(GRAPH);
    const body = callNodeBody(g.nodes.get("grade")!, g, { who: "Dana", task_title: "not appended" }, "/repo");
    expect(body).toEqual({ model: "claude-haiku-5-5", max_tokens: 200, system: "You grade replies.", prompt: "Grade this reply from Dana.", output: "json", label: "grade", project_path: "/repo" });
  });
});

describe("running a call node", () => {
  let server: ReturnType<typeof Bun.serve>;
  let answer: Record<string, unknown>;
  const seen: any[] = [];
  let tmpDir: string;
  let logs: string[];
  const original = console.log;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.json();
        if (url.pathname === "/cli/model/call") {
          seen.push(body);
          return Response.json(answer);
        }
        return Response.json({});
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-node-"));
    logs = [];
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  });
  afterEach(() => {
    console.log = original;
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("its parsed answer and cost reach the next node", async () => {
    answer = { ok: true, text: '{"verdict": "pass"}', json: { verdict: "pass" }, usage: { input_tokens: 40, output_tokens: 6 }, cost_usd: 0.0002, model: "claude-haiku-5-5" };
    const g = parseWorkflowSource(GRAPH);
    const outcome = await runWorkflow(g, { cwd: tmpDir, convexSiteUrl: server.url.origin, apiToken: "tok" });
    expect(outcome).toBe("completed");
    expect(seen.at(-1)).toMatchObject({ api_token: "tok", prompt: "Grade this reply from .", output: "json", max_tokens: 200 });
    expect(logs.some((l) => l.includes("verdict=pass cost=0.0002"))).toBe(true);
  });

  test("a call the budget refuses fails the node with the server's words", async () => {
    answer = { ok: false, reason: "budget", error: "the team's model budget for this month has no room", cost_usd: 0, model: "claude-haiku-5-5" };
    const outcome = await runWorkflow(parseWorkflowSource(GRAPH), { cwd: tmpDir, convexSiteUrl: server.url.origin, apiToken: "tok" });
    expect(outcome).toBe("completed");
    expect(logs.some((l) => l.includes("call-failed"))).toBe(true);
    expect(logs.some((l) => l.includes("no room"))).toBe(true);
  });
});
