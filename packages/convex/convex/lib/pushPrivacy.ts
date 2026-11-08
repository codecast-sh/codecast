// What a push may say once it leaves our servers. Every phone push passes
// through Expo (exp.host) and then Apple or Google, and Live Activities and
// CallKit rings go to Apple directly; none of them has a BAA with us. So for a
// person in a team whose managed policy marks its data regulated (HIPAA), a
// push names the event and the project it is about, never what was said:
// no message text, tool output, chat text, decision content or session title
// (titles are generated from the first message). The full text stays in our
// own tables (the notification row, the push ring) and the app reads it from
// us once opened.
//
// The rule is decided by the RECIPIENT, not the row: a push carries no request
// token, its subject spans conversations, chat, calls, recordings and tasks,
// and a regulated member's personal sessions can hold the same data. Fail
// closed: membership in any regulated team strips every push to that person.
// A leaf module (no ./functions import), so tests and actions can use it.
import type { Id } from "../_generated/dataModel";
import {
  CALL_GUEST_WAITING_PUSH_TYPE,
  CALL_PUSH_TYPE_MISSED,
  CALL_PUSH_TYPE_RING,
  RECORDING_SUMMARY_PUSH_TYPE,
} from "@codecast/shared/contracts";
import { teamPolicyOf } from "./teamPolicyGuard";

/** Event names by notification type, [one, many]: the batch summary's words and a stripped push's title. */
export const PUSH_TYPE_LABELS: Record<string, [string, string]> = {
  session_idle: ["session waiting for input", "sessions waiting for input"],
  sessions_need_input: ["session waiting for input", "sessions waiting for input"],
  permission_request: ["permission request", "permission requests"],
  session_error: ["session error", "session errors"],
  session_assigned: ["session ownership update", "session ownership updates"],
  task_completed: ["task completed", "tasks completed"],
  task_failed: ["task failed", "tasks failed"],
  task_unblocked: ["task unblocked", "tasks unblocked"],
  team_session_start: ["teammate session", "teammate sessions"],
  chat_mention: ["chat mention", "chat mentions"],
  chat_reply: ["thread reply", "thread replies"],
  chat_here: ["channel announcement", "channel announcements"],
  chat_dm: ["direct message", "direct messages"],
  chat_added: ["channel invite", "channel invites"],
  chat_post: ["channel message", "channel messages"],
  daemon_overloaded: ["overloaded daemon", "overloaded daemons"],
  machine_overloaded: ["overloaded machine", "overloaded machines"],
  goal_stall: ["stalled focus item", "stalled focus items"],
  device_shared: ["shared machine", "shared machines"],
  card_waiting: ["change card waiting", "change cards waiting"],
  change_shipped: ["change shipped", "changes shipped"],
  cause_reopened: ["problem came back", "problems came back"],
  decision_answered_for_you: ["decision answered for you", "decisions answered for you"],
  decision_passed: ["decision passed to you", "decisions passed to you"],
  decision_escalated: ["decision escalated to you", "decisions escalated to you"],
  decision_assigned: ["decision in your areas", "decisions in your areas"],
  decision_comment: ["comment on a decision", "comments on decisions"],
  team_join_request: ["request to join", "requests to join"],
  team_join_approved: ["team you joined", "teams you joined"],
  passkey_changed: ["passkey change", "passkey changes"],
  weekly_card: ["weekly card", "weekly cards"],
  metric_alert: ["metric alert", "metric alerts"],
  [CALL_PUSH_TYPE_RING]: ["huddle invite", "huddle invites"],
  [CALL_PUSH_TYPE_MISSED]: ["missed huddle", "missed huddles"],
  [CALL_GUEST_WAITING_PUSH_TYPE]: ["guest waiting to join", "guests waiting to join"],
  [RECORDING_SUMMARY_PUSH_TYPE]: ["recording ready", "recordings ready"],
};

// The only data keys a stripped push keeps: ids and stamps the app routes and
// dedupes on. Anything else a sender adds later stays home until it is named here.
const ROUTING_KEYS = [
  "type", "count",
  "conversationId", "taskId", "entity_type", "entity_id",
  "channelId", "messageId", "threadRootId",
  "room_key", "invite_id", "recordingId",
  "notificationSeq", "notificationEpoch", "notificationKey",
] as const;

export type PushContent = { title: string; subtitle?: string; body: string; data?: Record<string, any> };

/** The folder name of a project path: the one name a stripped push may give. */
export function projectNameOf(path: string | null | undefined): string | null {
  return path?.replace(/\/+$/, "").split("/").pop() || null;
}

/**
 * The payload a regulated recipient's push carries: the event as its title,
 * the project as its body, and routing ids only. `project` is the folder of
 * the session the push is about, when it is about one.
 */
export function stripPushContent(push: PushContent, project: string | null): PushContent {
  const data = push.data ?? {};
  const kept: Record<string, any> = {};
  for (const key of ROUTING_KEYS) if (data[key] !== undefined) kept[key] = data[key];
  const count = typeof data.count === "number" ? data.count : null;
  const label = PUSH_TYPE_LABELS[data.type];
  const title = data.type === "aggregate" && count
    ? `${count} notifications`
    : label
      ? capitalize(count && count > 1 ? `${count} ${label[1]}` : label[0])
      : "New notification";
  return { title, body: project ? `In ${project}` : "Open Codecast to see it", data: kept };
}

/** Whether pushes to this person must be stripped: they belong to a team that holds regulated data. */
export async function pushesStrippedFor(ctx: { db: any }, userId: Id<"users">): Promise<boolean> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const m of memberships) {
    const p = await teamPolicyOf(ctx, m.team_id);
    if (p?.policy.regulated_data === true) return true;
  }
  return false;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
