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
const MARKER = /^\s*(?:[-*]|(\d+)[.)])\s+/;

/** One step line without its list marker, and whether the marker was a number. */
export type StepLine = { text: string; numbered: boolean };

/**
 * Steps as a person writes them, one per line. A blank line starts a new
 * wave: steps in a wave are independent, and each waits on every step of the
 * wave before it.
 */
export function parseStepLines(text: string): StepLine[][] {
  const waves: StepLine[][] = [];
  let wave: StepLine[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.replace(MARKER, "").trim();
    if (line) wave.push({ text: line, numbered: !!MARKER.exec(raw)?.[1] });
    else if (wave.length) {
      waves.push(wave);
      wave = [];
    }
  }
  if (wave.length) waves.push(wave);
  return waves;
}

/**
 * Numbered steps on consecutive lines are one wave, so they run in parallel,
 * yet numbering is how a person writes an order. A wave whose lines are all
 * numbered is refused rather than guessed, with how to say either.
 */
export function numberedWaveError(waves: readonly (readonly StepLine[])[]): string | null {
  const wave = waves.find((w) => w.length > 1 && w.every((l) => l.numbered));
  if (!wave) return null;
  return `Numbered steps on consecutive lines run in parallel ("${wave[0].text}", "${wave[1].text}"). Put a blank line between steps that need the one before, or drop the numbers if they really are parallel.`;
}

/** "Title :: what done means" splits into the step's title and description;
 *  a trailing "Title ::" is a title with no description. */
function stepFromLine(line: string): Pick<PlanStep, "title" | "description"> {
  const sep = /\s::(?:\s|$)/.exec(line);
  if (!sep) return { title: line };
  const title = line.slice(0, sep.index).trim();
  const description = line.slice(sep.index + sep[0].length).trim();
  return description ? { title, description } : { title };
}

/** Waves as steps: every step of a wave is after every step of the one
 *  before. A line may carry its description after " :: ". */
export function stepsFromWaves(waves: readonly (readonly string[])[]): PlanStep[] {
  const steps: PlanStep[] = [];
  let previous: number[] = [];
  for (const wave of waves) {
    // A copy per step: the steps are handed out, and a caller editing one
    // step's `after` must not rewrite its siblings'.
    const current = wave.map((line) => steps.push({ ...stepFromLine(line), after: [...previous] }) - 1);
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
 * its blockers by earlier index), each with the indices it waits on. A task
 * `skip` leaves out (a dropped step) passes its blockers to the tasks that
 * needed it, so A → B (dropped) → C keeps C after A. Edges to tasks outside
 * the list are dropped; tasks on a loop come last with the edges among them
 * dropped, so a template never holds a cycle.
 */
export function templateSteps<T extends DepNode>(tasks: readonly T[], skip: (t: T) => boolean = () => false): Array<{ task: T; blocked_by_indices: number[] }> {
  const byRef = new Map<string, T>();
  for (const t of tasks) {
    byRef.set(t.short_id, t);
    if (t._id) byRef.set(String(t._id), t);
  }
  const through = (refs: readonly string[] | null | undefined, seen: Set<T>): string[] =>
    (refs ?? []).flatMap((ref) => {
      const t = byRef.get(ref);
      if (!t || !skip(t)) return [ref];
      if (seen.has(t)) return [];
      seen.add(t);
      return through(t.blocked_by, seen);
    });
  const nodes = tasks.filter((t) => !skip(t)).map((task) => ({ short_id: task.short_id, _id: task._id, blocked_by: through(task.blocked_by, new Set()), task }));
  const { layers, cyclic } = topoLayers(nodes);
  const ordered = [...layers.flat(), ...cyclic];
  const index = new Map<string, number>();
  ordered.forEach((n, i) => {
    index.set(n.short_id, i);
    if (n._id) index.set(String(n._id), i);
  });
  return ordered.map((n, i) => ({
    task: n.task,
    blocked_by_indices: [...new Set(n.blocked_by.map((ref) => index.get(ref)))].filter((j): j is number => j !== undefined && j < i),
  }));
}
