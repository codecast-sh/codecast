import type { Doc, Id } from "../_generated/dataModel";

type PR = Doc<"pull_requests">;

/**
 * `pull_requests.linked_session_ids` is the one home of which sessions a pull
 * request links. Convex cannot index an array, and a pull request row carries
 * its files, patches and commits (a single row reaches 1 MB), so answering
 * "which pull requests link this session" by scanning rows blows the 64 MB
 * function memory cap. `pull_request_sessions` is that array as an index: one
 * row per (pull request, session), rewritten from the array by
 * syncPullRequestSessions whenever the array is written, never by hand.
 */
export async function syncPullRequestSessions(ctx: { db: any }, pr: PR): Promise<void> {
  const want = new Set((pr.linked_session_ids ?? []).map(String));
  const rows = await ctx.db
    .query("pull_request_sessions")
    .withIndex("by_pull_request", (q: any) => q.eq("pull_request_id", pr._id))
    .collect();
  const have = new Set<string>();
  for (const row of rows) {
    const key = String(row.conversation_id);
    if (!want.has(key) || have.has(key)) await ctx.db.delete(row._id);
    else have.add(key);
  }
  for (const id of pr.linked_session_ids ?? []) {
    if (have.has(String(id))) continue;
    have.add(String(id));
    await ctx.db.insert("pull_request_sessions", { pull_request_id: pr._id, conversation_id: id });
  }
}

/** Every pull request that links the session. Access is the caller's to check. */
export async function pullRequestsLinkedToConversation(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<PR[]> {
  const rows = await ctx.db
    .query("pull_request_sessions")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  const prs = await Promise.all(rows.map((row: any) => ctx.db.get(row.pull_request_id)));
  return prs.filter((pr: PR | null): pr is PR => pr !== null);
}
