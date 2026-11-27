// The scheduled halves of a dormant pin's wait (lib/waitingOn.ts): arming a
// PR wait's triggers, telling the sessions that wait on one that settled, and
// a person's card unanswered for a day (lib/personWait.ts).

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { insertTask } from "./agentTasks";
import { escalatePersonWaitCore } from "./lib/personWait";
import { hasUnreadWork, workerSettleWhy } from "./lib/sessionSettle";
import { isSpawnedWorker } from "./lib/workerSettleTrigger";
import { PR_WAKE_EVENTS, prWakeFailed, prWakePrompt, prWakeTitle, prWakeTriggers, wakeWaiters } from "./lib/waitingOn";
import { prOfWaitingRef } from "@codecast/shared/contracts/waitingOn";
import { WORKER_SETTLE_WORDS, inlineForeignText, threadStateHeadline } from "@codecast/shared/contracts";

/** Arm the session's PR wait: one event trigger into it for the PR merging
 *  and one for it closing unmerged. Reads the wait again, so a pin that moved
 *  on before this ran arms nothing, and one already armed is not doubled. An
 *  arm the trigger rules refuse takes the wait back and tells the session. */
export const armPrWake = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    const w = conv?.waiting_on;
    const pr = w?.kind === "pr" ? prOfWaitingRef(w.ref) : null;
    if (!conv || !w || !pr || conv.inbox_killed_at) return { armed: 0 };
    if ((await prWakeTriggers(ctx, conv._id, w.ref)).length) return { armed: 0 };
    try {
      for (const event of PR_WAKE_EVENTS) {
        await insertTask(ctx, conv.user_id, {
          title: prWakeTitle(w.ref),
          prompt: prWakePrompt(w.ref, event),
          originating_conversation_id: String(conv._id),
          created_by_conversation_id: String(conv._id),
          project_path: conv.project_path,
          agent_type: /codex/.test(conv.agent_type ?? "") ? "codex" : "claude",
          schedule_type: "event",
          event_filter: { event_type: event, repository: pr.repository, pr_number: pr.pr_number },
        });
      }
    } catch (e) {
      await prWakeFailed(ctx, conv, w.ref, e instanceof Error ? e.message : String(e));
      return { armed: 0, failed: true };
    }
    return { armed: PR_WAKE_EVENTS.length };
  },
});

/** A session others wait on settled (scheduled one idle grace after the
 *  status change, lib/workerSettleTrigger.scheduleSessionWaiters): tell them,
 *  unless a newer status took over or it is still on its own work (producing,
 *  or dormant on a wake of its own). A worker's lead hears through the
 *  worker's own report (workerSettle.tellParent), so its wait only clears. */
export const tellSessionWaiters = internalMutation({
  args: { conversation_id: v.id("conversations"), status_ts: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.conversation_id);
    if (!target) return { told: 0 };
    const session = await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", target._id)).first();
    if (args.status_ts !== undefined && session?.agent_status_updated_at !== args.status_ts) return { told: 0 };
    // Killed or torn down (the kill path schedules this with no status time):
    // stopped. A settle with work still unread is not one.
    const why = target.inbox_killed_at || (target.inbox_dismissed_at && !target.inbox_closed_at)
      ? "stopped"
      : hasUnreadWork(target, session?.agent_status_updated_at) ? null : workerSettleWhy(target, session?.agent_status, Date.now());
    if (!why) return { told: 0 };
    const label = target.short_id ?? String(target._id).slice(0, 7);
    const title = target.title ? ` ("${inlineForeignText(target.title).replace(/"/g, "'").slice(0, 80)}")` : "";
    const headline = threadStateHeadline(target.thread_state ?? "");
    const lead = isSpawnedWorker(target) ? String(target.parent_conversation_id) : null;
    const told = await wakeWaiters(ctx, "session", String(target._id), `${why}:${args.status_ts ?? 0}`, (w) =>
      String(w._id) === lead
        ? null
        : `Session ${label}${title} ${WORKER_SETTLE_WORDS[why]}${headline ? `: ${inlineForeignText(headline)}` : ""}. You waited on it (cast state --on ${label}): read it with cast read ${label} and continue the work that waited on it.`,
    );
    return { told };
  },
});

/** A person's card was raised a day ago (lib/personWait.armEscalation): when
 *  it is still the wait's and still unanswered, the session's own person gets
 *  a card about it. A card answered or raised again since, or a wait that
 *  moved on, makes this a no-op: that is its cancellation. */
export const escalatePersonWait = internalMutation({
  args: { conversation_id: v.id("conversations"), decision_id: v.id("session_decisions"), raised_at: v.number() },
  handler: (ctx, args) => escalatePersonWaitCore(ctx, args),
});
