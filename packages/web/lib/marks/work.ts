import type { MarkDef } from "./types";

// Tasks, plans and the objects a pill or card names: task status circles and
// priorities, waits, plan statuses and states, and
// each object kind's glyph.

type Def = Omit<MarkDef, "group">;
const work = (defs: Def[]): MarkDef[] => defs.map((d) => ({ ...d, group: "Work" }));

const TASK_CATEGORIES = ["backlog", "open", "in_progress", "in_review", "done", "dropped"];

/** A task status circle's mark: a team's own status reads as its category, so
 *  its graduated disc is another picture of the same meaning. */
export const taskStatusMarkId = (category: string | null | undefined) =>
  `task.${category && TASK_CATEGORIES.includes(category) ? category : "open"}`;

export const workMarks: MarkDef[] = work([
  { id: "task.backlog", name: "Backlog", meaning: "Kept for later, not queued" },
  { id: "task.open", name: "Open", meaning: "Ready to pick up, not started" },
  { id: "task.in_progress", name: "In progress", meaning: "Being worked; fuller is further along" },
  { id: "task.in_review", name: "In review", meaning: "Built, waiting on a review" },
  { id: "task.done", name: "Task done", meaning: "Finished" },
  { id: "task.dropped", name: "Dropped", meaning: "Closed without doing it" },

  { id: "task.priority.urgent", name: "Urgent", meaning: "Do it before anything else" },
  { id: "task.priority.high", name: "High priority", meaning: "Do it soon" },
  { id: "task.priority.medium", name: "Medium priority", meaning: "The usual" },
  { id: "task.priority.low", name: "Low priority", meaning: "When there's time" },
  { id: "task.priority.none", name: "No priority", meaning: "Nobody has ranked it" },

  { id: "task.waiting", name: "Blocked task", meaning: "Waiting on something before it can go" },
  { id: "task.wait_failed", name: "Wait failed", meaning: "What it waits on can't happen; re-plan" },
  { id: "task.subtasks", name: "Subtasks", meaning: "How many of its subtasks are done" },
  { id: "task.hidden_subtasks", name: "Agent subtasks", meaning: "Some subtasks are agents' own, hidden here" },
  { id: "task.parent", name: "Subtask of", meaning: "Sits under the task it names" },
  { id: "task.duplicate", name: "Duplicate", meaning: "Dropped as a copy of the task it names" },
  { id: "task.agent_made", name: "Made by an agent", meaning: "An agent filed it" },
  { id: "task.from_meeting", name: "From a meeting", meaning: "People decided it on a call or in a meeting" },
  { id: "task.in_flow", name: "In a flow", meaning: "A flow run has it at the step named" },
  { id: "work.sessions", name: "Sessions", meaning: "How many sessions worked on it" },
  { id: "work.tasks", name: "Tasks", meaning: "How many tasks it holds" },
  { id: "work.agents", name: "Agents working", meaning: "How many agents are on it now" },

  // A plan's own status: what a person last set it to.
  { id: "plan.draft", name: "Draft plan", meaning: "Still being written" },
  { id: "plan.active", name: "Active plan", meaning: "Set as underway" },
  { id: "plan.paused", name: "Paused plan", meaning: "Set aside for now" },
  { id: "plan.done", name: "Plan done", meaning: "Marked finished" },
  { id: "plan.abandoned", name: "Plan abandoned", meaning: "Given up on" },

  // Where a plan stands, read from its sessions (the inbox's plan bands).
  { id: "plan.needs_you", name: "Plan needs you", meaning: "A session on the plan asked you something" },
  { id: "plan.moving", name: "Plan moving", meaning: "Its sessions worked in the last day" },
  { id: "plan.parked", name: "Plan parked", meaning: "Its sessions sleep until something wakes them" },
  { id: "plan.finished", name: "Plan finished", meaning: "Its sessions delivered; review them" },
  { id: "plan.stalled", name: "Plan stalled", meaning: "Open, but nothing has moved in a day" },
  { id: "plan.closed", name: "Plan closed", meaning: "Marked done or abandoned" },
  { id: "plan.quiet", name: "Quiet plans", meaning: "Stalled, finished or closed plans" },
  { id: "plan.time", name: "Plan time", meaning: "Estimated time its open tasks need, or time spent once done" },

  // A plan page's views, always drawn beside their names.
  { id: "plan.view.overview", name: "Overview", meaning: "The plan's tasks, progress and notes" },
  { id: "plan.view.orchestration", name: "Orchestration", meaning: "The sessions working the plan" },
  { id: "plan.view.board", name: "Board", meaning: "The plan's tasks as columns by status" },
  { id: "plan.view.graph", name: "Graph", meaning: "The plan's tasks and what each waits on" },

  { id: "entity.session", name: "Session", meaning: "An agent conversation" },
  { id: "entity.plan", name: "Plan", meaning: "A plan of tasks" },
  { id: "entity.doc", name: "Doc", meaning: "A shared document" },
  { id: "entity.trigger", name: "Trigger", meaning: "Work that runs on a schedule or event" },
  { id: "entity.project", name: "Project", meaning: "A body of work its tasks, plans and sessions belong to" },
  { id: "entity.goal", name: "Goal", meaning: "A goal the work serves" },
  { id: "entity.role", name: "Role", meaning: "A role in the org" },
  { id: "entity.person", name: "Person", meaning: "Someone on the team" },
  { id: "entity.proposal", name: "Proposal", meaning: "A proposed change to the org" },
  { id: "entity.decision", name: "Decision", meaning: "A question put to a person" },
  { id: "entity.call", name: "Call", meaning: "A team call" },
  { id: "entity.source", name: "Source", meaning: "A feed of product events" },
  { id: "entity.replay", name: "Replay", meaning: "A recording of a user's session" },
  { id: "entity.flow", name: "Flow", meaning: "A workflow that takes a change to done" },
  { id: "entity.priority", name: "Priority", meaning: "One of the team's priorities" },
  { id: "entity.commit", name: "Commit", meaning: "A change saved in git" },
  { id: "entity.issue", name: "Issue", meaning: "A production error" },
  { id: "entity.metric", name: "Metric", meaning: "A tracked number and its alert" },
  { id: "entity.deploy", name: "Deploy", meaning: "One release of code to a target" },
  { id: "entity.secret", name: "Secret", meaning: "A stored credential" },

  { id: "decision.pending", name: "Open decision", meaning: "Waiting on an answer" },
  { id: "decision.answered", name: "Answered", meaning: "Someone answered it" },
  { id: "decision.dismissed", name: "Dismissed", meaning: "Closed without an answer" },

  { id: "pr.open", name: "Open PR", meaning: "A pull request open for review" },
  { id: "pr.draft", name: "Draft PR", meaning: "A pull request not ready yet" },
  { id: "pr.merged", name: "Merged PR", meaning: "A pull request that landed" },
  { id: "pr.closed", name: "Closed PR", meaning: "A pull request closed unmerged" },

  // What an open pull request waits on.
  { id: "pr.review_pending", name: "Awaiting review", meaning: "The pull request waits for a review" },
  { id: "pr.changes_requested", name: "Changes requested", meaning: "A reviewer asked for changes" },
  { id: "pr.ci_pending", name: "Checks running", meaning: "Waiting on CI" },
  { id: "pr.failing", name: "Checks failing", meaning: "CI failed; it needs a fix" },
  { id: "pr.behind", name: "Behind base", meaning: "Its branch needs the base's new commits" },
  { id: "pr.conflicts", name: "Conflicts", meaning: "Merge conflicts to resolve" },
  { id: "pr.approved", name: "Approved", meaning: "A reviewer approved it" },
  { id: "pr.ready", name: "Ready to merge", meaning: "Approved and green" },

  { id: "git.branch", name: "Branch", meaning: "A git branch" },

  // A deploy's state, on its pill and wherever a change's reach is drawn
  // (lib/deploys/deployLook.ts). A pill's "waiting" is a deploy asked for and
  // not started: the same meaning as a change's "queued", so one id.
  { id: "deploy.queued", name: "Deploy queued", meaning: "Asked for; no machine has started it" },
  { id: "deploy.waiting", name: "Not deploying yet", meaning: "No deploy is taking the change yet" },
  { id: "deploy.going_out", name: "Going out", meaning: "A deploy is running" },
  { id: "deploy.live", name: "Live", meaning: "Deployed and serving" },
  { id: "deploy.replaced", name: "Replaced", meaning: "Was live; a newer deploy took its place" },
  { id: "deploy.failed", name: "Deploy failed", meaning: "The deploy failed" },
  { id: "deploy.cancelled", name: "Deploy cancelled", meaning: "Stopped before it went out" },
  { id: "deploy.rolled_back", name: "Rolled back", meaning: "A rollback, or a change a rollback took out" },

  // A change on its way to live (a pull request's or commit's pill): the
  // five-stage track and the glyph for where it stands now
  // (components/changes/ChangeChip.tsx).
  { id: "change.track", name: "Change track", meaning: "Work, check, land, deploy, live: the lit bar is where it is", oneGlyph: true },
  { id: "change.now.done", name: "Passed", meaning: "It cleared the stage it's at" },
  { id: "change.now.active", name: "In motion", meaning: "Moving through its stage now" },
  { id: "change.now.waiting", name: "In line", meaning: "Waiting its turn in a queue" },
  { id: "change.now.you", name: "Your move", meaning: "A person must act: review it or land it" },
  { id: "change.now.back", name: "Sent back", meaning: "Back with its session: changes asked, conflicts, behind main or rolled back" },
  { id: "change.now.failed", name: "Change failed", meaning: "Stopped on a failure" },
  { id: "change.now.skipped", name: "Skipped", meaning: "Not on its path" },
  { id: "change.now.stopped", name: "Change closed", meaning: "Closed without landing" },
]);

/** A deploy pill's state as its mark (`deployPillState`, plus a rollback's own glyph). */
export const deployMarkId = (state: string, rollback = false) =>
  rollback ? "deploy.rolled_back" : state === "waiting" ? "deploy.queued" : `deploy.${state}`;
