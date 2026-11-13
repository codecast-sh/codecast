// Which sessions a search's caller is, and which sessions are its workers.
// Shared by searchForCLI and findSimilar (cast search, cast context, cast ask),
// so "leave out the caller" means the same thing on every path.
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// The session a worker's results belong under: a subagent's parent, or the
// primary session of the workflow run a workflow sub ran in.
export async function searchParentId(
  ctx: QueryCtx,
  conv: Doc<"conversations">,
): Promise<Id<"conversations"> | undefined> {
  if (conv.parent_conversation_id) return conv.parent_conversation_id;
  if (conv.is_workflow_sub && conv.workflow_run_id) {
    const run = await ctx.db.get(conv.workflow_run_id);
    const parent = run?.primary_conversation_id ?? run?.spawner_conversation_id;
    return parent && parent !== conv._id ? parent : undefined;
  }
  return undefined;
}

// The session a search runs from, on the evidence the CLI sends: the agent's
// own session uuid first, since a headless child inherits its parent's
// exported conversation id and would otherwise leave out its parent's whole
// family; the exported conversation id when the uuid names nothing yet (a
// session that has not synced). Only a session the caller owns counts.
export async function resolveSearchSelf(
  ctx: QueryCtx,
  userId: Id<"users">,
  ref: { conversation_id?: string; session_id?: string },
): Promise<Id<"conversations"> | null> {
  const sessionId = ref.session_id;
  if (sessionId) {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
      .take(10);
    const own = rows.find((c) => c.user_id === userId);
    if (own) return own._id;
  }
  const byId = ref.conversation_id ? ctx.db.normalizeId("conversations", ref.conversation_id) : null;
  if (!byId) return null;
  const conv = await ctx.db.get(byId);
  return conv && conv.user_id === userId ? conv._id : null;
}

// Whether a conversation is the calling session or one of its workers
// (subagents, workflow subs), walking up the same parent links search folds
// workers by. A session's own words are not prior work: they would fill the
// page with what it just said.
export function selfFamilyTest(ctx: QueryCtx, selfId: Id<"conversations">) {
  const memo = new Map<string, boolean>();
  return async (conv: Doc<"conversations">): Promise<boolean> => {
    const key = conv._id.toString();
    const known = memo.get(key);
    if (known !== undefined) return known;
    let at: Doc<"conversations"> | null = conv;
    let inFamily = false;
    for (let hops = 0; at && hops < 5; hops++) {
      if (at._id === selfId) { inFamily = true; break; }
      const cached = memo.get(at._id.toString());
      if (cached !== undefined) { inFamily = cached; break; }
      const parentId = await searchParentId(ctx, at);
      at = parentId ? await ctx.db.get(parentId) : null;
    }
    memo.set(key, inFamily);
    return inFamily;
  };
}
