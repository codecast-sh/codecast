// Steering: entity-to-conversation associations (entity_conversations table).
// Messages stay in the existing conversations/messages substrate; these rows
// only record that a conversation relates to a Strategy / Steering Item /
// Task / Plan and how (discussion, work, investigation, evidence).
//
// Containment: the entity workspace comes from { user_id, team_id? }; the
// conversation workspace comes from workspaceForConversation, which treats
// team_id as ROUTING and only yields a team when the conversation is actually
// team-visible. A merely team-routed private conversation therefore cannot be
// attached to a team entity — exactly the spec's "linked Conversations must
// actually be team-visible" rule.
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  canAccessConversation,
  requireAccessibleConversation,
  requireWorkspaceMatch,
  workspaceForConversation,
} from "./lib/access";
import {
  linkableEntityExists,
  linkWorkspace,
  requireAccessibleLinkableEntity,
  type LinkableEntityType,
} from "./lib/steering";
import { notFound } from "./lib/auth";

const entityTypeValidator = v.union(
  v.literal("strategy"),
  v.literal("steering_item"),
  v.literal("task"),
  v.literal("plan"),
);

const relationshipValidator = v.union(
  v.literal("discussion"),
  v.literal("work"),
  v.literal("investigation"),
  v.literal("evidence"),
);

// Shared write path: dispatch's linkConversationToObject dual-writes through
// here so legacy field updates and the association rows cannot drift.
export async function linkConversationToEntity(
  ctx: { db: any },
  userId: any,
  input: {
    entityType: LinkableEntityType;
    entityId: string;
    conversationId: any;
    relationship: "discussion" | "work" | "investigation" | "evidence";
  },
): Promise<{ id: any; created: boolean }> {
  const entity = await requireAccessibleLinkableEntity(
    ctx, userId, input.entityType, input.entityId);
  const conversation = await requireAccessibleConversation(
    ctx, userId, input.conversationId);

  const entityWorkspace = linkWorkspace(entity);
  requireWorkspaceMatch(
    entityWorkspace,
    workspaceForConversation(conversation),
    "conversation",
  );

  const entityId = String(entity._id);
  const existing = await ctx.db
    .query("entity_conversations")
    .withIndex("by_entity", (q: any) =>
      q.eq("entity_type", input.entityType).eq("entity_id", entityId))
    .collect();
  const duplicate = existing.find(
    (row: any) =>
      String(row.conversation_id) === String(conversation._id) &&
      row.relationship === input.relationship,
  );
  if (duplicate) return { id: duplicate._id, created: false };

  const id = await ctx.db.insert("entity_conversations", {
    user_id: userId,
    team_id: entityWorkspace.type === "team" ? entityWorkspace.teamId : undefined,
    entity_type: input.entityType,
    entity_id: entityId,
    conversation_id: conversation._id,
    relationship: input.relationship,
    created_at: Date.now(),
  });
  return { id, created: true };
}

// Bridge for the pre-existing task/plan linkage paths.
// Best-effort: the association row enforces strict same-workspace containment
// that some legacy-permitted links legitimately fail (a private conversation
// linked to a team task by a member, a task moving teams in the same update),
// and the legacy write must keep succeeding for those. Reads combine both
// representations until the backfill completes.
export async function linkConversationToEntityBestEffort(
  ctx: { db: any },
  userId: any,
  input: Parameters<typeof linkConversationToEntity>[2],
): Promise<void> {
  try {
    await linkConversationToEntity(ctx, userId, input);
  } catch (error) {
    // Legacy-permitted link outside the strict containment rule — keep the
    // legacy fields authoritative and skip the association row. Only the
    // typed access/scope refusals are absorbed; a programming error must
    // still surface instead of silently starving the association rail.
    if (!(error instanceof ConvexError)) throw error;
  }
}

export const webLinkConversation = mutation({
  args: {
    entity_type: entityTypeValidator,
    entity_id: v.string(),
    conversation_id: v.id("conversations"),
    relationship: relationshipValidator,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await linkConversationToEntity(ctx, userId, {
      entityType: args.entity_type as LinkableEntityType,
      entityId: args.entity_id,
      conversationId: args.conversation_id,
      relationship: args.relationship,
    });
  },
});

export const webUnlinkConversation = mutation({
  args: { id: v.id("entity_conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const row = await ctx.db.get(args.id);
    if (!row) notFound("Conversation link not found");
    // Unlinking gates on the entity side (the object the association hangs
    // off). Only when that entity is truly GONE does the row become a dangler
    // clearable via conversation access — an entity that exists but isn't
    // visible to the caller still fails closed.
    try {
      await requireAccessibleLinkableEntity(
        ctx, userId, row.entity_type as LinkableEntityType, row.entity_id);
    } catch (error) {
      if (await linkableEntityExists(ctx, row.entity_type as LinkableEntityType, row.entity_id)) {
        throw error;
      }
      await requireAccessibleConversation(ctx, userId, row.conversation_id);
    }

    await ctx.db.delete(args.id);
    return { success: true };
  },
});

// Conversations associated with one entity. Rows whose conversation the caller
// cannot access are omitted, not leaked.
export const webListForEntity = query({
  args: {
    entity_type: entityTypeValidator,
    entity_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let entity: any;
    try {
      entity = await requireAccessibleLinkableEntity(
        ctx, userId, args.entity_type as LinkableEntityType, args.entity_id);
    } catch {
      return [];
    }

    const rows = await ctx.db
      .query("entity_conversations")
      .withIndex("by_entity", (q: any) =>
        q.eq("entity_type", args.entity_type).eq("entity_id", String(entity._id)))
      .collect();

    const result = [];
    for (const row of rows) {
      const conversation = await ctx.db.get(row.conversation_id);
      if (!conversation) continue;
      if (!(await canAccessConversation(ctx, userId, conversation))) continue;
      result.push(row);
    }
    return result;
  },
});

// Entities associated with one conversation (the reverse direction). Rows
// whose entity the caller cannot access are omitted.
export const webListForConversation = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) {
      return [];
    }

    const rows = await ctx.db
      .query("entity_conversations")
      .withIndex("by_conversation", (q: any) =>
        q.eq("conversation_id", args.conversation_id))
      .collect();

    const result = [];
    for (const row of rows) {
      try {
        await requireAccessibleLinkableEntity(
          ctx, userId, row.entity_type as LinkableEntityType, row.entity_id);
        result.push(row);
      } catch {
        // omitted — entity gone or not visible to this caller
      }
    }
    return result;
  },
});
