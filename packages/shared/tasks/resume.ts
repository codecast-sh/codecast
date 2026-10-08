/**
 * The block a session bound to a task gets back after compaction or a resume
 * (docs/architecture/task-graph.md TG10). The server reads it in one query
 * (convex/taskResume.ts); the SessionStart hook prints it. A new session is
 * left alone: its bound task is already in front of it.
 */

import { escapeForeignControlChars, fenceForeignText, fenceNonce, inlineForeignText, FOREIGN_TEXT_TRUNCATION_MARKER } from "../contracts/fence";
import { formatRelative } from "../time";
import { blockerLabel, failedWaitAdvice, taskRefLine, type Blocker, type TaskWait, type WaitLabelOptions } from "./graph";

/** The SessionStart sources that lose the conversation the task lived in. */
export const TASK_RESUME_SOURCES = ["compact", "resume"] as const;

export function restoresTaskContext(source: unknown): boolean {
  return (TASK_RESUME_SOURCES as readonly unknown[]).includes(source);
}

type TaskRef = { short_id: string; title: string; status: string };

export type TaskResumeContext = {
  task: TaskRef & { priority: string };
  /** Whether the asking session holds the task; absent when the server could
   *  not resolve the session. */
  held?: boolean;
  /** The task is one the session filed, not one it started: its pulse came
   *  from `cast task create`, so it never held it. */
  filed?: boolean;
  /** Why a session that started the task no longer holds it: the task closed,
   *  or another session holds it now. */
  lost?: "closed" | "claimed";
  /** The task the session touched last (filed, say), when it holds another. */
  recent?: TaskRef;
  /** What holds the task back (graph.ts `blockersHoldingBack`), each task
   *  one with its title. */
  blockers: Array<Blocker & { title?: string }>;
  /** The task's open subtasks, the first few, and how many more there are;
   *  `truncated` when the task has more children than the server read. */
  subtasks?: { items: TaskRef[]; more: number; truncated?: boolean };
  progress: { text: string; author: string; created_at: number } | null;
  /** Comments of other kinds posted after the last progress note (all of
   *  them when there is none), with the newest one's kind and author.
   *  `capped` when the server stopped reading before it found a note. */
  newer?: { count: number; capped?: boolean; latest: { type: string; author: string } } | null;
  plan: {
    short_id: string;
    title: string;
    status: string;
    /** The progress the plan keeps (plans.ts recalcProgress); absent on a plan that has none yet. */
    done?: number;
    total?: number;
    /** The step `cast task ready --plan` would hand this session first, other than the task. */
    next: { short_id: string; title: string; priority: string } | null;
  } | null;
};

/** How much of the last progress note the block carries: its head and,
 *  mostly, its tail, where a note says what is left. */
const PROGRESS_HEAD = { lines: 4, chars: 300 };
const PROGRESS_TAIL = { lines: 12, chars: 900 };
const MAX_BLOCKERS = 8;

/** A task blocker as graph.ts's `taskRefLine`, or a wait in its words, whose
 *  failure note (an answer someone wrote) stays on its line. */
function blockerLine(b: TaskResumeContext["blockers"][number], opts: WaitLabelOptions): string {
  if (b.kind === "task") {
    return taskRefLine("missing" in b ? { short_id: b.ref, missing: true } : { short_id: b.ref, title: b.title, status: b.status }, inlineForeignText);
  }
  return blockerLabel(b.note ? { ...b, note: inlineForeignText(b.note) } : b, opts);
}

/** "ct-12: Title [open]", as the SessionStart snippet lists a subtask tree. */
const taskLine = (t: TaskRef) => `${t.short_id}: ${inlineForeignText(t.title)} [${t.status}]`;

/** The note with its line breaks, cut in the middle when long. */
function progressText(raw: string): string {
  const lines = escapeForeignControlChars(raw).replace(/\n{3,}/g, "\n\n").trim().split("\n");
  const all = lines.join("\n");
  if (lines.length <= PROGRESS_HEAD.lines + PROGRESS_TAIL.lines && all.length <= PROGRESS_HEAD.chars + PROGRESS_TAIL.chars) return all;
  const head = lines.slice(0, PROGRESS_HEAD.lines).join("\n").slice(0, PROGRESS_HEAD.chars).trimEnd();
  const tail = lines.slice(-PROGRESS_TAIL.lines).join("\n").slice(-PROGRESS_TAIL.chars).trimStart();
  return `${head}\n${FOREIGN_TEXT_TRUNCATION_MARKER}\n${tail}`;
}

const RESTORED = "Restored after the conversation was compacted or resumed.";

/** The session holds the task: told so, or the server could not say (bindingLine). */
const holds = (c: TaskResumeContext) => !!c.held || (c.held === undefined && !c.filed);

/** What a session holding a task that is not ready does with it, from what
 *  holds it (after compaction, and after `cast task start`). A failed wait
 *  never clears, and an open task blocker nobody works may not either, so
 *  parking on either could wait forever. */
