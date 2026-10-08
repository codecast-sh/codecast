/**
 * The block a session bound to a task gets back after compaction or a resume
 * (docs/architecture/task-graph.md TG10). The server reads it in one query
 * (convex/taskResume.ts); the SessionStart hook prints it. A new session is
 * left alone: its bound task is already in front of it.
 */

import { escapeForeignControlChars, fenceForeignText, fenceNonce, inlineForeignText, FOREIGN_TEXT_TRUNCATION_MARKER } from "../contracts/fence";
import { blockerLabel, blockerStateLabel, type Blocker, type WaitLabelOptions } from "./graph";

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
  /** Why a session that does not hold the task lost it: the task closed, or
   *  another session holds it now. Absent when it never held it (a task it
   *  only filed). */
  lost?: "closed" | "claimed";
  /** The task the session touched last (filed, say), when it holds another. */
  recent?: TaskRef;
  /** The open blockers (graph.ts `blockersOf`), each task one with its title. */
  blockers: Array<Blocker & { title?: string }>;
  /** The task's open subtasks, the first few, and how many more there are. */
  subtasks?: { items: TaskRef[]; more: number };
  progress: { text: string; author: string; created_at: number } | null;
  /** Comments of other kinds posted after the last progress note (all of
   *  them when there is none), with the newest one's kind and author. */
  newer?: { count: number; latest: { type: string; author: string } } | null;
  plan: {
    short_id: string;
    title: string;
    status: string;
    done: number;
    total: number;
    /** The step `cast task ready --plan` would hand this session first, other than the task. */
    next: { short_id: string; title: string; priority: string } | null;
  } | null;
};

/** How much of the last progress note the block carries: its head and,
 *  mostly, its tail, where a note says what is left. */
const PROGRESS_HEAD = { lines: 4, chars: 300 };
const PROGRESS_TAIL = { lines: 12, chars: 900 };
const MAX_BLOCKERS = 8;

/** "ct-12 Design schema [in_progress]" ("ct-12 [open]" when the caller may
 *  not read its title), or graph.ts's words for an unknown task and a wait,
 *  whose failure note (an answer someone wrote) stays on its line. */
function blockerLine(b: TaskResumeContext["blockers"][number], opts: WaitLabelOptions): string {
  if (b.kind === "task" && !blockerStateLabel(b) && "status" in b) {
    return `${b.ref}${b.title !== undefined ? ` ${inlineForeignText(b.title)}` : ""} [${b.status}]`;
  }
  return blockerLabel(b.kind !== "task" && b.note ? { ...b, note: inlineForeignText(b.note) } : b, opts);
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

function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const RESTORED = "Restored after the conversation was compacted or resumed.";

function bindingLine(c: TaskResumeContext, task: string): string {
  if (c.held !== false) return `You are bound to ${task}. ${RESTORED}`;
  if (c.lost === "closed") return `This session was bound to ${task}, but no longer holds it: the task was closed. ${RESTORED}`;
  if (c.lost === "claimed") return `This session was bound to ${task}, but no longer holds it: another session holds it now. ${RESTORED}`;
  return `This session's last task was ${task}; it does not hold it. ${RESTORED}`;
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
  }
  if (c.subtasks?.items.length) {
    lines.push("Open subtasks:");
    for (const s of c.subtasks.items) lines.push(`- ${taskLine(s)}`);
    if (c.subtasks.more) lines.push(`- and ${c.subtasks.more} more`);
  }
  if (c.progress) {
    lines.push(`Last progress (${inlineForeignText(c.progress.author)}, ${ago(c.progress.created_at, now)}):`);
    lines.push(fenceForeignText(progressText(c.progress.text), `progress comment on ${t.short_id}`, { nonce }));
  } else {
    lines.push("No progress comment yet.");
  }
  if (c.newer?.count) {
    const { count, latest } = c.newer;
    lines.push(`${count} ${c.progress ? "newer " : ""}comment${count === 1 ? "" : "s"} of other kinds (latest: ${inlineForeignText(latest.type)} by ${inlineForeignText(latest.author)}); cast task context ${t.short_id} shows them.`);
  }
  if (c.plan) {
    const p = c.plan;
    lines.push(`Plan ${p.short_id}: ${inlineForeignText(p.title)} [${p.status}, ${p.done}/${p.total} done]`);
    lines.push(p.next ? `After this task, the plan's next ready step is ${p.next.short_id} ${inlineForeignText(p.next.title)} [${p.next.priority}].` : "No other plan step is ready.");
  }
  lines.push(`Full context: cast task context ${t.short_id}. Post progress with cast task comment ${t.short_id} "…" -t progress.`);
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
