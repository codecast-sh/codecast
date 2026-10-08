/**
 * The block a session bound to a task gets back after compaction or a resume
 * (docs/architecture/task-graph.md TG10). The server reads it in one query
 * (convex/taskResume.ts); the SessionStart hook prints it. A new session is
 * left alone: its bound task is already in front of it.
 */

import { escapeForeignControlChars, capForeignText, inlineForeignText } from "../contracts/fence";
import { blockerLabel, type Blocker, type WaitLabelOptions } from "./graph";

/** The SessionStart sources that lose the conversation the task lived in. */
export const TASK_RESUME_SOURCES = ["compact", "resume"] as const;

export function restoresTaskContext(source: unknown): boolean {
  return (TASK_RESUME_SOURCES as readonly unknown[]).includes(source);
}

export type TaskResumeContext = {
  task: { short_id: string; title: string; status: string; priority: string };
  /** The open blockers (graph.ts `blockersOf`), each task one with its title. */
  blockers: Array<Blocker & { title?: string }>;
  progress: { text: string; author: string; created_at: number } | null;
  plan: {
    short_id: string;
    title: string;
    status: string;
    done: number;
    total: number;
    /** The step `cast task ready --plan` would hand out first. */
    next: { short_id: string; title: string; priority: string } | null;
  } | null;
};

/** How much of the last progress note the block carries, folded to one line. */
const PROGRESS_CHARS = 600;
const MAX_BLOCKERS = 8;

/** "ct-12 Design schema [in_progress]", or the wait's condition: graph.ts's words. */
function blockerLine(b: TaskResumeContext["blockers"][number], opts: WaitLabelOptions): string {
  if (b.kind === "task" && "status" in b && b.title !== undefined) return `${b.ref} ${inlineForeignText(b.title)} [${b.status}]`;
  return blockerLabel(b, opts);
}

function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** The block, at most ~20 lines. Every title and note is foreign text: escaped, one line each. */
export function formatTaskResume(c: TaskResumeContext, opts: WaitLabelOptions = {}): string {
  const now = opts.now ?? Date.now();
  const t = c.task;
  const lines = [
    `<task-context source="codecast">`,
    `You are bound to task ${t.short_id}: ${inlineForeignText(t.title)} [${t.status}, ${t.priority}]. This was restored after the conversation was compacted or resumed.`,
  ];
  if (c.blockers.length) {
    lines.push("Blocked by:");
    for (const b of c.blockers.slice(0, MAX_BLOCKERS)) lines.push(`- ${blockerLine(b, { ...opts, now })}`);
    if (c.blockers.length > MAX_BLOCKERS) lines.push(`- and ${c.blockers.length - MAX_BLOCKERS} more`);
  }
  if (c.progress) {
    const text = capForeignText(escapeForeignControlChars(c.progress.text).replace(/\s+/g, " ").trim(), PROGRESS_CHARS);
    lines.push(`Last progress (${inlineForeignText(c.progress.author)}, ${ago(c.progress.created_at, now)}): ${text}`);
  } else {
    lines.push("No progress comment yet.");
  }
  if (c.plan) {
    const p = c.plan;
    lines.push(`Plan ${p.short_id}: ${inlineForeignText(p.title)} [${p.status}, ${p.done}/${p.total} done]`);
    lines.push(p.next ? `Next ready step: ${p.next.short_id} ${inlineForeignText(p.next.title)} [${p.next.priority}]` : "No other plan step is ready.");
  }
  lines.push(`Full context: cast task context ${t.short_id}. Post progress with cast task comment ${t.short_id} "…" -t progress.`);
  lines.push(`</task-context>`);
  return lines.join("\n");
}
