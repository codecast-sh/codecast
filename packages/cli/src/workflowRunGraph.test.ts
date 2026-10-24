import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fitRunGraph, RUN_GRAPH_MAX_BYTES, TRACE_RETRY_AFTER_MS, workflowRunGraphs, workflowScriptFor } from "./workflowRunGraph";

let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test("traces a run's script once, and stops sending it once the server holds it", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfgraph-"));
  fs.mkdirSync(path.join(dir, "workflows", "scripts"), { recursive: true });
  const script = path.join(dir, "workflows", "scripts", "ship-it-wf_abc.js");
  fs.writeFileSync(script, "export const meta = { name: 'ship-it' }");
  expect(await workflowScriptFor(dir, "wf_abc")).toBe(script);
  expect(await workflowScriptFor(dir, "wf_none")).toBe(null);
  let traces = 0;
  const graphs = workflowRunGraphs(async (s) => { traces++; return { hash: "h", file: s }; });
  expect(await graphs.pending(dir, "wf_abc")).toEqual({ hash: "h", file: script });
  expect(await graphs.pending(dir, "wf_abc")).toEqual({ hash: "h", file: script });
  expect(traces).toBe(1);
  graphs.delivered("wf_abc");
  expect(await graphs.pending(dir, "wf_abc")).toBeUndefined();
  expect(await graphs.pending(dir, "wf_none")).toBeUndefined();
});

test("a graph too big for one document goes without its script, or not at all", () => {
  const big = "x".repeat(RUN_GRAPH_MAX_BYTES);
  expect(fitRunGraph({ hash: "h", script: "s" })).toEqual({ hash: "h", script: "s" });
  expect(fitRunGraph({ hash: "h", script: big })).toEqual({ hash: "h" });
  expect(fitRunGraph({ hash: "h", source: big })).toBe(null);
});

test("an ingest carries the graph once; a backend that refuses the arg still gets the run", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfgraph-"));
  fs.mkdirSync(path.join(dir, "workflows", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "workflows", "scripts", "x-wf_old.js"), "export const meta = { name: 'x' }\nawait agent('do it', { label: 'do' })");
  const bodies: any[] = [];
  let refuseGraph = true;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json();
    bodies.push(body);
    return new Response(JSON.stringify(body.graph && refuseGraph ? { error: "extra field graph" } : { ok: true }));
  } });
  try {
    const { postWorkflowIngest } = await import("./workflowRunGraph");
    const url = `http://localhost:${server.port}/cli/workflow-runs/ingest`;
    const first = await postWorkflowIngest(url, "t", dir, { external_run_id: "wf_old", status: "running" });
    expect(first.ok).toBe(true);
    expect(bodies.map((b) => !!b.graph)).toEqual([true, false]);
    expect(bodies[0].graph.hash).toBeTruthy();
    // Delivered (the backend took the run): the graph is not sent again.
    await postWorkflowIngest(url, "t", dir, { external_run_id: "wf_old", status: "completed" });
    expect(bodies.map((b) => !!b.graph)).toEqual([true, false, false]);
  } finally {
    server.stop(true);
  }
}, 60_000);

test("a failed trace is tried again on a later snapshot, with backoff, then given up", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfgraph-"));
  fs.mkdirSync(path.join(dir, "workflows", "scripts"), { recursive: true });
  const script = path.join(dir, "workflows", "scripts", "slow-wf_slow.js");
  fs.writeFileSync(script, "export const meta = { name: 'slow' }");
  let t = 0;
  let traces = 0;
  let works = false;
  const graphs = workflowRunGraphs(async () => { traces++; if (!works) throw new Error("timed out"); return { hash: "h" }; }, () => t);
  expect(await graphs.pending(dir, "wf_slow")).toBeUndefined();
  expect(traces).toBe(1);
  // Inside the first backoff the next snapshot does not trace again.
  t += TRACE_RETRY_AFTER_MS[0] - 1;
  expect(await graphs.pending(dir, "wf_slow")).toBeUndefined();
  expect(traces).toBe(1);
  // Past it, it does, and a trace that works is the graph.
  t += 2;
  works = true;
  expect(await graphs.pending(dir, "wf_slow")).toEqual({ hash: "h" });
  expect(traces).toBe(2);
  // A run whose traces keep failing goes without once every retry is spent.
  works = false;
  const g2 = workflowRunGraphs(async () => { traces++; return null; }, () => t);
  const before = traces;
  for (const wait of [0, ...TRACE_RETRY_AFTER_MS, 60 * 60_000]) { t += wait; await g2.pending(dir, "wf_slow"); }
  expect(traces - before).toBe(TRACE_RETRY_AFTER_MS.length + 1);
});
