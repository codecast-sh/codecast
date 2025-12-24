import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

export const recordTeamActivity = internalMutation({
  args: {
    team_id: v.id("teams"),
    actor_user_id: v.id("users"),
    event_type: v.union(
      v.literal("session_started"),
      v.literal("session_completed"),
      v.literal("commit_pushed"),
      v.literal("member_joined"),
      v.literal("member_left"),
      v.literal("pr_created"),
      v.literal("pr_merged")
    ),
    title: v.string(),
    description: v.optional(v.string()),
    related_conversation_id: v.optional(v.id("conversations")),
    related_commit_sha: v.optional(v.string()),
    related_pr_id: v.optional(v.id("pull_requests")),
    metadata: v.optional(v.object({
      duration_ms: v.optional(v.number()),
      message_count: v.optional(v.number()),
      git_branch: v.optional(v.string()),
      files_changed: v.optional(v.number()),
      insertions: v.optional(v.number()),
      deletions: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    const activityId = await ctx.db.insert("team_activity_events", {
      team_id: args.team_id,
      actor_user_id: args.actor_user_id,
      event_type: args.event_type,
      title: args.title,
      description: args.description,
      timestamp: Date.now(),
      related_conversation_id: args.related_conversation_id,
      related_commit_sha: args.related_commit_sha,
      related_pr_id: args.related_pr_id,
      metadata: args.metadata,
    });

    return activityId;
  },
});

export const getTeamActivityFeed = query({
  args: {
    team_id: v.id("teams"),
    event_type_filter: v.optional(v.union(
      v.literal("session_started"),
      v.literal("session_completed"),
      v.literal("commit_pushed"),
      v.literal("member_joined"),
      v.literal("member_left"),
      v.literal("pr_created"),
      v.literal("pr_merged")
    )),
    actor_filter: v.optional(v.id("users")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(authUserId);
    if (!user?.team_id || user.team_id.toString() !== args.team_id.toString()) {
      throw new Error("Not a member of this team");
    }

    let query = ctx.db
      .query("team_activity_events")
      .withIndex("by_team_timestamp", (q) => q.eq("team_id", args.team_id));

    let events = await query.order("desc").collect();

    if (args.event_type_filter) {
      events = events.filter((e) => e.event_type === args.event_type_filter);
    }

    if (args.actor_filter) {
      events = events.filter((e) => e.actor_user_id.toString() === args.actor_filter!.toString());
    }

    if (args.cursor !== undefined) {
      events = events.filter((e) => e.timestamp < args.cursor!);
    }

    const limit = args.limit ?? 50;
    const hasMore = events.length > limit;
    const paginatedEvents = events.slice(0, limit);

    const eventsWithActors = await Promise.all(
      paginatedEvents.map(async (event) => {
        const actor = await ctx.db.get(event.actor_user_id);
        return {
          ...event,
          actor: actor ? {
            _id: actor._id,
            name: actor.name,
            email: actor.email,
          } : null,
        };
      })
    );

    return {
      events: eventsWithActors,
      hasMore,
      nextCursor: hasMore ? paginatedEvents[paginatedEvents.length - 1].timestamp : undefined,
    };
  },
});
