// Delivering a session notification to one person (their prefs, the
// needs-input digest window, superseding the previous state row, the push)
// and to every party of a session. Kept apart from notifications.ts so a
// module that only rings someone (devices, accountSwitch, the assignment
// notices) does not import the needs-input check, which reaches agentTasks
// and the whole function graph behind it (ct-92329).
import { internal } from "../_generated/api";
import { IDLE_DIGEST_WINDOW_MS, agentAnswersRow, isAssignedAwayFromOwnerSet, waitReachedPeople } from "@codecast/shared/contracts";
import { enqueuePush } from "../pushRouter";
import { listSessionPartyIds } from "../sessionOwners";
import { inboxOwnersOf, waitAudienceOf } from "./inboxOwners";
import { cardRangFor } from "./decisionRing";

export type SessionNotifType =
  | "session_idle"
  | "permission_request"
  | "session_error"
  | "session_assigned";

function sessionNotifOptedOut(
  prefs: Record<string, any> | undefined,
  type: SessionNotifType,
): boolean {
  if (type === "session_idle") return prefs?.session_idle === false;
  if (type === "session_error") return prefs?.session_error === false;
  // Opt-out, not opt-in: being handed a session is something you need to know
  // about, so it's on unless explicitly disabled.
  if (type === "session_assigned") return prefs?.session_assigned === false;
  return !!prefs && !prefs.permission_request;
}

// Session-STATE types describe what the session is currently doing (waiting,
// blocked on a permission, errored) — as opposed to discrete events like
// "assigned to you" or a comment. A state supersedes the previous one, so the
// notification list keeps at most ONE of these per (recipient, conversation):
// stacking a "ready" row for every turn of an active back-and-forth is noise.
const SESSION_STATE_TYPES = new Set<string>([
  "session_idle",
  "permission_request",
  "session_error",
]);

export function idleDigestOn(prefs: Record<string, any> | undefined): boolean {
  return prefs?.session_idle_digest !== false;
}

// Insert the notification row + push for ONE recipient, honoring their prefs.
// Shared by the api-token mutation below (daemon-driven permission/error
// notifications) and the server-side needs-input check.
export async function deliverSessionNotification(
  ctx: any,
  recipientId: any,
  conversationId: any,
  type: SessionNotifType,
  title: string,
  message: string,
  // The digest's own delivery sets this: the fold-up alert must not be folded
  // up again.
  opts?: { bypassDigest?: boolean },
): Promise<boolean> {
  const user = await ctx.db.get(recipientId);
  if (!user) return false;
  if (sessionNotifOptedOut(user.notification_preferences as any, type)) return false;
  // A session parked on a card that rang this person (lib/decisionPush.ts):
  // "waiting for you" would be the same news again, without the question.
  // Someone the card did not ring still hears the session wait.
  if (type === "session_idle" && (await cardRangFor(ctx, conversationId, user))) return false;

  // Open window → this row joins the fold-up and stays quiet. Closed window →
  // it alerts now and opens the next one.
  let quiet = false;
  if (type === "session_idle" && !opts?.bypassDigest && idleDigestOn(user.notification_preferences)) {
    const now = Date.now();
    const state = user.idle_digest_state;
    const windowEndsAt = (state?.last_alerted_at ?? 0) + IDLE_DIGEST_WINDOW_MS;
    if (now >= windowEndsAt) {
      await ctx.db.patch(user._id, { idle_digest_state: { last_alerted_at: now } });
    } else {
      quiet = true;
      // One flush per window. A stamp in the past is a window whose fold-up
      // already ran, so the next quiet row arms the next one.
      if (!state?.flush_due_at || state.flush_due_at <= now) {
        await ctx.db.patch(user._id, {
          idle_digest_state: { last_alerted_at: state?.last_alerted_at ?? 0, flush_due_at: windowEndsAt },
        });
        await ctx.scheduler.runAfter(windowEndsAt - now, internal.notifications.idleDigestFlush, {
          user_id: user._id,
        });
      }
    }
  }

  // Replace, don't stack: a new state row supersedes the conversation's old
  // one. Delete + insert (rather than patch) so the row gets a fresh _id —
  // the desktop's native-banner watcher treats an unseen _id as "new", which
  // keeps one banner per episode while the in-app list stays at one row.
  if (SESSION_STATE_TYPES.has(type)) {
    const prior = (await ctx.db
      .query("notifications")
      .withIndex("by_recipient_conversation", (q: any) =>
        q.eq("recipient_user_id", recipientId).eq("conversation_id", conversationId),
      )
      .collect()).filter((n: any) => SESSION_STATE_TYPES.has(n.type));

    // A quiet row supersedes IN PLACE. Delete-and-insert is how an alerting
    // row earns a fresh _id (the desktop watcher reads an unseen _id as "new"),
    // and a quiet row wants exactly the opposite. It also must not orphan the
    // earlier row's staged push: the outbox drops a push whose notification is
    // gone, so a second settle minutes after the first used to silently cancel
    // the alert the first one had already earned.
    if (quiet && prior.length > 0) {
      const newest = prior.reduce((a: any, b: any) => (b.created_at > a.created_at ? b : a));
      for (const n of prior) {
        if (n._id !== newest._id) await ctx.db.delete(n._id);
      }
      await ctx.db.patch(newest._id, {
        type,
        message,
        read: false,
        created_at: Date.now(),
        quiet: true,
      });
      return true;
    }
    for (const n of prior) await ctx.db.delete(n._id);
  }

  const notifId = await ctx.db.insert("notifications", {
    recipient_user_id: recipientId,
    type,
    conversation_id: conversationId,
    message,
    read: false,
    created_at: Date.now(),
    ...(quiet ? { quiet: true } : {}),
  });

  if (!quiet && user.push_token && user.notifications_enabled) {
    await enqueuePush(ctx, {
      user,
      notification_id: notifId,
      type,
      title,
      body: message,
      data: {
        conversationId,
        type,
      },
    });
  }
  return true;
}

