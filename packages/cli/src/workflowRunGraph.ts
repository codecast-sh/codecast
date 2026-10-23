// The graph a Claude Code Workflow run ran, for the server's "used in
// sessions" (convex flowLibrary): the run's script, traced once per run by
// `cast flow trace` in a child process (a script that never yields cannot
// hold the daemon), sent with the run's snapshots until the server holds it.
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

async function traceInChild(script: string): Promise<Record<string, unknown> | null> {
  const { cmd, prefixArgs } = resolveCastInvocation();
  const { stdout } = await execFileAsync(cmd, [...prefixArgs, "flow", "trace", script], { encoding: "utf-8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
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

export function workflowRunGraphs(trace: (script: string) => Promise<Record<string, unknown> | null> = traceInChild) {
  const traced = new Map<string, Promise<Record<string, unknown> | null>>();
  const held = new Set<string>();
  return {
    /** The run's graph while the server may still lack it; undefined once it holds it, or when there is none. */
    async pending(hostDir: string, runId: string): Promise<Record<string, unknown> | undefined> {
      if (held.has(runId)) return undefined;
      let p = traced.get(runId);
      if (!p) {
        p = workflowScriptFor(hostDir, runId).then((s) => (s ? trace(s) : null)).then(fitRunGraph).catch(() => null);
        traced.set(runId, p);
      }
      return (await p) ?? undefined;
    },
    /** The server took a snapshot that carried it. */
    delivered(runId: string): void {
      held.add(runId);
      traced.delete(runId);
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
