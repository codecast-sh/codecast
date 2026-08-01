// Steering: constrained cross-object links (entity_links table). The domain
// API — not arbitrary graph mutation: every write validates the
// (from, link_type, to) combination against the matrix in lib/steering.ts,
// checks the caller can access BOTH endpoints, and requires both endpoints to
// live in the same authorized workspace. See
// docs/plans/2026-08-01-organizational-steering.md.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  requireWorkspaceMatch,
} from "./lib/access";
import {
  linkableEntityExists,
  linkWorkspace,
  requireAccessibleLinkableEntity,
  requireAllowedLink,
  requireAllowedSteeringItemKinds,
  type LinkableEntityType,
  type SteeringLinkType,
} from "./lib/steering";
import { invalidScope, notFound } from "./lib/auth";

const entityTypeValidator = v.union(
  v.literal("strategy"),
  v.literal("steering_item"),
  v.literal("task"),
  v.literal("plan"),
);

const linkTypeValidator = v.union(
  v.literal("advances"),
  v.literal("tests"),
  v.literal("supports"),
  v.literal("blocks"),
  v.literal("challenges"),
  v.literal("investigates"),
  v.literal("executes"),
  v.literal("relates"),
);

export const webCreateLink = mutation({
  args: {
    from_type: entityTypeValidator,
    from_id: v.string(),
    link_type: linkTypeValidator,
    to_type: entityTypeValidator,
    to_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    if (args.from_type === args.to_type && args.from_id === args.to_id) {
      invalidScope("An entity cannot link to itself");
    }
    requireAllowedLink(
      args.from_type as LinkableEntityType,
      args.link_type as SteeringLinkType,
      args.to_type as LinkableEntityType,
    );

    const from = await requireAccessibleLinkableEntity(
      ctx, userId, args.from_type as LinkableEntityType, args.from_id);
    const to = await requireAccessibleLinkableEntity(
      ctx, userId, args.to_type as LinkableEntityType, args.to_id);
    if (args.from_type === "steering_item" && args.to_type === "steering_item") {
      requireAllowedSteeringItemKinds(from, args.link_type as SteeringLinkType, to);
    }

    // Both endpoints must live in ONE authorized workspace; the link row is
    // stamped with that workspace's team (or none for personal).
    const workspace = linkWorkspace(from);
    requireWorkspaceMatch(workspace, linkWorkspace(to), "link target");

    // Idempotent: an identical edge is returned, not duplicated.
    const existing = await ctx.db
      .query("entity_links")
      .withIndex("by_from", (q: any) =>
        q.eq("from_type", args.from_type).eq("from_id", String(from._id)))
      .collect();
    const duplicate = existing.find(
      (l: any) =>
        l.to_type === args.to_type &&
        l.to_id === String(to._id) &&
        l.link_type === args.link_type,
    );
    if (duplicate) return { id: duplicate._id, created: false };

    const id = await ctx.db.insert("entity_links", {
      user_id: userId,
      team_id: workspace.type === "team" ? workspace.teamId : undefined,
      from_type: args.from_type,
      from_id: String(from._id),
      to_type: args.to_type,
      to_id: String(to._id),
      link_type: args.link_type,
      created_at: Date.now(),
    });
    return { id, created: true };
  },
});

export const webDeleteLink = mutation({
  args: { id: v.id("entity_links") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const link = await ctx.db.get(args.id);
    if (!link) notFound("Link not found");
    // Unlinking requires access to the FROM endpoint (the entity the
    // relationship hangs off). Only when that endpoint is truly GONE does the
    // row become a dangler clearable via access to the surviving TO endpoint —
    // an endpoint that exists but isn't visible to the caller still fails
    // closed (absence and inaccessibility must not be conflated).
    try {
      await requireAccessibleLinkableEntity(
        ctx, userId, link.from_type as LinkableEntityType, link.from_id);
    } catch (error) {
      if (await linkableEntityExists(ctx, link.from_type as LinkableEntityType, link.from_id)) {
        throw error;
      }
      await requireAccessibleLinkableEntity(
        ctx, userId, link.to_type as LinkableEntityType, link.to_id);
    }

    await ctx.db.delete(args.id);
    return { success: true };
  },
});

// Every link touching one entity, both directions. The caller must be able to
// access the anchoring entity; each linked endpoint is then re-checked so a
// row pointing at something the caller cannot see is omitted, not leaked.
export const webListForEntity = query({
  args: {
    entity_type: entityTypeValidator,
    entity_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { outgoing: [], incoming: [] };

    let entity: any;
    try {
      entity = await requireAccessibleLinkableEntity(
        ctx, userId, args.entity_type as LinkableEntityType, args.entity_id);
    } catch {
      return { outgoing: [], incoming: [] };
    }
    const entityId = String(entity._id);

    const rawOutgoing = await ctx.db
      .query("entity_links")
      .withIndex("by_from", (q: any) =>
        q.eq("from_type", args.entity_type).eq("from_id", entityId))
      .collect();
    const rawIncoming = await ctx.db
      .query("entity_links")
      .withIndex("by_to", (q: any) =>
        q.eq("to_type", args.entity_type).eq("to_id", entityId))
      .collect();

    const visible = async (type: string, id: string) => {
      try {
        await requireAccessibleLinkableEntity(ctx, userId, type as LinkableEntityType, id);
        return true;
      } catch {
        return false;
      }
    };

    const outgoing = [];
    for (const link of rawOutgoing) {
      if (await visible(link.to_type, link.to_id)) outgoing.push(link);
    }
    const incoming = [];
    for (const link of rawIncoming) {
      if (await visible(link.from_type, link.from_id)) incoming.push(link);
    }
    return { outgoing, incoming };
  },
});
