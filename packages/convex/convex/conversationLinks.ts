// Entity-to-conversation associations (entity_conversations table).
// Messages stay in the existing conversations/messages substrate; these rows
// only record that a conversation relates to a Task / Plan and how
// (discussion, work, investigation, evidence).
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
  canAccessPlan,
  canAccessTask,
  requireAccessibleConversation,
  requireWorkspaceMatch,
  workspaceForConversation,
  workspaceForResource,
  type AuthorizedWorkspace,
} from "./lib/access";
import { notFound } from "./lib/auth";
import type { Id } from "./_generated/dataModel";

export type LinkableEntityType = "task" | "plan";
type AccessCtx = { db: any };

const ENTITY_TABLE: Record<LinkableEntityType, string> = {
  task: "tasks",
  plan: "plans",
};

const ENTITY_ACCESS: Record<
  LinkableEntityType,
  (ctx: AccessCtx, userId: Id<"users">, entity: any) => Promise<boolean>
> = {
  task: canAccessTask,
  plan: canAccessPlan,
};

// Resolve a raw entity reference to its accessible document, or fail closed.
// normalizeId keeps a foreign-table id from ever reaching db.get as the wrong
// type; access failure and absence are indistinguishable (NOT_FOUND).
async function requireAccessibleLinkableEntity(
  ctx: AccessCtx,
  userId: Id<"users">,
  entityType: LinkableEntityType,
  rawId: string,
): Promise<any> {
  const table = ENTITY_TABLE[entityType];
  const id = ctx.db.normalizeId ? ctx.db.normalizeId(table, rawId) : rawId;
  const entity = id
    ? await ctx.db.get(id)
    : await ctx.db
        .query(table)
        .withIndex("by_short_id", (q: any) => q.eq("short_id", rawId))
        .unique();
  if (!entity || !(await ENTITY_ACCESS[entityType](ctx, userId, entity))) {
    notFound(`${entityType} not found`);
  }
  return entity;
}

// Whether a link endpoint's document still exists at all — irrespective of
// the caller's access. Distinguishes a truly-gone endpoint (dangler) from one
// that merely isn't visible to the caller (fail closed).
async function linkableEntityExists(
  ctx: AccessCtx,
  entityType: LinkableEntityType,
  rawId: string,
): Promise<boolean> {
  const table = ENTITY_TABLE[entityType];
  const id = ctx.db.normalizeId ? ctx.db.normalizeId(table, rawId) : rawId;
  if (!id) return false;
  return !!(await ctx.db.get(id));
}

// The workspace a link row lives in, derived from its endpoints. Tasks and
// plans use the plain { user_id, team_id? } shape. (Conversation links derive
// their workspace separately via workspaceForConversation — team_id on a
// conversation is routing, not scope.)
function linkWorkspace(entity: {
  user_id: Id<"users">;
  team_id?: Id<"teams">;
}): AuthorizedWorkspace {
  return workspaceForResource(entity);
}

const entityTypeValidator = v.union(
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
      result.push({
        ...row,
        conversation: {
          _id: conversation._id,
          title: conversation.title,
          updated_at: conversation.updated_at,
          message_count: conversation.message_count,
          agent_type: conversation.agent_type,
          status: conversation.status,
        },
      });
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
