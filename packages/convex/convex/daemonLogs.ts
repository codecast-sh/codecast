import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";

const ADMIN_EMAIL = "ashot@almostcandid.com";

const MAX_LOGS_PER_BATCH = 100;
const MAX_MESSAGE_LENGTH = 2000;

export const insertBatch = mutation({
  args: {
    api_token: v.string(),
    logs: v.array(
      v.object({
        level: v.union(
          v.literal("debug"),
          v.literal("info"),
          v.literal("warn"),
          v.literal("error")
        ),
        message: v.string(),
        metadata: v.optional(
          v.object({
            session_id: v.optional(v.string()),
            error_code: v.optional(v.string()),
            stack: v.optional(v.string()),
          })
        ),
        daemon_version: v.optional(v.string()),
        platform: v.optional(v.string()),
        timestamp: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) {
      throw new Error("Unauthorized: invalid API token");
    }

    const logs = args.logs.slice(0, MAX_LOGS_PER_BATCH);
    let inserted = 0;

    for (const log of logs) {
      await ctx.db.insert("daemon_logs", {
        user_id: auth.userId,
        level: log.level,
        message: log.message.slice(0, MAX_MESSAGE_LENGTH),
        metadata: log.metadata,
        daemon_version: log.daemon_version,
        platform: log.platform,
        timestamp: log.timestamp,
      });
      inserted++;
    }

    return { inserted };
  },
});

export const list = query({
  args: {
    limit: v.optional(v.number()),
    level: v.optional(
      v.union(
        v.literal("debug"),
        v.literal("info"),
        v.literal("warn"),
        v.literal("error")
      )
    ),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const limit = Math.min(args.limit ?? 100, 500);

    const query = ctx.db
      .query("daemon_logs")
      .withIndex("by_user_timestamp", (q) => q.eq("user_id", userId))
      .order("desc");

    let logs = await query.take(limit * 2);

    if (args.since) {
      logs = logs.filter((log) => log.timestamp >= args.since!);
    }

    if (args.level) {
      logs = logs.filter((log) => log.level === args.level);
    }

    return logs.slice(0, limit);
  },
});

export const clear = mutation({
  args: {
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const before = args.before ?? Date.now() - 7 * 24 * 60 * 60 * 1000;

    const logsToDelete = await ctx.db
      .query("daemon_logs")
      .withIndex("by_user_timestamp", (q) =>
        q.eq("user_id", userId).lt("timestamp", before)
      )
      .take(500);

    for (const log of logsToDelete) {
      await ctx.db.delete(log._id);
    }

    return { deleted: logsToDelete.length };
  },
});

export const adminList = query({
  args: {
    limit: v.optional(v.number()),
    level: v.optional(
      v.union(
        v.literal("debug"),
        v.literal("info"),
        v.literal("warn"),
        v.literal("error")
      )
    ),
    userId: v.optional(v.id("users")),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return { logs: [], users: [], isAdmin: false };
    }

    const currentUser = await ctx.db.get(authUserId);
    if (!currentUser || currentUser.email !== ADMIN_EMAIL) {
      return { logs: [], users: [], isAdmin: false };
    }

    const limit = Math.min(args.limit ?? 200, 1000);

    const logsQuery = args.userId
      ? ctx.db
          .query("daemon_logs")
          .withIndex("by_user_timestamp", (q) => q.eq("user_id", args.userId!))
          .order("desc")
      : ctx.db.query("daemon_logs").order("desc");

    let logs = await logsQuery.take(limit * 2);

    if (args.since) {
      logs = logs.filter((log) => log.timestamp >= args.since!);
    }

    if (args.level) {
      logs = logs.filter((log) => log.level === args.level);
    }

    logs = logs.slice(0, limit);

    const userIds = [...new Set(logs.map((l) => l.user_id))];
    const users = await Promise.all(
      userIds.map(async (id) => {
        const user = await ctx.db.get(id);
        return user ? { _id: id, email: user.email, name: user.name } : null;
      })
    );

    return {
      logs,
      users: users.filter(Boolean),
      isAdmin: true,
    };
  },
});

export const adminGetUsers = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const currentUser = await ctx.db.get(authUserId);
    if (!currentUser || currentUser.email !== ADMIN_EMAIL) {
      return [];
    }

    const logs = await ctx.db.query("daemon_logs").take(5000);
    const userIds = [...new Set(logs.map((l) => l.user_id))];

    const users = await Promise.all(
      userIds.map(async (id) => {
        const user = await ctx.db.get(id);
        if (!user) return null;
        const userLogs = logs.filter((l) => l.user_id === id);
        const errorCount = userLogs.filter((l) => l.level === "error").length;
        const warnCount = userLogs.filter((l) => l.level === "warn").length;
        return {
          _id: id,
          email: user.email,
          name: user.name,
          logCount: userLogs.length,
          errorCount,
          warnCount,
          lastLog: Math.max(...userLogs.map((l) => l.timestamp)),
          cli_version: user.cli_version,
          cli_platform: user.cli_platform,
          daemon_pid: user.daemon_pid,
          autostart_enabled: user.autostart_enabled,
          last_heartbeat: user.last_heartbeat,
        };
      })
    );

    return users
      .filter(Boolean)
      .sort((a, b) => (b?.lastLog ?? 0) - (a?.lastLog ?? 0));
  },
});

export const adminGetStats = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }

    const currentUser = await ctx.db.get(authUserId);
    if (!currentUser || currentUser.email !== ADMIN_EMAIL) {
      return null;
    }

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const logs = await ctx.db.query("daemon_logs").order("desc").take(10000);

    const logsLastHour = logs.filter((l) => l.timestamp >= oneHourAgo);
    const logsLastDay = logs.filter((l) => l.timestamp >= oneDayAgo);
    const logsLastWeek = logs.filter((l) => l.timestamp >= oneWeekAgo);

    const countByLevel = (logList: typeof logs) => ({
      error: logList.filter((l) => l.level === "error").length,
      warn: logList.filter((l) => l.level === "warn").length,
      info: logList.filter((l) => l.level === "info").length,
      debug: logList.filter((l) => l.level === "debug").length,
    });

    const uniqueUsers = (logList: typeof logs) =>
      new Set(logList.map((l) => l.user_id)).size;

    const topErrors = logs
      .filter((l) => l.level === "error")
      .reduce((acc, log) => {
        const key = log.message.slice(0, 100);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const topErrorsList = Object.entries(topErrors)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([message, count]) => ({ message, count }));

    return {
      lastHour: {
        total: logsLastHour.length,
        ...countByLevel(logsLastHour),
        uniqueUsers: uniqueUsers(logsLastHour),
      },
      lastDay: {
        total: logsLastDay.length,
        ...countByLevel(logsLastDay),
        uniqueUsers: uniqueUsers(logsLastDay),
      },
      lastWeek: {
        total: logsLastWeek.length,
        ...countByLevel(logsLastWeek),
        uniqueUsers: uniqueUsers(logsLastWeek),
      },
      topErrors: topErrorsList,
    };
  },
});
