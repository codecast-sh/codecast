import { wakeFieldsOf, wakeCost } from "./wakeCost";
import { deriveSessionActivity, classifyWorkState, trustedAgentStatus, userRestOf, isSettleVerdictCurrent, HEARTBEAT_ALIVE_MS, type WorkState } from "./inboxFilters";
import { openTasksVouchForWaiting } from "@codecast/shared/contracts";
import { armedTriggerHomeLoader, isArmedTriggerHome, isArmedLoopHome } from "./dormancy";

// The one work-state classifier for every CLI surface that lists sessions
// (`cast feed` and the stable-context FEED, `cast search`, `cast context` file
// matches). It reuses the exact inbox classifier so the CLI never re-implements
// the rule. The managed row is cached per conversation; the only extra DB cost
// is the awaiting_input read, gated to a live, non-idle session (the sole case
// that can be parked on an open AskUserQuestion). Callers classify lazily, so a
// feed or search page pays it for the rows it returns, not the candidate set.
const MANAGED_STALE_MS = 60 * 1000;

// Where a session sorts on a CLI surface that ranks sessions an agent may
// message (`cast search`, `cast context`), below relevance: 0 = its prompt
// cache is still warm, 1 = the cache expired (a message rebuilds the whole
// context), 2 = retired (killed or completed). Old sessions keep their seat,
// since their history is worth reading; they only sort below recent ones.
export type RecencyRank = 0 | 1 | 2;

export function recencyRankOf(conv: any, now: number): RecencyRank {
  const cost = wakeCost({
    ...wakeFieldsOf(conv),
    updated_at: conv.updated_at,
    status: conv.status,
    inbox_killed_at: conv.inbox_killed_at,
  }, now);
  return cost.killed ? 2 : cost.cacheCold ? 1 : 0;
}

export function cliSessionClassifier(ctx: any, now: number) {
  const managedCache = new Map<string, any>();
  const classified = new Map<string, { work_state: WorkState; agent_status?: string }>();
  const armedHomesFor = armedTriggerHomeLoader(ctx);

  const managedFor = async (conv: any): Promise<any> => {
    const key = conv._id.toString();
    if (!managedCache.has(key)) {
      const managed = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
        .first();
      managedCache.set(key, managed ?? null);
    }
    return managedCache.get(key);
  };

  const isLiveManaged = (managed: any): boolean =>
    !!managed && managed.agent_status !== "hibernated" && (now - managed.last_heartbeat) < MANAGED_STALE_MS;

  const classify = async (conv: any): Promise<{ work_state: WorkState; agent_status?: string }> => {
    const cached = classified.get(conv._id.toString());
    if (cached) return cached;
    const managed = await managedFor(conv);
    const isLive = isLiveManaged(managed);
    const armedHomes = await armedHomesFor(conv.user_id);
    // Stop trusting a frozen "active" status once the conversation has gone
    // quiet past the trust TTL — the SAME coercion enrichInboxSessionRow does
    // at its enrichment boundary (see trustedAgentStatus). A live daemon that
    // finished re-asserts its last "working" on every heartbeat; without this
    // the feed pins the session in WORKING forever even though the inbox /
    // `cast monitor` (which read the coerced value) long since moved it to
    // needs-input. The heartbeatAlive leg uses the same 90s window as the inbox
    // maps (NOT the stricter 60s live window above) so both surfaces coerce
    // identically. The coerced status is returned so a displayed `agent_status`
    // agrees with the bucketed work_state.
    const heartbeatFresh =
      !!managed?.last_heartbeat && now - managed.last_heartbeat < HEARTBEAT_ALIVE_MS;
    const agentStatus = trustedAgentStatus(
      managed?.agent_status, conv.updated_at, now, heartbeatFresh,
      openTasksVouchForWaiting(managed?.open_tasks_at, managed?.open_tasks?.length ?? 0, heartbeatFresh),
    );
    const daemonAlive = agentStatus === "stopped" ? false : isLive;
    const hasPending = !!(conv as any).has_pending_messages;
    const activity = deriveSessionActivity({
      agentStatus,
      agentStatusUpdatedAt: managed?.agent_status_updated_at,
      lastMessageRole: (conv as any).last_message_role,
      lastMessagePreview: (conv as any).last_message_preview,
      hasPending,
      status: conv.status,
      updatedAt: conv.updated_at,
      daemonAlive,
      agentType: conv.agent_type,
      now,
    });
    let awaitingInput = false;
    if (((!activity.isIdle && isLive) || agentStatus === "hibernated") && (conv.message_count || 0) > 0) {
      const lastMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
        .order("desc")
        .first();
      if (lastMsg?.role === "assistant" && lastMsg.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion")) {
        awaitingInput = true;
      }
    }
    const ws = classifyWorkState({
      agentStatus,
      isIdle: activity.isIdle,
      awaitingInput,
      hasPending,
      isUnresponsive: activity.isUnresponsive,
      messageCount: conv.message_count || 0,
      killed: !!conv.inbox_killed_at,
      userRest: userRestOf(conv),
      armedTriggerHome: isArmedTriggerHome(conv, armedHomes.standing),
      armedLoopHome: isArmedLoopHome(conv, now),
      armedOnceTriggerHome: isArmedTriggerHome(conv, armedHomes.once),
      settleVerdict: isSettleVerdictCurrent(conv) ? conv.settle_verdict : null,
      declaredStatus: conv.thread_state_status ?? null,
      sessionBoundary: managed?.agent_status_boundary === true,
      pendingApiError: conv.pending_api_error === true,
      sessionError: !!conv.session_error,
    });
    const result = { work_state: ws, agent_status: agentStatus };
    classified.set(conv._id.toString(), result);
    return result;
  };

  // The liveness fields a CLI session row ships, in the shape formatStateBadge
  // reads: live + coerced status, work state, and the two retirement stamps.
  // `cast sessions -w` reads is_killed to emit a kill as a DEPARTURE from the
  // watched set rather than a work-state transition.
  const rowFields = async (conv: any) => {
    const managed = await managedFor(conv);
    const { work_state, agent_status } = await classify(conv);
    return {
      ...(isLiveManaged(managed) ? { is_live: true as const, agent_status: agent_status || undefined } : {}),
      work_state,
      ...(conv.inbox_killed_at ? { is_killed: true as const } : {}),
      ...(conv.status === "completed" ? { is_completed: true as const } : {}),
      recency_rank: recencyRankOf(conv, now),
    };
  };

  return { managedFor, isLiveManaged, classify, rowFields };
}
