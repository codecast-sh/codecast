// A checkout's own flows as the viewer's machines report them (schema
// checkout_flows, shared/contracts/repoFlows.ts). A checkout reports at session
// start (cli workflow/repoFlowsReport.ts) only when its flows changed; the
// web's Ship picker reads the row of the session's checkout and puts its flows
// ahead of the shipped ones of the same slug, because that is what `cast flow
// run` runs there.
import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";

const repoFlowValidator = v.object({
  slug: v.string(),
  name: v.string(),
  kind: v.union(v.literal("line"), v.literal("segment")),
  label: v.string(),
  description: v.union(v.string(), v.null()),
  takes: v.array(v.string()),
  nodes: v.array(v.any()),
  edges: v.array(v.object({ from: v.string(), to: v.string(), label: v.optional(v.string()), condition: v.optional(v.string()) })),
});

/** How many flows one checkout may report: a `.codecast/flows` holds a few. */
const MAX_FLOWS = 40;
/** A checkout not reported for this long is gone (a removed worktree): a report from its repository drops its row.
 *  A live checkout reports at least daily (repoFlowsReport.ts RESEND_MS). */
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** `/cli/repo-flows/report`: replace the reporter's flows for one checkout, an empty list included. */
export const report = mutation({
  args: { api_token: v.string(), root: v.string(), repository: v.string(), hash: v.string(), flows: v.array(repoFlowValidator) },
  handler: async (ctx, { api_token, root, repository, hash, flows }) => {
    const auth = await verifyApiToken(ctx, api_token);
    if (!auth) return { error: "Unauthorized" };
    if (!root.trim() || !repository.trim()) return { error: "No checkout" };
    if (flows.length > MAX_FLOWS) return { error: `A checkout reports at most ${MAX_FLOWS} flows` };
    const now = Date.now();
    const stale = await ctx.db
      .query("checkout_flows")
      .withIndex("by_user_repository_updated", (q) => q.eq("user_id", auth.userId).eq("repository", repository).lt("updated_at", now - STALE_MS))
      .take(20);
    for (const r of stale) if (r.root !== root) await ctx.db.delete(r._id);
    const row = await ctx.db.query("checkout_flows").withIndex("by_user_root", (q) => q.eq("user_id", auth.userId).eq("root", root)).first();
    // A checkout with no flows keeps its row, with none: it runs the shipped flows, never another worktree's.
    // An unchanged report still says the checkout is alive (the CLI sends one a day), so it outlives the prune above.
    if (row?.hash === hash) {
      await ctx.db.patch(row._id, { updated_at: now });
      return { ok: true, unchanged: true };
    }
    if (row) await ctx.db.patch(row._id, { repository, hash, flows, updated_at: now });
    else await ctx.db.insert("checkout_flows", { user_id: auth.userId, root, repository, hash, flows, updated_at: now });
    return { ok: true };
  },
});

/** The viewer's report for one checkout, else the newest report of its repository; at most one row. */
export const forCheckout = query({
  args: { root: v.union(v.string(), v.null()), repository: v.union(v.string(), v.null()) },
  handler: async (ctx, { root, repository }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const own = root ? await ctx.db.query("checkout_flows").withIndex("by_user_root", (q) => q.eq("user_id", userId).eq("root", root)).first() : null;
    const row = own ?? (repository ? await ctx.db.query("checkout_flows").withIndex("by_user_repository_updated", (q) => q.eq("user_id", userId).eq("repository", repository)).order("desc").first() : null);
    return row ? [{ _id: row._id, root: row.root, repository: row.repository, flows: row.flows, updated_at: row.updated_at }] : [];
  },
});
