// Row helpers more than one function module needs.
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { fail } from "./lib/errors";
import type { SystemNote } from "./validators";

export async function requireApp(ctx: QueryCtx, appId: Id<"apps">): Promise<Doc<"apps">> {
  return (await ctx.db.get(appId)) ?? fail("not_found", "That app does not exist.");
}

export async function appBySlug(ctx: QueryCtx, slug: string): Promise<Doc<"apps"> | null> {
  return ctx.db.query("apps").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
}

/** last_activity_at orders the gallery; it is written at most once a minute
 *  so chatter does not rewrite the app row every message. */
const ACTIVITY_WRITE_MS = 60_000;

export async function touchApp(ctx: MutationCtx, app: Doc<"apps">, now = Date.now()): Promise<void> {
  if (now - app.last_activity_at >= ACTIVITY_WRITE_MS) await ctx.db.patch(app._id, { last_activity_at: now });
}

/** Post a system note ("Raccoon forked v12 into Haiku Wall"). `body` is the
 *  plain-text fallback; the shell renders from `note`. */
export async function postSystemNote(ctx: MutationCtx, appId: Id<"apps">, note: SystemNote, body: string): Promise<Id<"messages">> {
  return ctx.db.insert("messages", { app_id: appId, kind: "system", body, note });
}
