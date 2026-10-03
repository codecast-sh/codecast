// The workspace's one app connector source, and keeping its manifest fresh.
// A leaf: ingest.ts and tokenConnectors.ts both use it, and sources/app.ts
// imports both of them.
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

/** The app source in a workspace, if it has one (at most one: createSource). */
export async function appSourceIn(ctx: { db: any }, workspace: string): Promise<Doc<"event_sources"> | null> {
  return await ctx.db
    .query("event_sources")
    .withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace))
    .filter((q: any) => q.eq(q.field("provider"), "app"))
    .first();
}

/**
 * Fetch the workspace's app manifest now, so readers and actions list as soon
 * as the source and its connection both exist, whichever came second (the
 * design's "connecting fetches and caches the manifest"). No app source: nothing.
 */
export async function refreshAppManifestSoon(ctx: { db: any; scheduler: any }, workspace: string): Promise<void> {
  const source = await appSourceIn(ctx, workspace);
  if (source) await ctx.scheduler.runAfter(0, internal.sources.app.refreshSourceManifest, { source_id: source._id });
}
