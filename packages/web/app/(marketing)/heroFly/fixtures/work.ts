/**
 * Chapter 7, Track: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The lead files "Retry queue for failed webhooks" under the Webhook
 * reliability plan; it lands on top of the plan's tasks, the API worker
 * claims it, and the plan moves on when the dead-letter queue ships.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import type { TaskItem } from "@/store/inboxStore";
import { FACES } from "./team";
import { DAY, HOUR, MIN, OBJECTS, PEOPLE, SESSIONS } from "./story";

export const PLAN = { _id: "hero-pl1", short_id: OBJECTS.plan.shortId, title: OBJECTS.plan.title, status: "active" };

const ME = { name: PEOPLE.me.name, image: FACES.me };
const SARAH = { name: PEOPLE.sarah.name, image: FACES.sarah };
const MAYA = { name: PEOPLE.maya.name, image: FACES.maya };

/** The session that files the task, as a task row and the activity trail name it. */
export const LEAD_LINK = {
  _id: SESSIONS.lead.id,
  session_id: `${SESSIONS.lead.id}-sess`,
  title: SESSIONS.lead.title,
  agent_type: SESSIONS.lead.agent,
  project_path: SESSIONS.lead.project,
  message_count: 64,
};

export const API_LINK = {
  _id: SESSIONS.api.id,
  session_id: `${SESSIONS.api.id}-sess`,
  title: SESSIONS.api.title,
  agent_type: SESSIONS.api.agent,
  project_path: SESSIONS.api.project,
  message_count: 12,
};

export type TaskStage = "landed" | "claimed";

/** The new task as the board shows it at each stage of the chapter. */
export function filedTask(now: number, stage: TaskStage): TaskItem {
  const claimed = stage === "claimed";
  return {
    _id: "hero-t1",
    short_id: OBJECTS.task.shortId,
    title: OBJECTS.task.title,
    task_type: "task",
    status: claimed ? "in_progress" : "open",
    priority: "high",
    source: "agent",
    source_agent_type: SESSIONS.lead.agent,
    labels: ["webhooks"],
    plan: PLAN,
    creator: ME,
    assignee: claimed ? PEOPLE.me.id : undefined,
    assignee_info: claimed ? ME : null,
    origin_session: { conversation_id: LEAD_LINK._id, session_id: LEAD_LINK.session_id, title: LEAD_LINK.title, started_by: PEOPLE.me.name, last_message_at: now - MIN },
    created_from_conversation: LEAD_LINK._id,
    // The billing project syncs with Linear: the new task has its issue by the time it is claimed.
    external: claimed ? { provider: "linear", id: "hero-lin-214", identifier: "BIL-214", url: "https://linear.app/acme/issue/BIL-214", remote_updated_at: now - 30_000, synced_at: now - 30_000 } : undefined,
    created_at: now - MIN,
    updated_at: now - MIN,
  };
}

/** The plan's other tasks, as they stand when the new one lands; the dead-letter queue ships at `WORK_AT.planAdvances`. */
export function planTasks(now: number, advanced: boolean): TaskItem[] {
  const task = (t: Partial<TaskItem> & Pick<TaskItem, "_id" | "short_id" | "title" | "status" | "priority">, ago: number): TaskItem => ({
    task_type: "task",
    source: "human",
    plan: PLAN,
    created_at: now - ago - DAY,
    updated_at: now - ago,
    ...t,
  });
  return [
    task({ _id: "hero-t2", short_id: "ct-4183", title: "Sign webhook payloads with HMAC", status: "in_progress", priority: "medium", labels: ["webhooks", "security"], assignee: PEOPLE.sarah.id, assignee_info: SARAH }, 2 * HOUR),
    task({
      _id: "hero-t3",
      short_id: "ct-4184",
      title: "Dead-letter queue for poisoned events",
      status: advanced ? "done" : "in_review",
      priority: "high",
      labels: ["webhooks"],
      assignee: PEOPLE.maya.id,
      assignee_info: MAYA,
      source: "agent",
      source_agent_type: SESSIONS.ui.agent,
    }, advanced ? 30_000 : 5 * HOUR),
    task({ _id: "hero-t4", short_id: "ct-4185", title: "Page on-call when retries run out", status: "open", priority: "medium", labels: ["ops"] }, DAY),
    task({
      _id: "hero-t5",
      short_id: "ct-4186",
      title: "Backfill events Stripe sent while we were down",
      status: "open",
      priority: "low",
      labels: ["data"],
      external: { provider: "linear", id: "hero-lin-212", identifier: "BIL-212", url: "https://linear.app/acme/issue/BIL-212", remote_updated_at: now - 2 * DAY, synced_at: now - 2 * DAY },
    }, 2 * DAY),
    task({ _id: "hero-t6", short_id: "ct-4187", title: "Idempotency keys on webhook handlers", status: "done", priority: "high", labels: ["webhooks"], assignee: PEOPLE.sarah.id, assignee_info: SARAH }, 3 * DAY),
  ];
}

/** The plan's progress, counted the way the plan page counts it (review counts as active). */
export function planProgress(tasks: TaskItem[]) {
  const done = tasks.filter((t) => t.status === "done").length;
  const active = tasks.filter((t) => t.status === "in_progress" || t.status === "in_review").length;
  return { total: tasks.length, done, in_progress: active, open: tasks.length - done - active };
}

/** The new task's activity trail: filed by the lead, then claimed by the API worker. */
export function filedHistory(now: number, stage: TaskStage) {
  if (stage !== "claimed") return [];
  return [
    { _id: "hero-h1", created_at: now - 20_000, action: "updated", field: "status", old_value: "open", new_value: "in_progress", actor: ME },
  ];
}

export function filedSessions(now: number, stage: TaskStage) {
  return [
    { ...LEAD_LINK, started_at: now - 40 * MIN, updated_at: now - MIN },
    ...(stage === "claimed" ? [{ ...API_LINK, started_at: now - 21_000, updated_at: now - 10_000, is_active: true }] : []),
  ];
}

/** The merge, as the task's trail records it once the pull request lands (chapter 10). */
export function mergedEvent(now: number) {
  return {
    _id: "hero-ev-merged",
    kind: "pr_merged",
    source: "github",
    repository: OBJECTS.pr.repository,
    pr_number: OBJECTS.pr.number,
    title: OBJECTS.pr.title,
    actor_login: PEOPLE.me.handle,
    task_ids: ["hero-t1"],
    created_at: now - 5_000,
  };
}

/** `cast task create` as the lead runs it. */
export const FILE_TOOL: ToolCall = {
  id: "hero-tool-task",
  name: "Bash",
  input: JSON.stringify({ command: `cast task create "${OBJECTS.task.title}" --plan ${OBJECTS.plan.shortId} -p high -l webhooks` }),
};

export const FILE_RESULT: ToolResult = {
  tool_use_id: FILE_TOOL.id,
  content: `Created ${OBJECTS.task.shortId}: ${OBJECTS.task.title}\nAdded to ${OBJECTS.plan.shortId} (${OBJECTS.plan.title})`,
};

const loaded = Date.now();

export const entities: Record<string, EntityFixture> = {
  [OBJECTS.task.shortId]: {
    type: "task",
    entity: { _id: "hero-t1", short_id: OBJECTS.task.shortId, title: OBJECTS.task.title, status: "open", priority: "high", updated_at: loaded - MIN },
  },
  [OBJECTS.plan.shortId]: {
    type: "plan",
    entity: { ...PLAN, progress: { done: 1, total: 6 }, updated_at: loaded - 3 * HOUR },
  },
};