export function parkingLine(blockers: readonly Blocker[], id: string): string {
  const failed = blockers.filter((b): b is TaskWait => b.kind !== "task" && b.state === "failed");
  if (failed.length) return `It is not ready, and a failed wait will never clear: ${failedWaitAdvice(id, failed)}`;
  const park = "It is not ready: declare dormant naming what clears it, and end your turn; this session is woken when the last blocker clears.";
  const idle = blockers.flatMap((b) => (b.kind === "task" && "status" in b && b.status === "open" ? [b.ref] : []));
  return idle.length ? `${park} Nobody may be working ${idle.join(", ")}: check with cast task show ${idle[0]}, or take it.` : park;
}

/** The closing line's next action: progress on a held task, else other work. */
function nextAction(c: TaskResumeContext, id: string): string {
  if (holds(c)) return `Post progress with cast task comment ${id} "…" -t progress.`;
  if (c.lost === "claimed") return "Leave it to the session that holds it; cast task ready lists other work.";
  return "For other work, run cast task ready.";
}

function bindingLine(c: TaskResumeContext, task: string): string {
  if (c.held) return `You are bound to ${task}. ${RESTORED}`;
  if (c.filed) return `This session filed ${task}; it does not hold it. ${RESTORED}`;
  if (c.held === undefined) return `You are bound to ${task}. ${RESTORED}`;
  if (c.lost === "closed") return `This session was bound to ${task}, but no longer holds it: the task was closed. ${RESTORED}`;
  if (c.lost === "claimed") return `This session was bound to ${task}, but no longer holds it: another session holds it now. ${RESTORED}`;
  return `This session last worked on ${task}; it does not hold it. ${RESTORED}`;
}

/**
 * The block, at most ~40 lines. Every title is foreign text, escaped onto one
 * line; the progress note, prose a teammate or another agent wrote, is fenced.
 * The tag carries a nonce so no title can close the block early. `nonce` is
 * for tests.
 */
export function formatTaskResume(c: TaskResumeContext, opts: WaitLabelOptions & { nonce?: string } = {}): string {
  const now = opts.now ?? Date.now();
  const nonce = opts.nonce ?? fenceNonce();
  const t = c.task;
  const lines = [
    `<task-context-${nonce} source="codecast">`,
    bindingLine(c, `task ${t.short_id}: ${inlineForeignText(t.title)} [${t.status}, ${t.priority}]`),
  ];
  if (c.recent) lines.push(`This session also recently filed or touched ${taskLine(c.recent)}; it does not hold that one.`);
  if (c.blockers.length) {
    lines.push("Blocked by:");
    for (const b of c.blockers.slice(0, MAX_BLOCKERS)) lines.push(`- ${blockerLine(b, { ...opts, now })}`);
    if (c.blockers.length > MAX_BLOCKERS) lines.push(`- and ${c.blockers.length - MAX_BLOCKERS} more`);
    if (holds(c)) lines.push(parkingLine(c.blockers, t.short_id));
  }
  if (c.subtasks?.items.length) {
    lines.push("Open subtasks:");
    for (const s of c.subtasks.items) lines.push(`- ${taskLine(s)}`);
    const { more, truncated } = c.subtasks;
    if (more || truncated) lines.push(`- and ${more ? `${more}${truncated ? "+" : ""} ` : ""}more`);
  }
  if (c.progress) {
    lines.push(`Last progress (${inlineForeignText(c.progress.author)}, ${formatRelative(c.progress.created_at, now)}):`);
    lines.push(fenceForeignText(progressText(c.progress.text), `progress comment on ${t.short_id}`, { nonce }));
  } else {
    lines.push(c.newer?.capped ? `No progress comment in the last ${c.newer.count} comments.` : "No progress comment yet.");
  }
  if (c.newer?.count) {
    const { count, latest } = c.newer;
    lines.push(`${count}${c.newer.capped ? "+" : ""} ${c.progress ? "newer " : ""}comment${count === 1 ? "" : "s"} of other kinds (latest: ${inlineForeignText(latest.type)} by ${inlineForeignText(latest.author)}); cast task context ${t.short_id} shows them.`);
  }
  if (c.plan) {
    const p = c.plan;
    lines.push(`Plan ${p.short_id}: ${inlineForeignText(p.title)} [${p.status}${p.total !== undefined ? `, ${p.done ?? 0}/${p.total} done` : ""}]`);
    lines.push(p.next ? `After this task, the plan's next ready step is ${p.next.short_id} ${inlineForeignText(p.next.title)} [${p.next.priority}].` : "No other plan step is ready.");
  }
  lines.push(`Full context: cast task context ${t.short_id}. ${nextAction(c, t.short_id)}`);
  lines.push(`</task-context-${nonce}>`);
  return lines.join("\n");
}

/** What the hook prints when the read fails: the one fact it holds locally,
 *  the task in the session's pulse, and how to load the rest. */
export function formatTaskResumeUnavailable(shortId: string, planId?: string, opts: { nonce?: string } = {}): string {
  const nonce = opts.nonce ?? fenceNonce();
  const task = inlineForeignText(shortId);
  const plan = planId ? ` (plan ${inlineForeignText(planId)})` : "";
  return [
    `<task-context-${nonce} source="codecast">`,
    `This session's last task was ${task}${plan}. ${RESTORED} Its details could not be loaded: run cast task context ${task}.`,
    `</task-context-${nonce}>`,
  ].join("\n");
}
