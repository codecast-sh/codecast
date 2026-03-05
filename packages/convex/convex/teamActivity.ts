import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isTeamMember } from "./privacy";

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

    if (!(await isTeamMember(ctx, authUserId, args.team_id))) {
      throw new Error("Not a member of this team");
    }

    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    const targetSize = limit + 1;
    const batchSize = Math.max(100, targetSize * 2);
    const maxScans = 8;

    const events: Array<any> = [];
    let scanCursor = args.cursor;
    let exhausted = false;

    for (let i = 0; i < maxScans && events.length < targetSize && !exhausted; i++) {
      const batch = await ctx.db
        .query("team_activity_events")
        .withIndex("by_team_timestamp", (q) =>
          scanCursor !== undefined
            ? q.eq("team_id", args.team_id).lt("timestamp", scanCursor)
            : q.eq("team_id", args.team_id)
        )
        .order("desc")
        .take(batchSize);

      if (batch.length === 0) {
        exhausted = true;
        break;
      }

      for (const event of batch) {
        if (args.event_type_filter && event.event_type !== args.event_type_filter) continue;
        if (args.actor_filter && event.actor_user_id.toString() !== args.actor_filter.toString()) continue;
        events.push(event);
        if (events.length >= targetSize) break;
      }

      scanCursor = batch[batch.length - 1].timestamp;
      if (batch.length < batchSize) {
        exhausted = true;
      }
    }

    const hasMore = events.length > limit;
    const paginatedEvents = hasMore ? events.slice(0, limit) : events;

    const eventsWithActors = await Promise.all(
      paginatedEvents.map(async (event) => {
        const actor = (await ctx.db.get(event.actor_user_id)) as any;
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
      nextCursor: hasMore && paginatedEvents.length > 0
        ? paginatedEvents[paginatedEvents.length - 1].timestamp
        : undefined,
    };
  },
});
