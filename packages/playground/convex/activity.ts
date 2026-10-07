// The home page's "Right now" feed (DESIGN 6.1): the latest versions made
// anywhere in Clayground, each said as who did what to which app. One person
// changing one app is one row, their latest change, however many they made.
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { versionSaid } from "./lib/versions";
import { publicVisitors, requireVisitor, type PublicVisitor } from "./visitors";
import { visitorArgs } from "./validators";

const FEED_MAX = 5;
/** Versions read to fill the feed after folding runs together. */
const FEED_SCAN = 40;

export type ActivityEvent = {
  id: Id<"versions">;
  at: number;
  who: PublicVisitor | null;
  /** What they did, said after their name: "made it", "turns it blue". */
  said: string;
  slug: string;
  app_name: string;
  /** This version is its app's live one. */
  live: boolean;
};

export const recent = query({
  args: { ...visitorArgs },
  handler: async (ctx, args): Promise<ActivityEvent[]> => {
    await requireVisitor(ctx, args);
    const scanned = await ctx.db.query("versions").order("desc").take(FEED_SCAN);
    // v0 is a starter nobody sees; the first build says "made it".
    const seen = new Set<string>();
    const shown = scanned
      .filter((r) => {
        const key = `${r.app_id}:${r.author_id}`;
        if (r.number === 0 || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, FEED_MAX);
    const people = await publicVisitors(ctx, shown.map((r) => r.author_id));
    const events = await Promise.all(
      shown.map(async (row): Promise<ActivityEvent | null> => {
        const app = await ctx.db.get(row.app_id);
        if (!app) return null;
        const source = row.kind === "fork" && row.source ? await ctx.db.get(row.source.app_id) : null;
        return {
          id: row._id,
          at: row.created_at,
          who: people.get(row.author_id) ?? null,
          said: versionSaid(row, source?.name ?? null),
          slug: app.slug,
          app_name: app.name,
          live: app.live_version === row.number,
        };
      }),
    );
    return events.filter((e) => e !== null);
  },
});
