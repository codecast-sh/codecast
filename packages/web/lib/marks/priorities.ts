import type { MarkDef } from "./types";

// The priorities page: critical pips, the ten-day strip, plan, task, PR,
// branch and deploy chips, milestones, the bracket. Plain session states are
// the session.* marks; task states, PR states and the plan glyph are the work
// marks (task.*, pr.*, entity.plan, work.tasks). Marks drawn from data keep
// one glyph.
const mark = (id: string, name: string, meaning: string, oneGlyph?: true): MarkDef => ({ id: `priority.${id}`, name, meaning, group: "Priorities", ...(oneGlyph && { oneGlyph }) });

export const priorityMarks: MarkDef[] = [
  mark("critical", "Critical path", "Its critical milestones; filled ones are done", true),
  mark("ten_days", "Last 10 days", "Messages a day; outlined is today, a tick a milestone landed", true),
  mark("landed", "Milestones landed", "Critical milestones landed each day", true),
  mark("today_share", "Today's messages", "Split by priority; hatched is no priority", true),
  mark("milestone_open", "Open milestone", "Not done yet"),
  mark("milestone_done", "Done milestone", "Landed"),
  mark("bracket", "Shared session", "One session works these milestones", true),
  mark("stalled", "Stalled", "No critical milestone landed in days"),
  // The bordered action marks on a milestone's line (priorities-status).
  mark("answer", "Needs you", "A session waits on you: open it"),
  mark("new_session", "New session", "Start a session on this milestone"),
  mark("unstaffed", "Nobody on it", "No session works this milestone"),
  mark("workflow", "Workflow run", "A session a workflow started"),
  mark("branch", "Branch", "A git branch of this milestone"),
  mark("deploy", "Deploy", "Green is live, red failed"),
  mark("plan_progress", "Plan progress", "How much of the plan is done", true),
  mark("pr_count", "Pull requests", "How many PRs it links"),
  mark("branch_count", "Branches", "How many branches it links"),
  mark("deploy_count", "Deploys", "How many deploys it links"),
];
