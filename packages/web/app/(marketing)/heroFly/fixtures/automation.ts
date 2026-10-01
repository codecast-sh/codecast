/**
 * Chapter 8, Automate: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * "Check CI every 4h" counts down and fires; its run takes the retry queue
 * change through implement and verify, and stops at the review gate, where the
 * lead's pinned state says it is waiting on review.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { TaskRow, TriggerRow } from "@/components/triggerTasks";
import type { NodeStatus, WFEdge, WFNode } from "@/components/WorkflowGraphView";
import { HOUR, MIN, OBJECTS, SESSIONS } from "./story";

/** Where the run is: before the trigger fires, then each node in turn, then parked at the gate. */
export type RunPhase = "armed" | "implement" | "verify" | "gate" | "rearmed";

export type TriggerEdits = Record<string, Partial<TaskRow>>;

const CI_PROMPT =
  `Check CI on main. If it is red, find the failing test and open a fix. If it is green, run the next queued change (${OBJECTS.task.shortId}) through implement, verify and review.`;

/**
 * The trigger rows on the automation surface. `wall` is the wall clock the
 * countdown is measured from (the fire badge reads its own clock at mount);
 * `fireIn` is the seconds left before "Check CI every 4h" fires.
 */
export function triggerRows(now: number, wall: number, phase: RunPhase, fireIn: number, edits: TriggerEdits): TriggerRow[] {
  const fired = phase !== "armed";
  const ci: TaskRow = {
    _id: "hero-tr1",
    short_id: "tr-77",
    title: OBJECTS.trigger.title,
    prompt: CI_PROMPT,
    display_summary: "Checks CI on main, then ships the next queued change",
    status: phase === "rearmed" ? "scheduled" : fired ? "running" : "scheduled",
    schedule_type: "recurring",
    interval_ms: 4 * HOUR,
    run_at: phase === "rearmed" ? wall + 4 * HOUR : fired ? undefined : wall + fireIn * 1000,
    run_count: phase === "rearmed" ? 12 : 11,
    created_at: now - 9 * 24 * HOUR,
    last_run_at: phase === "rearmed" ? wall - 2_000 : now - 4 * HOUR,
    last_run_summary: phase === "rearmed" ? `${OBJECTS.task.shortId} passed verify, waits on review` : "CI green on main: 212 tests passed",
    originating_conversation_id: SESSIONS.lead.id,
    originating_conversation_title: SESSIONS.lead.title,
    project_path: SESSIONS.lead.project,
  };
  const reviews: TaskRow = {
    _id: "hero-tr3",
    short_id: "tr-79",
    title: "Answer PR review comments",
    prompt: "When a review comment lands on a pull request this session opened, address it, push, and reply on the thread.",
    display_summary: "Fixes review comments, replies on the thread",
    status: "scheduled",
    schedule_type: "event",
    event_filter: { event_type: "pr_comment" },
    run_count: 7,
    created_at: now - 6 * 24 * HOUR,
    last_run_at: now - 50 * MIN,
    last_run_summary: "Answered 2 threads on #479",
    project_path: SESSIONS.lead.project,
  };
  return [ci, reviews].map((task) => ({ task: { ...task, ...edits[task._id] }, unread: false, openId: SESSIONS.lead.id }));
}

/** The workflow the trigger starts: implement, verify (looping back on a failure), then a human review gate. */
export const WORKFLOW: { _id: string; name: string; nodes: WFNode[]; edges: WFEdge[] } = {
  _id: "hero-wf1",
  name: "ship",
  nodes: [
    { id: "start", label: "Start", shape: "Mdiamond", type: "start" },
    { id: "implement", label: "Implement", shape: "box", type: "agent", prompt: "$task_title" },
    { id: "verify", label: "Verify", shape: "parallelogram", type: "command", script: "bun test" },
    { id: "review", label: "Review", shape: "hexagon", type: "human" },
    { id: "exit", label: "Exit", shape: "Msquare", type: "exit" },
  ],
  edges: [
    { from: "start", to: "implement" },
    { from: "implement", to: "verify" },
    { from: "verify", to: "review", condition: "outcome=success" },
    { from: "verify", to: "implement", condition: "outcome=failure" },
    { from: "review", to: "exit", label: "Approve" },
  ],
};

