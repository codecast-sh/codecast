import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isDaemonManagedRow, listLiveManagedSessions } from "./lib/liveSessions";

// The row set behind the /sessions page, which managedSessions.listActiveSessions
// serves. Split from the query wrapper (like performRegisterManagedSession) so
// the projection is testable without auth.
export async function performListActiveSessions(ctx: { db: QueryCtx["db"] }, userId: Id<"users">) {
  const recent = await listLiveManagedSessions(ctx, userId, { aliveMs: 24 * 60 * 60 * 1000 });
  const parked = await ctx.db.query("managed_sessions")
    .withIndex("by_user_status", q => q.eq("user_id", userId).eq("agent_status", "hibernated"))
    .collect();
  // The process monitor: a hosted row has no process to show or kill.
  const sessions = [...new Map([...recent, ...parked].map(s => [s._id, s])).values()].filter(isDaemonManagedRow);

  const results = [];
  for (const session of sessions) {
    let conversationTitle: string | undefined;
    let projectPath: string | undefined;
    let agentType: string | undefined;
    let messageCount: number | undefined;
    let conversationStatus: string | undefined;
    let model: string | undefined;
    let gitBranch: string | undefined;
    let worktreeName: string | undefined;
    let headline: string | undefined;
    let isSubagent: boolean | undefined;
    let conversationUpdatedAt: number | undefined;
    let lastMessagePreview: string | undefined;
    let lastMessageRole: string | undefined;
    let isKilled = false;
    let ownerDeviceId: string | undefined;

    if (session.conversation_id) {
      const conv = await ctx.db.get(session.conversation_id);
      if (conv) {
        // Killed rows are LISTED, not skipped. This is the process/tmux view,
        // not the inbox: hiding a retired row here means killing from
        // /sessions makes it vanish instantly, so a teardown that didn't take
        // leaves the session invisible on the one surface built to catch that
        // — while its tmux and process may still be alive and heartbeating.
        // The 24h last_heartbeat cutoff above is the bound: a session whose
        // teardown succeeded stops beating and ages out on its own.
        isKilled = !!conv.inbox_killed_at;
        ownerDeviceId = conv.user_id === userId ? conv.owner_device_id : undefined;
        conversationTitle = conv.title;
        projectPath = conv.project_path;
        agentType = conv.agent_type;
        messageCount = conv.message_count;
        conversationStatus = conv.status;
        model = conv.model;
        gitBranch = conv.git_branch;
        worktreeName = conv.worktree_name;
        isSubagent = conv.is_subagent;
        // updated_at moves on real conversation activity (messages, status) but
        // NOT on idle heartbeats or metrics writes — the honest "last active"
        // signal. The preview/role give every row something identifiable even
        // when no insight headline exists (common for short/dead sessions).
        conversationUpdatedAt = conv.updated_at;
        lastMessagePreview = conv.last_message_preview;
        lastMessageRole = conv.last_message_role;

        const insight = await ctx.db
          .query("session_insights")
          .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", session.conversation_id))
          .order("desc")
          .first();
        if (insight) {
          headline = insight.headline || insight.summary?.slice(0, 120);
        }
      }
    }

    // The current_* copies on the registry doc are throttled to a ~5min write
    // (SNAPSHOT_THROTTLE_MS in reportMetrics) to keep listInboxSessions' read
    // set stable. That staleness is fine for the inbox but wrong for this
    // monitoring view, which sorts and sums these numbers. Read the freshest
    // time-series sample instead (≤30s old for active sessions, ≤3min for
    // idle) and prefer it. This page is the ONLY consumer of
    // listActiveSessions, so the extra per-session read never touches the hot
    // inbox subscription the throttle exists to protect.
    const latestMetric = await ctx.db
      .query("session_metrics")
      .withIndex("by_session_collected", (q: any) => q.eq("session_id", session.session_id))
      .order("desc")
      .first();

    results.push({
      _id: session._id,
      session_id: session.session_id,
      conversation_id: session.conversation_id,
      pid: session.pid,
      tmux_session: session.tmux_session,
      started_at: session.started_at,
      last_heartbeat: session.last_heartbeat,
      agent_status: session.agent_status,
      agent_status_updated_at: session.agent_status_updated_at,
      hibernated_at: session.hibernated_at,
      user_id: session.user_id,
      owner_device_id: ownerDeviceId,
      permission_mode: session.permission_mode,
      // Prefer the freshest sample; fall back to the throttled snapshot only
      // when no time-series row survives the 2h retention (e.g. long-idle).
      current_cpu: latestMetric?.cpu ?? session.current_cpu,
      current_memory: latestMetric?.memory ?? session.current_memory,
      current_pid_count: latestMetric?.pid_count ?? session.current_pid_count,
      agent_pid: session.agent_pid,
      awake_idle_ms: session.awake_idle_ms,
      // Honest "as of" for the displayed metrics: the sample time, not the
      // throttled snapshot time.
      last_metrics_at: latestMetric?.collected_at ?? session.last_metrics_at,
      conversation_title: conversationTitle,
      project_path: projectPath,
      agent_type: agentType,
      message_count: messageCount,
      conversation_status: conversationStatus,
      model,
      git_branch: gitBranch,
      worktree_name: worktreeName,
      headline,
      is_subagent: isSubagent,
      conversation_updated_at: conversationUpdatedAt,
      last_message_preview: lastMessagePreview,
      last_message_role: lastMessageRole,
      // Authoritative killed state for the page, straight off the row. The
      // page's triage join (listInboxSessions) CANNOT supply it: that query
      // applies shouldShowInInbox unconditionally, which drops a killed-and-
      // unpinned row — exactly the rows revealed here. Same reason it beats the
      // join for the subagent/orphan rows that filter also drops. The
      // conversation doc is already fetched above, so this costs no extra read.
      is_killed: isKilled,
    });
  }

  return results;
}
