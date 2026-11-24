// `cast flow runs <flow> --at <stations>`, kept out of flowCommand.ts to hold that file under the 800-line cap
// (packages/shared/ratchet): every running run of a flow standing at the stations named, the list a line's own queue
// reads to see the runs that wait beside it. `cast workflow runs` pages at 200, newest first, and a waiting run never
// updates its row, so Union's onefix Queue never saw the runs that had waited longest (Nov 20, 2026).
import type { Command } from "commander";
import type { FlowDeps } from "./flowCommand.js";

/** A public Convex query by its path ("workflow_runs.listRunsAtStations"), signed with this machine's token. */
export type ConvexQuery = (fn: string, args: Record<string, unknown>) => Promise<any>;

async function signedConvexQuery(fn: string, args: Record<string, unknown>): Promise<any> {
  const { convexClient } = await import("./remote/convexClient.js");
  const { client, token, api } = await convexClient({ timeoutMs: 60_000 });
  const [mod, name] = fn.split(".");
  return client.query(api[mod!][name!], { api_token: token, ...args });
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const list = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function registerFlowRunsCommand(flow: Command, deps: Pick<FlowDeps, "readWorkspace">, query: ConvexQuery = signedConvexQuery): void {
  flow
    .command("runs <flow>")
    .description("Every running run of a flow standing at the stations named, all of them, as compact rows: what a line's own queue reads to see the runs that wait beside it (cast workflow runs pages at 200, newest first)")
    .requiredOption("--at <stations>", "Stations, comma separated (queue,build)")
    .option("--results <stations>", "Also each run's last result at these stations, comma separated")
    .option("--tasks", "Also each run's task short id (one more read per run)")
    .option("--team <name>", "Team (default: the workspace this directory reads)")
    .option("--json", "Print {runs: [{_id, task_id, task_short_id?, current_node_id, runner_device, created_at, updated_at, results}], truncated}")
    .action(async (slug: string, opts: { at: string; results?: string; tasks?: boolean; team?: string; json?: boolean }) => {
      const ws = await deps.readWorkspace(opts.team);
      if (ws.kind !== "team") {
        console.error("A flow's runs are read in a team: pass --team <name>");
        process.exit(1);
      }
      const answer = await query("workflow_runs.listRunsAtStations", {
        team_id: ws.teamId, workflow_name: slug, stations: list(opts.at),
        ...(opts.results ? { results: list(opts.results) } : {}), ...(opts.tasks ? { tasks: true } : {}),
      }).catch((err: Error) => ({ error: err.message }));
      if (!answer || answer.error || !Array.isArray(answer.runs)) {
        console.error(`Could not read ${slug}'s runs: ${answer?.error ?? "no answer"}`);
        process.exit(1);
      }
      if (opts.json) { console.log(JSON.stringify(answer)); return; }
      const at = new Map<string, number>();
      for (const r of answer.runs) at.set(r.current_node_id, (at.get(r.current_node_id) ?? 0) + 1);
      console.log(`${bold(slug)}  ${list(opts.at).map((s) => `${s} ${at.get(s) ?? 0}`).join(" · ")}${answer.truncated ? dim("  (not whole: more runs stand there than one read takes)") : ""}`);
      for (const r of answer.runs) console.log(`  ${r.current_node_id.padEnd(12)} ${r.task_short_id ?? r.task_id ?? "-"}  ${dim(`${r._id} · since ${new Date(r.updated_at).toISOString().slice(0, 16).replace("T", " ")} UTC`)}`);
    });
}
