// The graph a Claude Code Workflow run ran, for the server's "used in
// sessions" (convex flowLibrary): the run's script, traced by `cast flow trace`
// in a child process (a script that never yields cannot hold the daemon), sent
// with the run's snapshots until the server holds it. The trace costs under a
// second of CPU, but a cold `cast` on a loaded machine takes most of a minute
// to start, so a trace that fails is tried again on a later snapshot rather
// than given up (Oct 24: 2 of about 90 runs had a graph).
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCastInvocation } from "./castInvocation.js";
import { execFileAsync } from "./proc.js";

/** The run's script: `<host session>/workflows/scripts/<name>-<runId>.js`. */
export async function workflowScriptFor(hostDir: string, runId: string): Promise<string | null> {
  const dir = path.join(hostDir, "workflows", "scripts");
  const hit = (await fs.promises.readdir(dir).catch(() => [] as string[])).find((f) => f.endsWith(`-${runId}.js`));
  return hit ? path.join(dir, hit) : null;
}

/** How long one trace may run, startup included. */
export const TRACE_TIMEOUT_MS = 120_000;
/** How long after a failed trace the next snapshot tries again, by failure; past the last the run goes without. */
export const TRACE_RETRY_AFTER_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];

export async function traceInChild(script: string): Promise<Record<string, unknown> | null> {
  const { cmd, prefixArgs } = resolveCastInvocation();
  const { stdout } = await execFileAsync(cmd, [...prefixArgs, "flow", "trace", script], { encoding: "utf-8", timeout: TRACE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(String(stdout).trim().split("\n").pop() || "null");
}

/** Under Convex's 1 MiB document cap with room for the row's other fields. */
export const RUN_GRAPH_MAX_BYTES = 900_000;

/** The graph as the server can keep it: without the script when that makes it fit, nothing when even the graph is too big. */
export function fitRunGraph(graph: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!graph) return null;
  if (JSON.stringify(graph).length <= RUN_GRAPH_MAX_BYTES) return graph;
  const { script: _script, ...rest } = graph;
  return JSON.stringify(rest).length <= RUN_GRAPH_MAX_BYTES ? rest : null;
}

export function workflowRunGraphs(trace: (script: string) => Promise<Record<string, unknown> | null> = traceInChild, now: () => number = Date.now) {
  const traced = new Map<string, Promise<Record<string, unknown> | null>>();
  const failed = new Map<string, { tries: number; at: number }>();
  // Settled for good: the server holds the graph, or it is too big for a document.
  const done = new Set<string>();
  const attempt = async (hostDir: string, runId: string): Promise<Record<string, unknown> | null> => {
    const script = await workflowScriptFor(hostDir, runId);
    const raw = script ? await trace(script).catch(() => null) : null;
    if (!raw) {
      // No script yet, or the trace failed (timed out under load, or the child died): a later snapshot tries again.
      failed.set(runId, { tries: (failed.get(runId)?.tries ?? 0) + 1, at: now() });
      traced.delete(runId);
      return null;
    }
    const graph = fitRunGraph(raw);
    if (!graph) done.add(runId);
    return graph;
  };
  return {
    /** The run's graph while the server may still lack it; undefined once it holds it, while a failed trace waits to
     *  be tried again, or when there is none. */
    async pending(hostDir: string, runId: string): Promise<Record<string, unknown> | undefined> {
      if (done.has(runId)) return undefined;
      let p = traced.get(runId);
      if (!p) {
        const f = failed.get(runId);
        if (f && (f.tries > TRACE_RETRY_AFTER_MS.length || now() - f.at < TRACE_RETRY_AFTER_MS[f.tries - 1])) return undefined;
        p = attempt(hostDir, runId);
        traced.set(runId, p);
      }
      return (await p) ?? undefined;
    },
    /** The server took a snapshot that carried it. */
    delivered(runId: string): void {
      done.add(runId);
      traced.delete(runId);
      failed.delete(runId);
    },
  };
}

const graphs = workflowRunGraphs();

/**
 * One `/cli/workflow-runs/ingest` post (daemon.ts postWorkflowRunIngest),
 * carrying the run's graph until the server holds it. A backend older than
 * the graph arg rejects the whole call, so the run then posts without it.
 */
export async function postWorkflowIngest(url: string, token: string, hostDir: string, payload: { external_run_id: string } & Record<string, unknown>) {
  const post = async (body: Record<string, unknown>) => {
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: token, ...body }) });
    const respText = await resp.text().catch(() => "");
    return { resp, respText, ok: resp.ok && !respText.includes('"error"') };
  };
  const graph = await graphs.pending(hostDir, payload.external_run_id);
  let res = await post({ ...payload, ...(graph ? { graph } : {}) });
  if (!res.ok && graph) res = await post(payload);
  if (res.ok && graph) graphs.delivered(payload.external_run_id);
  return res;
}
