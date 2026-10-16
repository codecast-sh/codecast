// Asking a run's decision again (`cast workflow reask`, `cast line trial rerun
// --reask`): the part this machine does before the server moves the run. The
// runner waiting on the old question is stopped here, and the run's graph is
// read as it is now, because the station that presents a decision (`asker=`
// on its gate) is the one that asks it again, in its own words.

import { apiPost, type PublishDeps } from "../castApi.js";

export interface ReaskPlan {
  /** The run row and its workflow, as the server holds them. */
  run: any;
  /** The gate the run stands at: the one it waits on, or the one it failed at. */
  gate?: string;
  /** The station that asks that gate on today's graph. */
  asker?: string;
  /** The station the graph's start leads to, where a run sent back to read its problem again begins. */
  entry?: string;
}

/**
 * Say where `runId`'s decision is asked again on the graph as it is now, and
 * stop this machine's runner on it. Throws, in words for the person and with
 * the runner left alone, when `at` names no station, or when the run stands at
 * a gate the graph no longer has and no station was named to pick it up at.
 */
export async function prepareReask(deps: PublishDeps, runId: string, ref: string, at?: string): Promise<ReaskPlan> {
  const got = await apiPost(deps, "/cli/workflow-runs/get", { run_id: runId }, { read: true, exitOnError: false }).catch(() => null);
  const { graphForDaemonRun } = await import("./daemonGraph.js");
  const { deviceId } = await import("../remote/device.js");
  const graph = got?.run ? graphForDaemonRun({ ...got.run, fresh_branch: true }, got.workflow, got.run.project_path || process.cwd(), deviceId(), true) : null;
  const gate: string | undefined = got?.run?.gate_node_id || (got?.run?.status === "failed" ? got.run.current_node_id : undefined) || undefined;
  if (at && graph && !graph.nodes.has(at)) throw new Error(`The run's graph has no station ${at}`);
  if (!at && gate && graph && !graph.nodes.has(gate)) throw new Error(`${ref} waits at ${gate}, which its graph no longer has: pick it up with --at <station>`);
  // Stopped last, so a refusal above leaves the run waiting as it was.
  await stopRunner(runId, ref);
  const start = graph ? [...graph.nodes.values()].find((n) => n.type === "start") : undefined;
  return {
    run: got?.run ?? null,
    gate,
    asker: (gate && graph?.nodes.get(gate)?.asker) || undefined,
    entry: start ? graph!.edges.find((e) => e.from === start.id)?.to : undefined,
  };
}

/** Stop this machine's runner on `runId`, if one is alive, and wait for it to exit. */
export async function stopRunner(runId: string, ref: string): Promise<void> {
  const { liveRunnerPid } = await import("./runResume.js");
  const pid = liveRunnerPid(runId);
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && liveRunnerPid(runId); i++) await new Promise((r) => setTimeout(r, 100));
  if (liveRunnerPid(runId)) throw new Error(`The runner on ${ref} (pid ${pid}) did not stop`);
}
