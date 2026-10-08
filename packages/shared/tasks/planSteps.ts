/**
 * Plans that write their own order (docs/architecture/task-graph.md TG6).
 * `cast plan create --steps -` and `cast plan steps <plan> -` read waves, a
 * saved template carries edges as indices; both become one list of steps
 * whose `after` names earlier steps by index, which the CLI creates in order.
 */

import { topoLayers, type DepNode } from "./graph";
import { isTerminalTaskStatus } from "./statuses";

/** One step to create. `after` holds indices of earlier steps it waits on. */
export type PlanStep = {
  title: string;
  after: number[];
  description?: string;
  task_type?: string;
  priority?: string;
  labels?: string[];
  estimated_minutes?: number;
};

/** A list marker an agent may type in front of a step: "- ", "* ", "1. ", "2) ". */
const MARKER = /^\s*(?:[-*]|\d+[.)])\s+/;

/**
 * Steps as a person writes them, one per line. A blank line starts a new
 * wave: steps in a wave are independent, and each waits on every step of the
 * wave before it.
 */
export function parseStepWaves(text: string): string[][] {
  const waves: string[][] = [];
  let wave: string[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.replace(MARKER, "").trim();
    if (line) wave.push(line);
    else if (wave.length) {
      waves.push(wave);
      wave = [];
    }
  }
  if (wave.length) waves.push(wave);
  return waves;
}

/** Waves as steps: every step of a wave is after every step of the one before. */
export function stepsFromWaves(waves: readonly (readonly string[])[]): PlanStep[] {
  const steps: PlanStep[] = [];
  let previous: number[] = [];
  for (const wave of waves) {
    const current = wave.map((title) => steps.push({ title, after: previous }) - 1);
    previous = current;
  }
  return steps;
}

/**
 * The plan's current last wave, which appended steps wait on: its open tasks
 * that no other open task of the plan waits on. Done and dropped tasks hold
 * nothing back, and backlog is parked, so neither is waited on.
 */
export function planTail<T extends DepNode & { status?: string | null }>(tasks: readonly T[]): T[] {
  const live = tasks.filter((t) => !isTerminalTaskStatus(t.status) && t.status !== "backlog");
  const needed = new Set(live.flatMap((t) => t.blocked_by ?? []));
  return live.filter((t) => !needed.has(t.short_id) && !(t._id && needed.has(String(t._id))));
}

/**
 * A plan's tasks in an order where every edge points back (a template names
 * its blockers by earlier index), each with the indices it waits on. Edges to
 * tasks outside the list are dropped; tasks on a loop come last with the
 * edges among them dropped, so a template never holds a cycle.
 */
export function templateSteps<T extends DepNode>(tasks: readonly T[]): Array<{ task: T; blocked_by_indices: number[] }> {
  const { layers, cyclic } = topoLayers(tasks);
  const ordered = [...layers.flat(), ...cyclic];
  const index = new Map<string, number>();
  ordered.forEach((t, i) => {
    index.set(t.short_id, i);
    if (t._id) index.set(String(t._id), i);
  });
  return ordered.map((task, i) => ({
    task,
    blocked_by_indices: [...new Set((task.blocked_by ?? []).map((ref) => index.get(ref)))].filter((j): j is number => j !== undefined && j < i),
  }));
}
