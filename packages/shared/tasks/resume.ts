/**
 * The block a session bound to a task gets back after compaction or a resume
 * (docs/architecture/task-graph.md TG10). The server reads it in one query
 * (convex/taskResume.ts); the SessionStart hook prints it. A new session is
 * left alone: its bound task is already in front of it.
 */

import { escapeForeignControlChars, capForeignText, fenceForeignText, fenceNonce, inlineForeignText } from "../contracts/fence";
import { blockerLabel, blockerStateLabel, type Blocker, type WaitLabelOptions } from "./graph";

/** The SessionStart sources that lose the conversation the task lived in. */
export const TASK_RESUME_SOURCES = ["compact", "resume"] as const;

export function restoresTaskContext(source: unknown): boolean {
  return (TASK_RESUME_SOURCES as readonly unknown[]).includes(source);
}

export type TaskResumeContext = {
  task: { short_id: string; title: string; status: string; priority: string };
  /** Whether the asking session still holds the task; absent when the server
   *  could not resolve the session (or predates the field). */
  held?: boolean;
  /** The open blockers (graph.ts `blockersOf`), each task one with its title. */
  blockers: Array<Blocker & { title?: string }>;
  progress: { text: string; author: string; created_at: number } | null;
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

/** How much of the last progress note the block carries, folded to one line. */
const PROGRESS_CHARS = 600;
const MAX_BLOCKERS = 8;

/** "ct-12 Design schema [in_progress]" ("ct-12 [open]" when the caller may
 *  not read its title), or graph.ts's words for an unknown task and a wait. */
function blockerLine(b: TaskResumeContext["blockers"][number], opts: WaitLabelOptions): string {
  if (b.kind === "task" && !blockerStateLabel(b) && "status" in b) {
    return `${b.ref}${b.title !== undefined ? ` ${inlineForeignText(b.title)}` : ""} [${b.status}]`;
  }
  return blockerLabel(b, opts);
}

function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * The block, at most ~20 lines. Every title is foreign text, escaped onto one
 * line; the progress note, prose a teammate or another agent wrote, is fenced.
 * The tag carries a nonce so no title can close the block early. `nonce` is
 * for tests.
 */
export function formatTaskResume(c: TaskResumeContext, opts: WaitLabelOptions & { nonce?: string } = {}): string {
  const now = opts.now ?? Date.now();
  const nonce = opts.nonce ?? fenceNonce();
  const t = c.task;
  const task = `task ${t.short_id}: ${inlineForeignText(t.title)} [${t.status}, ${t.priority}]`;
  const lines = [
    `<task-context-${nonce} source="codecast">`,
    c.held === false
      ? `This session was bound to ${task}, but no longer holds it: it was closed or claimed elsewhere. Restored after the conversation was compacted or resumed.`
      : `You are bound to ${task}. This was restored after the conversation was compacted or resumed.`,
  ];
  if (c.blockers.length) {
    lines.push("Blocked by:");
    for (const b of c.blockers.slice(0, MAX_BLOCKERS)) lines.push(`- ${blockerLine(b, { ...opts, now })}`);
    if (c.blockers.length > MAX_BLOCKERS) lines.push(`- and ${c.blockers.length - MAX_BLOCKERS} more`);
  }
  if (c.progress) {
    const text = capForeignText(escapeForeignControlChars(c.progress.text).replace(/\s+/g, " ").trim(), PROGRESS_CHARS);
    lines.push(`Last progress (${inlineForeignText(c.progress.author)}, ${ago(c.progress.created_at, now)}):`);
    lines.push(fenceForeignText(text, `progress comment on ${t.short_id}`, { nonce }));
  } else {
    lines.push("No progress comment yet.");
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
