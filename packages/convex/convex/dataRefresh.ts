// Data dashboards (ct-91886): keeping a dashboard's numbers fresh. The open
// page (and a share link) calls these on mount and every minute; each one
// records the queries the blocks bind to and leases one refresh per answer
// past its interval (dataQueries.wantCore). They are refresh requests, not
// edits: the rows they touch reach the page through dataQueries.results.

import { v, ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation } from "./functions";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { readLiveElements } from "./liveArtifacts";
import { dashboardDoc, wantCore } from "./dataQueries";

const vQuery = v.object({ source: v.string(), args: v.optional(v.any()), refresh: v.optional(v.string()) });

export const want = mutation({
  args: { doc_id: v.id("docs"), queries: v.array(vQuery) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Not authenticated" });
    const doc = await dashboardDoc(ctx, userId, args.doc_id);
    return { leased: await wantCore(ctx, userId, doc, args.queries as dashboard.DataQuery[], Date.now()) };
  },
});

/**
 * The shared (link) view keeps its numbers fresh the same way, without an
 * account: the server reads the dashboard's saved blocks itself (never the
 * draft), so a link holder can only refresh what the dashboard already binds.
 * A query nobody bound yet would run as the doc's owner.
 */
export const wantShared = mutation({
  args: { doc_id: v.id("docs"), share_token: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.doc_id);
    if (!doc || doc.doc_type !== "dashboard" || !doc.share_token || doc.share_token !== args.share_token || doc.archived_at) return { leased: [] };
    const blocks = (await readLiveElements(ctx, doc._id, "main")) as ArtifactElement[];
    return { leased: await wantCore(ctx, doc.user_id, doc, [...dashboard.dashboardQueries(blocks).values()], Date.now()) };
  },
});
