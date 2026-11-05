import { findConversationByAnyRef } from "../conversationSessionLookup";

// Attach each agent's synced conversation to its node status so run UIs can render
// a clickable session list. The daemon uploads per-agent transcripts
// (<session>/subagents/workflows/<wf_id>/agent-<id>.jsonl) as conversations keyed
// session_id="agent-<id>", so dynamic-workflow nodes resolve deterministically even on
// runs ingested before session_id stamping; routine/graph nodes carry a real session_id
// already. `budget` caps conversation lookups so list queries stay bounded — runs are
// enriched most-recent-first and older ones degrade to plain (non-clickable) rows.
/** `cast task handoff`'s comment (taskClaim.handoffCommentText): "Handoff: <status>", a blank line, the evidence. */
const HANDOFF_COMMENT = /^Handoff: (\w+)\s*\n?([\s\S]*)$/;

/** Each station session's last handoff on the run's task, by conversation id:
 *  how a builder ended (done, blocked, needs_context) is its handoff, which
 *  lives on the task, not on the session. */
async function handoffsByConversation(ctx: any, run: any, budget: { reads: number }): Promise<Map<string, { status: string; note: string; at: number }>> {
  const out = new Map<string, { status: string; note: string; at: number }>();
  if (!run.task_id || !run.node_statuses.some((n: any) => n.session_id) || budget.reads <= 0) return out;
  budget.reads--;
  const comments = await ctx.db.query("task_comments")
    .withIndex("by_task_created", (q: any) => q.eq("task_id", run.task_id))
    .order("desc")
    .take(200);
  for (const c of comments) {
    const m = c.conversation_id && c.comment_type === "review" ? String(c.text ?? "").match(HANDOFF_COMMENT) : null;
    // The note is what a person reads in place of the station's last line (the evidence, what it tried, what it needs):
    // kept whole up to a page, never cut mid-thought at a preview's length.
    if (m && !out.has(String(c.conversation_id))) out.set(String(c.conversation_id), { status: m[1], note: m[2].trim().slice(0, 4000), at: c.created_at });
  }
  return out;
}

export async function withAgentSessions(ctx: any, run: any, budget = { reads: 200 }) {
  if (!run?.node_statuses?.length) return run;
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const handoffs = await handoffsByConversation(ctx, run, budget);
  const node_statuses = await Promise.all(run.node_statuses.map(async (node: any) => {
    const sessionId = node.session_id
      || (run.run_kind === "workflow" && node.node_id ? `agent-${node.node_id}` : null);
    if (!sessionId || budget.reads <= 0) return node;
    budget.reads--;
    // A line station's node carries its hand's short id (runner spawnHand), a
    // dynamic workflow's agent its session id: any ref resolves, the run's own user's only.
    const conv: any = await findConversationByAnyRef(ctx, sessionId, run.user_id);
    if (!conv) return node;
    const handoff = handoffs.get(String(conv._id));
    return {
      ...node,
      session: {
        _id: conv._id,
        session_id: conv.session_id,
        title: conv.title || conv.subtitle,
        project_path: conv.project_path,
        message_count: conv.message_count || 0,
        is_active: conv.status === "active" && (conv.updated_at || 0) > fiveMinutesAgo,
        started_at: conv.started_at || conv._creationTime,
        updated_at: conv.updated_at,
        agent_type: conv.agent_type,
        parent_conversation_id: conv.parent_conversation_id,
        // What the station reported (`cast state`): the run report words a
        // station by its own report, not by its node id.
        state: conv.thread_state,
        state_status: conv.thread_state_status,
        result: conv.thread_state_result,
        // What happened to it: killed (with no message, it never started) and how it handed off.
        ...(conv.inbox_killed_at ? { killed: true } : {}),
        ...(handoff ? { handoff } : {}),
      },
    };
  }));
  return { ...run, node_statuses };
}
