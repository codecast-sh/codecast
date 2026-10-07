// A version's still: the picture the gallery shows of it. Convex cannot open
// a page, so the first screen that shows a version takes it (the runtime
// draws its own document, runtime/capture.ts) and uploads it here. A still
// is set once and never replaced, and the author's own screen gets the
// first chance, so a stranger racing to picture an app gets nowhere.
import { v } from "convex/values";
import { internalMutation, mutation, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { STILL_AUTHOR_FIRST_MS, STILL_MAX_BYTES, STILL_TYPES } from "./lib/limits";
import { takeRate } from "./limits";
import { shownVersion } from "./versions";
import { requireVisitor } from "./visitors";
import { visitorArgs } from "./validators";

/** The version a visitor may picture now, or null. */
async function wantsStill(ctx: QueryCtx, appId: Id<"apps">, number: number, visitorId: Id<"visitors">): Promise<Doc<"versions"> | null> {
  const version = await shownVersion(ctx, appId, number);
  if (!version || version.still) return null;
  const authorsTurn = Date.now() - version.created_at < STILL_AUTHOR_FIRST_MS;
  return authorsTurn && version.author_id !== visitorId ? null : version;
}

/** Where to upload a still of this version, or null when it needs none from you. */
export const uploadUrl = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), number: v.number() },
  handler: async (ctx, args): Promise<string | null> => {
    const visitor = await requireVisitor(ctx, args);
    if (!(await wantsStill(ctx, args.app_id, args.number, visitor._id))) return null;
    await takeRate(ctx, "still", visitor._id);
    return ctx.storage.generateUploadUrl();
  },
});

/** Set an uploaded image as the version's still. An image that is not
 *  wanted, too big or not an image is deleted rather than kept. */
export const attach = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), number: v.number(), storage_id: v.id("_storage") },
  handler: async (ctx, args): Promise<boolean> => {
    const visitor = await requireVisitor(ctx, args);
    const file = await ctx.db.system.get(args.storage_id);
    const version = await wantsStill(ctx, args.app_id, args.number, visitor._id);
    const fits = !!file && file.size <= STILL_MAX_BYTES && STILL_TYPES.includes(file.contentType ?? "");
    if (!version || !fits) {
      if (file) await ctx.storage.delete(args.storage_id);
      return false;
    }
    await ctx.db.patch(version._id, { still: args.storage_id });
    return true;
  },
});

/** A still's public URL, for the gallery and link previews. */
export async function stillUrl(ctx: QueryCtx, version: Doc<"versions"> | null): Promise<string | null> {
  return version?.still ? ctx.storage.getUrl(version.still) : null;
}

const RETAKE_BATCH = 200;

/** Drop the latest versions' stills so screens take them again, after a change to
 *  how pictures are drawn (runtime/capture.ts):
 *  npx convex run stills:retake   (repeat until it returns 0) */
export const retake = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const pictured = (await ctx.db.query("versions").order("desc").take(RETAKE_BATCH * 5)).filter((v) => v.still).slice(0, RETAKE_BATCH);
    for (const v of pictured) {
      await ctx.storage.delete(v.still!);
      await ctx.db.patch(v._id, { still: undefined });
    }
    return pictured.length;
  },
});