// The runner (user_id) plus every OWNER. An owner is a human actually waiting on
// this session (a Mr Bot fix session parking with "ready to ship?"), so mirror
// the notification to them — same prefs gates, their own row+push. Reads the
// canonical owner SET: a session can have several owners, and they all need to
// hear about it, not just the one cached in owner_user_id.
export async function deliverSessionNotificationToParties(
  ctx: any,
  conversation: { _id: any; user_id: any; owner_user_id?: any; team_id?: any; message_count?: number; wait_up_count?: number; wait_up_person?: any },
  type: SessionNotifType,
  title: string,
  message: string,
): Promise<boolean> {
  // Under the owners model (team feature session_owners) the alert follows
  // the owners rule: the person owners hear, the implicit starter included,
  // and a wait an agent owner answers rings nobody (shared agentAnswersRow)
  // until it reaches them (wait_up_at). With no person owner left, the human
  // who started it hears, so a wait is never swallowed.
  const owners = await inboxOwnersOf(ctx, conversation);
  if (owners) {
    const row = { ...conversation, ...owners };
    const isWait = type === "session_idle" || type === "permission_request";
    if (isWait && agentAnswersRow(row)) return false;
    // Exactly the people whose inbox lists it: the shared audience rule's
    // people (its person owners, its starter, down to where its role's line
    // ends or a workspace admin, never an agent account), so someone always
    // hears it. Where that falls past the owners, the person a current
    // escalation reached is the one its stamp names, so a wait handed on from
    // a leaver never rings them again.
    const escalatedTo = row.wait_up_person && waitReachedPeople(row) ? String(row.wait_up_person) : null;
    const audience = await waitAudienceOf(ctx, conversation, { agentReachable: false });
    const people = escalatedTo && (!audience || audience.person) ? [escalatedTo] : audience?.people ?? [];
    let reached = false;
    for (const id of new Set(people.map(String))) {
      if (await deliverSessionNotification(ctx, id, conversation._id, type, title, message)) reached = true;
    }
    return reached;
  }
  // Recipients are the UNION of the canonical owner set and the owner_user_id
  // cache. The cache is a safety net, not a second source of truth: a legacy row
  // written before the session_owners backfill has a cached owner but no join
  // row, and it must not silently stop notifying them in the window between
  // deploy and backfill. Once backfilled the two agree, and the Set de-dupes.
  const recipients = await listSessionPartyIds(ctx, conversation._id);
  if (conversation.owner_user_id) recipients.push(conversation.owner_user_id);

  // The alert follows the inbox row. A session whose owner set excludes the
  // account that runs it has been handed over (the same rule the inbox scan
  // applies), so the runner is not rung about work that is no longer theirs to
  // answer. An unowned session is the runner's own and always rings them.
  const runnerAssignedAway = isAssignedAwayFromOwnerSet(recipients, conversation.user_id.toString());
  let delivered = runnerAssignedAway
    ? false
    : await deliverSessionNotification(
      ctx, conversation.user_id, conversation._id, type, title, message,
    );

  const seen = new Set<string>(runnerAssignedAway ? [] : [conversation.user_id.toString()]); // runner: done above
  for (const ownerId of recipients) {
    const key = ownerId.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (await deliverSessionNotification(ctx, ownerId, conversation._id, type, title, message)) {
      delivered = true;
    }
  }
  return delivered;
}
