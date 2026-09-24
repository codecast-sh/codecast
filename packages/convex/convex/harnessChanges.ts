// The change history of each device's agent harness: every write codecast
// made to CLAUDE.md, the hooks or ~/.claude/settings.json on that machine,
// with the action that caused it. The daemon records them locally
// (packages/cli/src/harness.ts) and attaches the unsent ones to its heartbeat;
// the /cli/heartbeat route forwards them here, after presence, so a failure
// never costs the machine its heartbeat.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthenticatedUserId } from "./pendingMessages";

/** Kept per device. The page shows the newest; older rows are pruned on write. */
const KEEP_PER_DEVICE = 300;
/** One beat's worth; the daemon sends at most 50. */
const MAX_PER_REPORT = 100;

const changeValidator = v.object({
  at: v.number(),
  file: v.string(),
  action: v.union(v.literal("created"), v.literal("modified"), v.literal("removed")),
  what: v.string(),
  why: v.string(),
  automatic: v.boolean(),
  version: v.string(),
  bytes_before: v.number(),
  bytes_after: v.number(),
});

export const report = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    changes: v.array(changeValidator),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const changes = args.changes.slice(0, MAX_PER_REPORT);
    if (changes.length === 0) return { inserted: 0 };

    // A beat whose response was lost is sent again. Drop what is already
    // stored: same time, file and part of the file is the same change.
    const oldest = Math.min(...changes.map((c) => c.at));
    const stored = await ctx.db
      .query("harness_changes")
      .withIndex("by_user_device_at", (q) => q.eq("user_id", userId).eq("device_id", args.device_id).gte("at", oldest))
      .collect();
    const seen = new Set(stored.map((r) => `${r.at}|${r.file}|${r.what}|${r.action}`));

    let inserted = 0;
    for (const c of changes) {
      const key = `${c.at}|${c.file}|${c.what}|${c.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.db.insert("harness_changes", {
        user_id: userId,
        device_id: args.device_id,
        at: c.at,
        file: c.file.slice(0, 400),
        action: c.action,
        what: c.what.slice(0, 80),
        why: c.why.slice(0, 200),
        automatic: c.automatic,
        version: c.version.slice(0, 40),
        bytes_before: c.bytes_before,
        bytes_after: c.bytes_after,
      });
      inserted++;
    }

    if (inserted > 0) {
      const beyond = await ctx.db
        .query("harness_changes")
        .withIndex("by_user_device_at", (q) => q.eq("user_id", userId).eq("device_id", args.device_id))
        .order("desc")
        .collect();
      for (const row of beyond.slice(KEEP_PER_DEVICE)) await ctx.db.delete(row._id);
    }
    return { inserted };
  },
});

/** Newest first. */
export const listForDevice = query({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 100, KEEP_PER_DEVICE));
    const rows = await ctx.db
      .query("harness_changes")
      .withIndex("by_user_device_at", (q) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .order("desc")
      .take(limit);
    return rows.map((r) => ({
      _id: r._id,
      device_id: r.device_id,
      at: r.at,
      file: r.file,
      action: r.action,
      what: r.what,
      why: r.why,
      automatic: r.automatic,
      version: r.version,
      bytes_before: r.bytes_before,
      bytes_after: r.bytes_after,
    }));
  },
});
