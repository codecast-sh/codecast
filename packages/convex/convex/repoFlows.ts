// A repository's own flows as the viewer's checkouts report them (schema
// repo_flows, shared/contracts/repoFlows.ts). A checkout reports at session
// start (cli workflow/repoFlowsReport.ts) only when its flows changed; the
// web's Ship picker puts them ahead of the shipped flows of the same slug for a
// session in that repository, because that is what `cast flow run` runs there.
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

/** How many flows one repository may report: a `.codecast/flows` holds a few. */
const MAX_FLOWS = 40;

/** `/cli/repo-flows/report`: replace the reporter's flows for one repository; none removes its row. */
export const report = mutation({
  args: { api_token: v.string(), repository: v.string(), hash: v.string(), flows: v.array(repoFlowValidator) },
  handler: async (ctx, { api_token, repository, hash, flows }) => {
    const auth = await verifyApiToken(ctx, api_token);
    if (!auth) return { error: "Unauthorized" };
    if (!repository.trim()) return { error: "No repository" };
    if (flows.length > MAX_FLOWS) return { error: `A repository reports at most ${MAX_FLOWS} flows` };
    const row = await ctx.db
      .query("repo_flows")
      .withIndex("by_user_repository", (q) => q.eq("user_id", auth.userId).eq("repository", repository))
      .first();
    if (!flows.length) {
      if (row) await ctx.db.delete(row._id);
      return { ok: true };
    }
    if (row?.hash === hash) return { ok: true, unchanged: true };
    const now = Date.now();
    if (row) await ctx.db.patch(row._id, { hash, flows, updated_at: now });
    else await ctx.db.insert("repo_flows", { user_id: auth.userId, repository, hash, flows, updated_at: now });
    return { ok: true };
  },
});

/** The viewer's repositories' own flows, one row per repository. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("repo_flows").withIndex("by_user_repository", (q) => q.eq("user_id", userId)).collect();
    return rows.map((r) => ({ _id: r._id, repository: r.repository, flows: r.flows, updated_at: r.updated_at }));
  },
});
