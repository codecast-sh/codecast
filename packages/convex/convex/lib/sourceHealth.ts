// A polled source's connection health (docs/architecture/external-data.md X1,
// "Lost connections"). One rule for every adapter that polls through a
// connection (app watches, the Sentry poll, PostHog metric watches): a poll
// that finds no connection, or a vendor that refuses the token, puts the
// source in `error` with the reason on `last_error`. Every poller reads only
// active sources, so polling stops there instead of failing (and auditing)
// on every tick. Storing a connection again resumes the workspace's errored
// sources of that provider, and so does a person's resume.
// A leaf: ingest.ts, tokenConnectors.ts and the adapters all use it.
import type { Doc } from "../_generated/dataModel";
import { refreshAppManifestSoon } from "./appSource";

/** A vendor answer that means the credential no longer works: no retry will fix it. */
export const isTokenRefusal = (status: number | undefined): boolean => status === 401 || status === 403;

const ERROR_CHARS = 500;

/**
 * The source stops on its lost connection, naming the cause. A paused source
 * stays paused (a person's pause outranks a poller's error); a repeat of the
 * same error writes nothing.
 */
export async function markConnectionLost(ctx: { db: any }, source: Doc<"event_sources">, error: string, now = Date.now()): Promise<boolean> {
  if (source.status === "paused") return false;
  const last_error = error.slice(0, ERROR_CHARS);
  if (source.status === "error" && source.last_error === last_error) return false;
  await ctx.db.patch(source._id, { status: "error", last_error, updated_at: now });
  return true;
}

/**
 * A connection was stored for `provider` in `workspace`: every source of that
 * provider there that stopped on an error polls again at once. A source that
 * named a connection row since deleted reads through the workspace's current
 * one from now on (tokenConnectors.connectionIdForSource). An app source
 * also refetches its manifest.
 */
export async function resumeSourcesOnConnect(ctx: { db: any; scheduler: any }, provider: string, workspace: string, now = Date.now()): Promise<number> {
  const rows: Doc<"event_sources">[] = await ctx.db
    .query("event_sources")
    .withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace))
    .take(500);
  let resumed = 0;
  for (const row of rows) {
    if (row.provider !== provider || row.status !== "error") continue;
    const named = row.connection_id ? await ctx.db.get(row.connection_id) : null;
    await ctx.db.patch(row._id, {
      status: "active",
      last_error: undefined,
      updated_at: now,
      ...(row.connection_id && !named ? { connection_id: undefined } : {}),
      ...(provider === "app" ? { next_watch_at: now } : {}),
    });
    resumed++;
  }
  if (provider === "app") await refreshAppManifestSoon(ctx, workspace);
  return resumed;
}