const ORDER = ["implement", "verify", "review"] as const;
const AT: Record<RunPhase, number> = { armed: -1, implement: 0, verify: 1, gate: 2, rearmed: 2 };

/** Each node's status in the graph's terms. Before the fire the graph shows the last run, which went all the way through. */
export function nodeStatuses(phase: RunPhase): Record<string, NodeStatus> {
  if (phase === "armed") return { start: "completed", implement: "completed", verify: "completed", review: "completed", exit: "completed" };
  const at = AT[phase];
  const out: Record<string, NodeStatus> = { start: "completed" };
  ORDER.forEach((id, i) => (out[id] = i < at ? "completed" : i === at ? "running" : "pending"));
  return out;
}

/** The previous run, four hours ago: implement, verify and an approved review. */
function lastRun(now: number) {
  const at = now - 4 * HOUR;
  return {
    _id: "hero-run0",
    workflow_id: WORKFLOW._id,
    workflow_name: WORKFLOW.name,
    status: "completed",
    current_node_id: undefined as string | undefined,
    updated_at: at + 9 * MIN,
    node_statuses: [
      { node_id: "implement", label: "Implement", status: "completed", started_at: at, completed_at: at + 5 * MIN, tokens: 31_400, result_preview: "Idempotency keys on every webhook handler" },
      { node_id: "verify", label: "Verify", status: "completed", started_at: at + 5 * MIN, completed_at: at + 6 * MIN, result_preview: "bun test: 198 passed" },
      { node_id: "review", label: "Review", type: "human", status: "completed", started_at: at + 6 * MIN, completed_at: at + 9 * MIN, outcome: "approved by Sarah" },
    ],
  };
}

/** The run the trigger started, as the run panel reads it (lib/workflowRun.ts); before the fire, the one before it. */
export function workflowRun(now: number, phase: RunPhase) {
  if (phase === "armed") return lastRun(now);
  const at = AT[phase];
  const done = (i: number) => i < at;
  const gate = at === 2;
  return {
    _id: "hero-run1",
    workflow_id: WORKFLOW._id,
    workflow_name: WORKFLOW.name,
    status: gate ? "paused" : "running",
    current_node_id: ORDER[at],
    gate_prompt: gate ? `Approve ${OBJECTS.task.shortId}, "${OBJECTS.task.title}"?` : undefined,
    updated_at: now - 5_000,
    node_statuses: [
      {
        node_id: "implement",
        label: "Implement",
        status: done(0) ? "completed" : "running",
        ...(done(0) ? { started_at: now - 4 * MIN - 12_000, completed_at: now - 52_000, tokens: 48_200, result_preview: "Retry queue with exponential backoff, capped at 5 attempts" } : { activity: "Editing src/billing/retry.ts" }),
      },
      ...(at >= 1
        ? [{
            node_id: "verify",
            label: "Verify",
            status: done(1) ? "completed" : "running",
            ...(done(1) ? { started_at: now - 50_000, completed_at: now - 8_000, result_preview: "bun test: 214 passed" } : { activity: "bun test" }),
          }]
        : []),
    ],
  };
}

/** The lead's pinned state: handing the change to the trigger's run, then waiting at its gate. */
export function pinnedState(phase: RunPhase): { text: string; status: string; messages: number } {
  if (phase === "gate" || phase === "rearmed") {
    return { text: `Waiting on review of ${OBJECTS.task.shortId}\nStatus: implement and verify passed\nNext: merge once someone approves the gate`, status: "blocked", messages: 71 };
  }
  return { text: `${OBJECTS.task.title}\nStatus: the CI trigger runs it through implement, verify and review\nNext: answer the review gate`, status: "working", messages: 68 };
}

export const entities: Record<string, EntityFixture> = {};
