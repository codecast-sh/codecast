// Live cursors in an artifact: people's tabs and agent sessions. Ephemeral,
// so it writes straight here rather than through a store action: a cursor
// stream at ~12 sends a second is no edit to undo or replay.
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./functions";
import { PRESENCE_TTL_MS } from "@codecast/shared/artifacts";
import { liveArtifactValidators } from "./liveArtifactsSchema";
import { requireLiveDoc, resolveCaller, upsertPresence, vCaller } from "./lib/liveArtifactAccess";
import { ensureLiveSearch } from "./liveSearch";

const { vPosition } = liveArtifactValidators;

export const setPresence = mutation({
  args: {
    doc_id: v.id("docs"),
    /** A person's tab: one person in two tabs is two cursors. */
    tab: v.optional(v.string()),
    position: v.optional(vPosition),
    selection: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    ...vCaller,
  },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, args);
    await requireLiveDoc(ctx, caller.userId, args.doc_id);
    const actor = caller.kind === "agent" ? caller.actor : `${caller.actor}:${(args.tab ?? "cli").slice(0, 24)}`;
    await upsertPresence(ctx, args.doc_id, caller, actor, args);
    // An artifact written before search existed is indexed the first time someone opens it.
    if (!args.position && !args.selection) await ensureLiveSearch(ctx, args.doc_id);
    return null;
  },
});

export const leave = mutation({
  args: { doc_id: v.id("docs"), tab: v.optional(v.string()), ...vCaller },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, args);
    const actor = caller.kind === "agent" ? caller.actor : `${caller.actor}:${(args.tab ?? "cli").slice(0, 24)}`;
    const row = await ctx.db
      .query("live_presence")
      .withIndex("by_doc_actor", (q: any) => q.eq("doc_id", args.doc_id).eq("actor", actor))
      .first();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/** Everyone in the artifact now. Stale rows are left out (and swept on write). */
export const presence = query({
  args: { doc_id: v.id("docs"), ...vCaller },
  handler: async (ctx, args) => {
    try {
      const caller = await resolveCaller(ctx, args);
      await requireLiveDoc(ctx, caller.userId, args.doc_id);
    } catch {
      return null;
    }
    const now = Date.now();
    const rows = await ctx.db
      .query("live_presence")
      .withIndex("by_doc_updated", (q: any) => q.eq("doc_id", args.doc_id).gt("updated_at", now - PRESENCE_TTL_MS.agent))
      .order("desc")
      .take(100);
    return rows
      .filter((r) => now - r.updated_at < PRESENCE_TTL_MS[r.kind])
      .map((r) => ({
        doc_id: r.doc_id,
        actor: r.actor,
        kind: r.kind,
        name: r.name,
        color: r.color,
        image: r.image,
        session_id: r.session_id,
        session_short_id: r.session_short_id,
        position: r.position,
        selection: r.selection,
        status: r.status,
        updated_at: r.updated_at,
      }));
  },
});
