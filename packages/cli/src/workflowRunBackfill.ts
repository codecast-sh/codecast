// Graphs for Claude Code Workflow runs that finished before this machine's
// daemon could trace them (workflowRunGraph.ts): each run's completion snapshot
// here (~/.claude/projects/<project>/<session>/workflows/wf_<id>.json) inside
// the window, its script traced in a child, the graph posted on its own (convex
// flowLibrary.attachRunGraph). A run the server already holds a graph for keeps
// it. What puts a session's past workflows in the library's From sessions.
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeProjectsDir } from "./syncScope.js";
import { fitRunGraph, traceInChild, workflowScriptFor } from "./workflowRunGraph.js";

export type BackfillCounts = { runs: number; sent: number; had: number; noScript: number; failed: number };
/** What the server answers a graph with (convex flowLibrary.attachRunGraph). */
type Attached = { ok?: boolean; had?: boolean; error?: string } | null;

const dirs = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

/** Each completion snapshot under `root` written since `since`: its run id and its host session's directory. */
export function workflowSnapshots(root: string, since: number): Array<{ runId: string; hostDir: string }> {
  const out: Array<{ runId: string; hostDir: string }> = [];
  for (const project of fs.existsSync(root) ? dirs(root) : []) {
    for (const session of dirs(path.join(root, project))) {
      const hostDir = path.join(root, project, session);
      const wf = path.join(hostDir, "workflows");
      if (!fs.existsSync(wf)) continue;
      for (const f of fs.readdirSync(wf)) {
        if (!/^wf_.+\.json$/.test(f)) continue;
        const at = fs.statSync(path.join(wf, f), { throwIfNoEntry: false })?.mtimeMs ?? 0;
        if (at >= since) out.push({ runId: f.slice(0, -".json".length), hostDir });
      }
    }
  }
  return out;
}

export async function backfillRunGraphs(
  post: (body: { external_run_id: string; graph: Record<string, unknown> }) => Promise<Attached>,
  opts: { since: number; root?: string; concurrency?: number; trace?: (script: string) => Promise<Record<string, unknown> | null>; log?: (line: string) => void },
): Promise<BackfillCounts> {
  const runs = workflowSnapshots(opts.root ?? claudeProjectsDir(), opts.since);
  const trace = opts.trace ?? traceInChild;
  const counts: BackfillCounts = { runs: runs.length, sent: 0, had: 0, noScript: 0, failed: 0 };
  let next = 0;
  const one = async ({ runId, hostDir }: { runId: string; hostDir: string }) => {
    const script = await workflowScriptFor(hostDir, runId);
    if (!script) { counts.noScript++; return; }
    const graph = fitRunGraph(await trace(script).catch(() => null));
    const r: Attached = graph ? await post({ external_run_id: runId, graph }).catch((err: Error) => ({ error: err.message })) : { error: "no graph" };
    if (r?.ok) { if (r.had) counts.had++; else counts.sent++; } else counts.failed++;
    opts.log?.(`${runId} ${r?.ok ? (r.had ? "already held" : "sent") : r?.error ?? "failed"}`);
  };
  const worker = async () => { while (next < runs.length) await one(runs[next++]); };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, runs.length) }, worker));
  return counts;
}
