import type { MarkDef } from "./types";

// The priorities page's own glyphs (components/priorities): what a milestone's
// box column draws beyond a session's state, the ten-day strip, and a task
// whose row has not loaded; and a milestone's open or done mark on a priority
// change card. Shared meanings keep their shared ids: a
// milestone's states and its bordered Needs you are session.*, a task's state
// task.*, pull requests pr.*, deploys deploy.*, the plan entity.plan, a branch
// git.branch, a workflow run inbox.flow, the page's own glyph entity.priority.
const mark = (id: string, name: string, meaning: string, oneGlyph?: true): MarkDef => ({ id: `priority.${id}`, name, meaning, group: "Priorities", ...(oneGlyph && { oneGlyph }) });

export const priorityMarks: MarkDef[] = [
  mark("new_session", "New session", "Nobody is on this milestone: start a session on it"),
  mark("ten_days", "Last 10 days", "Messages typed each day; outlined is today", true),
  mark("task_loading", "Task loading", "The task's status hasn't arrived yet"),
  // A milestone named on a priority change card (components/decisions/PriorityChangeCard).
  mark("milestone_open", "Open milestone", "Not done yet"),
  mark("milestone_done", "Done milestone", "Landed"),
];
