// Finding recordings in the imported store (docs/architecture/external-data.md X5):
// `cast replay ls`'s paged search with its filters, what a source holds for
// `cast replay import --status`, and a vendor's recording id looked up for
// show, snap and repro (sources/replayResolve.ts imports one the store lacks).
import { v } from "convex/values";
import { internalQuery, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "./lib/ingestScope";
import { sourceViewOf } from "./lib/sourceStats";
import { readableReplay, searchCore, storedCore } from "./lib/replayReads";
import { findReplay } from "./lib/replayWrites";

/**
 * `cast replay ls` over the imported store (/cli/replays/search): one page of
 * the scope's recordings and the matches in it (searchCore). The CLI follows
 * the cursor to the end, so nothing past a page is left out.
 */
export const search = query({
  args: {
    ...scopeArgs,
    source: v.optional(v.string()),
    group_id: v.optional(v.id("event_groups")),
    url: v.optional(v.string()),
    user: v.optional(v.string()),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
    failing: v.optional(v.boolean()),
    active_min_ms: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const { cursor, api_token: _t, workspace: _w, team_id: _team, project_path: _p, conversation_id: _c, ...filter } = args;
    return await searchCore(ctx, userId, workspaceKey, filter, cursor ?? null);
  },
});

/** `cast replay import --status` (/cli/replays/import-status): the source with its import, and what it holds in the store. */
export const importStatus = query({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    return { source: await sourceViewOf(ctx, source), stored: await storedCore(ctx, workspaceKey, source._id) };
  },
});

/**
 * A vendor's recording id (PostHog session id, Sentry replay id) in the
 * caller's workspace: the replay that holds it, else the vendor sources that
 * could, for sources/replayResolve.ts to import it from.
 */
export const byExternalId = internalQuery({
  args: { ...scopeArgs, external_id: v.string() },
  handler: async (ctx, args): Promise<{ short_id: string | null; sources: { source_id: Id<"event_sources">; name: string; provider: string }[] }> => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    // A replay's own Convex id reads as itself.
    const own = await readableReplay(ctx, userId, args.external_id.trim()).catch(() => null);
    if (own && own.workspace === workspaceKey) return { short_id: own.short_id, sources: [] };
    const sources: Doc<"event_sources">[] = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", workspaceKey)).collect();
    for (const s of sources) {
      const row = await findReplay(ctx, s._id, args.external_id.trim());
      if (row && row.workspace === workspaceKey) return { short_id: row.short_id, sources: [] };
    }
    return { short_id: null, sources: sources.filter((s) => s.provider === "posthog" || s.provider === "sentry").map((s) => ({ source_id: s._id, name: s.name, provider: s.provider })) };
  },
});
