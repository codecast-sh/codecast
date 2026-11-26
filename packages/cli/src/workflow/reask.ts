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
  /** The station `at` named, by id, when it named one by its label. */
  at?: string;
}

/**
 * Say where `runId`'s decision is asked again on the graph as it is now, and
 * stop this machine's runner on it. Throws, in words for the person and with
 * the runner left alone, when `at` names no station, or when the run stands at
 * a gate the graph no longer has, no one gate took its name (renamedGate), and
 * no station was named to pick it up at.
 */
/** The run row as the server holds it, and the graph a runner picking it up here would read: the stations as they are now. */
export async function currentRunGraph(deps: PublishDeps, runId: string): Promise<{ got: any; graph: import("./types.js").WorkflowGraph | null }> {
  const got = await apiPost(deps, "/cli/workflow-runs/get", { run_id: runId }, { read: true, exitOnError: false }).catch(() => null);
  const { graphForDaemonRun } = await import("./daemonGraph.js");
  const { deviceId } = await import("../remote/device.js");
  return { got, graph: got?.run ? graphForDaemonRun({ ...got.run, fresh_branch: true }, got.workflow, got.run.project_path || process.cwd(), deviceId(), true) : null };
}

/**
 * The gate on `graph` that a gate it no longer has became, when its flow was
 * edited around a segment: a segment's stations are named `<node>__<station>`,
 * so renaming the node that holds the decide segment turns `decide__decide`
 * into `card__decide`. The one new gate whose last part matches is it. A gate
 * the run's own graph already had (`ran`, its stations when it started) was
 * there beside the old one, so it is another gate, never the old one renamed:
 * a deleted gate is not moved onto it. None or several is no answer, and the
 * caller asks for `--at`.
 */
export function renamedGate(graph: import("./types.js").WorkflowGraph, gone: string, ran: ReadonlySet<string>): { gate?: string; candidates: string[] } {
  const tail = gone.split("__").pop()!;
  const candidates = [...graph.nodes.values()].filter((n) => n.type === "human" && n.id.split("__").pop() === tail && !ran.has(n.id)).map((n) => n.id);
  return candidates.length === 1 ? { gate: candidates[0], candidates } : { candidates };
}

export async function prepareReask(deps: PublishDeps, runId: string, ref: string, at?: string): Promise<ReaskPlan> {
  const { got, graph } = await currentRunGraph(deps, runId);
  let gate: string | undefined = got?.run?.gate_node_id || (got?.run?.status === "failed" ? got.run.current_node_id : undefined) || undefined;
  if (at && graph) {
    const { stationOf } = await import("./resumeFailed.js");
    at = stationOf(graph, at);
  }
  // A renamed gate no station presents is asked by the run standing at it: it is its own asker, so the server
  // resumes there rather than at the old gate, and a trial keeps routing on its findings as `--at` would not.
  let asker = (gate && graph?.nodes.get(gate)?.asker) || undefined;
  if (!at && gate && graph && !graph.nodes.has(gate)) {
    // Without the stations the run started with, a rename cannot be told from a deletion: nothing is mapped.
    const ran = Array.isArray(got?.run?.graph_nodes) && got.run.graph_nodes.length ? new Set<string>(got.run.graph_nodes.map((n: { id: string }) => n.id)) : null;
    const { gate: now, candidates } = ran ? renamedGate(graph, gate, ran) : { gate: undefined, candidates: [] as string[] };
    if (!now) throw new Error(`${ref} waits at ${gate}, which its graph no longer has${candidates.length ? ` and could be any of ${candidates.join(", ")}` : ""}: pick it up with --at <station>`);
    gate = now;
    asker = graph.nodes.get(now)?.asker || now;
  }
  // Stopped last, so a refusal above leaves the run waiting as it was.
  await stopRunner(runId, ref);
  const start = graph ? [...graph.nodes.values()].find((n) => n.type === "start") : undefined;
  return {
    run: got?.run ?? null,
    ...(at ? { at } : {}),
    gate,
    asker,
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
