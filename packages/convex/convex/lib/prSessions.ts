import type { Doc, Id } from "../_generated/dataModel";

type PR = Doc<"pull_requests">;
export type PrLinkTier = "observed" | "committed";
const TIER_RANK: Record<PrLinkTier, number> = { observed: 0, committed: 1 };
const tierOf = (row: { tier?: PrLinkTier }): PrLinkTier => row.tier ?? "observed";

/**
 * `pull_requests.linked_session_ids` is the one home of which sessions a pull
 * request links. Convex cannot index an array, and a pull request row carries
 * its files, patches and commits (a single row reaches 1 MB), so answering
 * "which pull requests link this session" by scanning rows blows the 64 MB
 * function memory cap. `pull_request_sessions` is that array as an index: one
 * row per (pull request, session), rewritten from the array by
 * syncPullRequestSessions whenever the array is written, never by hand.
 *
 * Each row also carries the link's tier. "observed" means the session sat on
 * the pull request's branch; "committed" means a commit on the pull request is
 * the session's own. A stronger link replaces a weaker one and never the
 * reverse: rewriting the array keeps a row's tier, and linkPullRequestSessions
 * only ever raises it.
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
    await ctx.db.insert("pull_request_sessions", { pull_request_id: pr._id, conversation_id: id, tier: "observed" });
  }
}

/**
 * Link sessions to a pull request at `tier`: each joins the array if it is
 * missing, and its row's tier rises to `tier` if it was weaker. Returns the
 * pull request as it now stands.
 */
export async function linkPullRequestSessions(
  ctx: { db: any },
  prId: Id<"pull_requests">,
  conversationIds: Id<"conversations">[],
  tier: PrLinkTier,
): Promise<PR | null> {
  const pr: PR | null = await ctx.db.get(prId);
  if (!pr) return null;
  const linked = new Set((pr.linked_session_ids ?? []).map(String));
  const added: Id<"conversations">[] = [];
  for (const id of conversationIds) {
    if (linked.has(String(id))) continue;
    linked.add(String(id));
    added.push(id);
  }
  if (added.length) await ctx.db.patch(prId, { linked_session_ids: [...(pr.linked_session_ids ?? []), ...added] });
  const current: PR = added.length ? await ctx.db.get(prId) : pr;
  await syncPullRequestSessions(ctx, current);
  const want = new Set(conversationIds.map(String));
  const rows = await ctx.db
    .query("pull_request_sessions")
    .withIndex("by_pull_request", (q: any) => q.eq("pull_request_id", prId))
    .collect();
  for (const row of rows) {
    if (want.has(String(row.conversation_id)) && TIER_RANK[tier] > TIER_RANK[tierOf(row)]) await ctx.db.patch(row._id, { tier });
  }
  return current;
}

/** The sessions whose own commit is on the pull request. */
export async function committedSessionIds(ctx: { db: any }, prId: Id<"pull_requests">): Promise<Id<"conversations">[]> {
  const rows = await ctx.db
    .query("pull_request_sessions")
    .withIndex("by_pull_request", (q: any) => q.eq("pull_request_id", prId))
    .collect();
  return rows.filter((row: any) => tierOf(row) === "committed").map((row: any) => row.conversation_id);
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
