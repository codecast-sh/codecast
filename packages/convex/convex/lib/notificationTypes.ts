import { v } from "convex/values";

// The notification unions, imported by every module that writes a
// notification, so a new type cannot be added to one list and missed by the
// others. They live in a leaf because notificationRouter.ts reaches
// notifications.ts back through its imports: a union defined in either one and
// read at load by the other throws a TDZ ReferenceError whenever the defining
// module loads first.
export const ENTITY_TYPE = v.union(
  v.literal("task"),
  v.literal("doc"),
  v.literal("plan"),
  v.literal("conversation"),
  v.literal("artifact"),
  v.literal("chat_channel"),
  // A machine, for the daemon loop freeze alert. Nothing subscribes to a device:
  // the alert goes to its owner through direct_recipient_id.
  v.literal("device"),
  // A place in a repository (`owner/repo@sha` or `owner/repo#12`), for a code
  // comment that names someone. Direct recipients only, like a device: nobody
  // subscribes to a commit.
  v.literal("code"),
  // A role, by short id: a goal stall notice to a person who reports to it
  // (org-roles-run-work.md R6). Direct recipients only.
  v.literal("org_role"),
  // A team, for a join request found by work email (teamDiscovery.ts).
  // Direct recipients only.
  v.literal("team")
);

export const NOTIFICATION_TYPE = v.union(
  v.literal("mention"),
  v.literal("comment_reply"),
  v.literal("conversation_comment"),
  v.literal("team_invite"),
  v.literal("session_idle"),
  v.literal("permission_request"),
  v.literal("session_error"),
  v.literal("session_assigned"),
  v.literal("team_session_start"),
  v.literal("task_completed"),
  v.literal("task_failed"),
  v.literal("task_assigned"),
  v.literal("task_status_changed"),
  v.literal("task_commented"),
  v.literal("doc_updated"),
  v.literal("doc_commented"),
  v.literal("plan_status_changed"),
  v.literal("plan_task_completed"),
  v.literal("artifact_commented"),
  v.literal("chat_mention"),
  v.literal("chat_reply"),
  v.literal("chat_here"),
  v.literal("chat_dm"),
  v.literal("chat_added"),
  // An ordinary channel line, emitted only to members whose per-channel notify
  // level is "all" (chat.ts gates it). For everyone else plain chatter stays
  // unread state with no row and no push.
  v.literal("chat_post"),
  // The daemon on one machine spent more than its budget frozen in the last hour.
  v.literal("daemon_overloaded"),
  // A role tells a person who reports to it that a high priority goal has
  // stalled (org-roles-run-work.md R6): one line, once a day at most.
  v.literal("goal_stall"),
  // The hourly fold-up of "sessions are waiting for you" (notifications.ts).
  v.literal("sessions_need_input"),
  // A teammate shared a machine with a team the recipient is on.
  v.literal("device_shared"),
  // The line (the-line-end-to-end.md LE16): a change card waits on the
  // recipient, a cause's change shipped, a watched cause reopened.
  v.literal("card_waiting"),
  v.literal("change_shipped"),
  v.literal("cause_reopened"),
  // A task assigned to the recipient is unblocked and no session owns it.
  v.literal("task_unblocked"),
  // Someone outside a decision's people answered it for them.
  v.literal("decision_answered_for_you"),
  // Finding a team by work email: a request to its admins, then the approval.
  v.literal("team_join_request"),
  v.literal("team_join_approved")
);
