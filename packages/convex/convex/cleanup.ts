import { internalMutation } from "./_generated/server";

export const clearRateLimits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const limits = await ctx.db.query("rate_limits").collect();
    for (const limit of limits) {
      await ctx.db.delete(limit._id);
    }
    return `Cleared ${limits.length} rate limit records`;
  },
});

// One-time cleanup mutation to delete orphan tables
// Run with: npx convex run cleanup:deleteOrphanTables
export const deleteOrphanTables = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orphanTables = [
      "activity",
      "activityChunk",
      "contacts",
      "credentials",
      "emailDrafts",
      "integrations",
      "jobs",
      "reminders",
      "tasks",
      "typingPresence",
      "userCalendarPrefs",
    ];

    for (const tableName of orphanTables) {
      try {
        // @ts-ignore - accessing tables not in schema
        const docs = await ctx.db.query(tableName).collect();
        for (const doc of docs) {
          // @ts-ignore
          await ctx.db.delete(doc._id);
        }
        console.log(`Deleted ${docs.length} documents from ${tableName}`);
      } catch (e) {
        console.log(`Table ${tableName} doesn't exist or error: ${e}`);
      }
    }

    return "Done";
  },
});
