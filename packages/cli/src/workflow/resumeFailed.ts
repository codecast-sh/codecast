/**
 * A failed run tried again from a station of its graph, on its own branch
 * (`cast workflow resume`, `cast line trial rerun --at`): its lead fixed what
 * failed it, and the run goes on with what it made. The server resumes the
 * row; this side checks the station against the graph the run will read (as
 * it is now, which the stored workflow may predate) and, asked to, first
 * puts the branch on the default branch as the remote has it. A line's eval
 * runs the branch's own copy of the project's line code, so a fix to that
 * code reaches a run only once its branch carries it.
 */
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { evalCondition } from "./condition.js";
import { expandScriptVars } from "./runner.js";
import { lineCommandEnv } from "../lineProfile.js";
import { findCheckpointFile } from "./runDirs.js";
import type { RunCheckpoint } from "./runResume.js";
import type { WorkflowGraph } from "./types.js";

/** The station that puts a branch on the default branch: the line's rebase, whose conflicts the graph already routes. */
export const CATCH_UP_STATION = "rebase";

/** This machine's checkpoint of `runId`, wherever under the checkout's run files its graph put it; null when the run was driven elsewhere. */
export function findCheckpoint(projectPath: string, runId: string): RunCheckpoint | null {
  const file = findCheckpointFile(projectPath, runId);
  try {
    const cp = file ? JSON.parse(fs.readFileSync(file, "utf-8")) as RunCheckpoint : null;
    return cp?.run_id === runId && cp.context ? cp : null;
  } catch {
    return null;
  }
}

export type CatchUp =
  | { kind: "on_main"; why: string }
  | { kind: "conflict"; station: string; why: string }
  | { kind: "landed"; why: string }
  | { kind: "refused"; why: string };

/**
 * Put the run's branch on the default branch, by the graph's own rebase
 * script with the project's check left to the station the run resumes at.
 * A conflict goes where the graph sends the rebase's (its implement station),
 * so a hand resolves it, as on the ship path.
 */
export function catchUp(graph: WorkflowGraph, checkpoint: RunCheckpoint, projectPath: string): CatchUp {
  const station = graph.nodes.get(CATCH_UP_STATION);
  if (!station?.script) return { kind: "refused", why: `the run's graph has no ${CATCH_UP_STATION} station to put its branch on the default branch` };
  const context = { ...checkpoint.context, "line.commands.check": "" };
  const r = spawnSync("bash", ["-c", expandScriptVars(station.script, context)], {
    cwd: projectPath,
    env: { ...process.env, ...lineCommandEnv(context) },
    encoding: "utf-8",
    timeout: (station.timeout ?? 3600) * 1000,
  });
  const lines = `${r.stdout ?? ""}`.trim().split("\n");
  let said: { rebased?: boolean; landed?: boolean; why?: string } = {};
  try {
    said = JSON.parse(lines[lines.length - 1] ?? "{}");
  } catch {}
  const why = said.why ?? (`${r.stderr ?? ""}`.trim().split("\n").pop() || `exit ${r.status}`);
  if (r.status === 0) return said.landed ? { kind: "landed", why } : { kind: "on_main", why };
  if (r.status === 1) {
    const routed = { ...checkpoint.context, outcome: "failure", [`${CATCH_UP_STATION}.exit_code`]: "1" };
    const to = graph.edges.find((e) => e.from === CATCH_UP_STATION && e.condition && evalCondition(e.condition, routed))?.to;
    return to ? { kind: "conflict", station: to, why } : { kind: "refused", why: `${why}; the graph routes the rebase's conflict nowhere` };
  }
  return { kind: "refused", why };
}

/**
 * Where a failed run resumes, and what was done first: `at` checked against
 * the graph it will read, and, with `ontoMain`, its branch put on the default
 * branch (on the machine holding the run). Throws with the reason to stop.
 */
export function resumeStation(graph: WorkflowGraph | null, at: string, opts: { ontoMain?: boolean; runId: string; projectPath: string; here: boolean }): { at: string; note: string | null } {
  if (!graph) throw new Error("the run's graph could not be read here");
  if (!graph.nodes.has(at)) throw new Error(`the run's graph has no station ${at}`);
  if (!opts.ontoMain) return { at, note: null };
  if (!opts.here) throw new Error("--onto-main works in the run's worktree: run it on the machine that holds the run");
  const checkpoint = findCheckpoint(opts.projectPath, opts.runId);
  if (!checkpoint) throw new Error(`no checkpoint of run ${opts.runId} under ${opts.projectPath}: --onto-main reads the run's worktree and branch from it`);
  const caught = catchUp(graph, checkpoint, opts.projectPath);
  if (caught.kind === "on_main") return { at, note: `branch ${caught.why}` };
  if (caught.kind === "conflict") return { at: caught.station, note: `${caught.why}: resuming at ${caught.station}, where a hand resolves it` };
  if (caught.kind === "landed") throw new Error(`${caught.why}: the change is on the default branch already, so there is nothing to resume`);
  throw new Error(`the branch could not be put on the default branch: ${caught.why}`);
}
