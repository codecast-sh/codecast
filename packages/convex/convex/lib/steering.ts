// Shared domain helpers for Organizational Steering
// (docs/plans/2026-08-01-organizational-steering.md).
//
// The steering graph joins Strategy / Steering Items to the
// existing Tasks / Plans / Conversations. Two invariants live here so every
// link and cross-reference writer enforces the same rule:
//
//   1. Every relationship stays inside ONE authorized workspace (a team, or a
//      single user's personal space). Cross-team links fail closed.
//   2. Link writers validate a constrained (from, link_type, to) matrix —
//      there is no arbitrary graph mutation surface.

import { Id } from "../_generated/dataModel";
import {
  canAccessPlan,
  canAccessProject,
  canAccessSteeringEntity,
  canAccessTask,
  isTeamMember,
  requireTeamMembership,
  workspaceForResource,
  type AuthorizedWorkspace,
} from "./access";
import { invalidScope, notFound } from "./auth";

export type LinkableEntityType =
  | "strategy"
  | "steering_item"
  | "task"
  | "plan";

// Keep in sync with linkableEntityTypeValidator in schema.ts.
export const LINKABLE_ENTITY_TYPES: readonly LinkableEntityType[] = [
  "strategy",
  "steering_item",
  "task",
  "plan",
];

type AccessCtx = { db: any };

const ENTITY_TABLE: Record<LinkableEntityType, string> = {
  strategy: "strategies",
  steering_item: "steering_items",
  task: "tasks",
  plan: "plans",
};

const ENTITY_ACCESS: Record<
  LinkableEntityType,
  (ctx: AccessCtx, userId: Id<"users">, entity: any) => Promise<boolean>
> = {
  strategy: canAccessSteeringEntity,
  steering_item: canAccessSteeringEntity,
  task: canAccessTask,
  plan: canAccessPlan,
};

export function tableForEntityType(entityType: LinkableEntityType): string {
  return ENTITY_TABLE[entityType];
}

// Resolve a raw entity reference to its accessible document, or fail closed.
// normalizeId keeps a foreign-table id from ever reaching db.get as the wrong
// type; access failure and absence are indistinguishable (NOT_FOUND).
export async function requireAccessibleLinkableEntity(
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
// the caller's access. Used by unlink fallbacks to distinguish a truly-gone
// endpoint (the row is a dangler anyone party to the surviving side may
// clear) from one that merely isn't visible to the caller (fail closed).
export async function linkableEntityExists(
  ctx: AccessCtx,
  entityType: LinkableEntityType,
  rawId: string,
): Promise<boolean> {
  const table = ENTITY_TABLE[entityType];
  const id = ctx.db.normalizeId ? ctx.db.normalizeId(table, rawId) : rawId;
  if (!id) return false;
  return !!(await ctx.db.get(id));
}

// The workspace a link row lives in, derived from its (already-matched)
// endpoints. Tasks/plans/projects/steering entities all use the plain
// { user_id, team_id? } shape, so workspaceForResource applies to every
// linkable type. (Conversation links derive their workspace separately via
// workspaceForConversation — team_id on a conversation is routing, not scope.)
export function linkWorkspace(entity: {
  user_id: Id<"users">;
  team_id?: Id<"teams">;
}): AuthorizedWorkspace {
  return workspaceForResource(entity);
}

export type SteeringLinkType =
  | "advances"
  | "tests"
  | "supports"
  | "blocks"
  | "challenges"
  | "investigates"
  | "executes"
  | "relates";

// The constrained relationship matrix. Direct item hierarchy is NOT expressed
// here — these are only the cross-cutting
// edges the spec calls out. `relates` is the deliberate low-precision edge
// between any two distinct endpoints.
const ALLOWED_LINKS: Record<SteeringLinkType, ReadonlySet<string>> = {
  // "This Initiative advances that Objective."
  advances: new Set(["steering_item:steering_item"]),
  tests: new Set(["steering_item:steering_item"]),
  supports: new Set(["steering_item:steering_item"]),
  // "This uncertainty blocks that work."
  blocks: new Set([
    "steering_item:steering_item",
  ]),
  // "This uncertainty challenges that direction."
  challenges: new Set(["steering_item:steering_item"]),
  // "This execution investigates that Steering Item."
  investigates: new Set(["task:steering_item", "plan:steering_item"]),
  executes: new Set(["task:steering_item", "plan:steering_item"]),
  relates: new Set(
    LINKABLE_ENTITY_TYPES.flatMap((from) =>
      LINKABLE_ENTITY_TYPES.map((to) => `${from}:${to}`),
    ),
  ),
};

export function isAllowedLink(
  fromType: LinkableEntityType,
  linkType: SteeringLinkType,
  toType: LinkableEntityType,
): boolean {
  return ALLOWED_LINKS[linkType]?.has(`${fromType}:${toType}`) ?? false;
}

export function requireAllowedSteeringItemKinds(
  from: { kind: string }, linkType: SteeringLinkType, to: { kind: string },
): void {
  const pair = `${from.kind}:${to.kind}`;
  const allowed: Partial<Record<SteeringLinkType, ReadonlySet<string>>> = {
    advances: new Set(["initiative:objective"]),
    tests: new Set(["initiative:bet", "question:bet"]),
    blocks: new Set(["question:initiative"]),
    supports: new Set(["question:bet"]),
    challenges: new Set(["question:bet"]),
  };
  const matrix = allowed[linkType];
  if (matrix && !matrix.has(pair)) invalidScope(`A ${from.kind} cannot "${linkType}" a ${to.kind}`);
}

export function requireAllowedLink(
  fromType: LinkableEntityType,
  linkType: SteeringLinkType,
  toType: LinkableEntityType,
): void {
  if (!isAllowedLink(fromType, linkType, toType)) {
    invalidScope(`A ${fromType} cannot "${linkType}" a ${toType}`);
  }
}

// The team a new steering entity is created in. Explicit workspace:"personal"
// wins; an explicit team_id is honored only for members; otherwise the user's
// active team (client_state) applies — the same inheritance projects.webCreate
// uses. Every returned team id has been membership-checked.
export async function resolveCreateTeamId(
  ctx: AccessCtx,
  userId: Id<"users">,
  opts: { team_id?: Id<"teams">; workspace?: "personal" | "team" },
): Promise<Id<"teams"> | undefined> {
  if (opts.workspace === "personal") return undefined;
  if (opts.team_id) {
    await requireTeamMembership(ctx, userId, opts.team_id);
    return opts.team_id;
  }
  const clientState = await ctx.db
    .query("client_state")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .first();
  const teamId = clientState?.ui?.active_team_id;
  if (teamId) await requireTeamMembership(ctx, userId, teamId);
  return teamId ?? undefined;
}

// Workspace-scoped listing shared by the steering entity webList queries.
// Mirrors projects.webList: team view requires membership and reads the team
// index; personal view is the user's own teamless rows; default is everything
// the user owns.
export async function listWorkspaceEntities(
  ctx: AccessCtx,
  userId: Id<"users">,
  table: string,
  opts: { workspace?: "personal" | "team"; team_id?: Id<"teams"> },
): Promise<any[]> {
  if (opts.workspace === "team" && opts.team_id) {
    // team_id is client-supplied — only a member may list a team's entities.
    if (!(await isTeamMember(ctx, userId, opts.team_id))) return [];
    return await ctx.db
      .query(table)
      .withIndex("by_team_id", (q: any) => q.eq("team_id", opts.team_id))
      .collect();
  }
  const mine = await ctx.db
    .query(table)
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  if (opts.workspace === "personal") return mine.filter((r: any) => !r.team_id);
  return mine;
}

// When a linkable entity is hard-deleted, its relationship rows must go with it
// or they dangle as unauthorized references. Called inside the same mutation.
export async function deleteEntityRelationRows(
  ctx: AccessCtx,
  entityType: LinkableEntityType,
  entityId: string,
): Promise<void> {
  const outgoing = await ctx.db
    .query("entity_links")
    .withIndex("by_from", (q: any) => q.eq("from_type", entityType).eq("from_id", entityId))
    .collect();
  const incoming = await ctx.db
    .query("entity_links")
    .withIndex("by_to", (q: any) => q.eq("to_type", entityType).eq("to_id", entityId))
    .collect();
  const conversations = await ctx.db
    .query("entity_conversations")
    .withIndex("by_entity", (q: any) => q.eq("entity_type", entityType).eq("entity_id", entityId))
    .collect();
  for (const row of [...outgoing, ...incoming, ...conversations]) {
    await ctx.db.delete(row._id);
  }
}

// owner_id expresses responsibility inside the entity's workspace: a member of
// the team for team-scoped entities, the creator themself for personal ones.
export async function requireValidOwner(
  ctx: AccessCtx,
  entity: { user_id: Id<"users">; team_id?: Id<"teams"> },
  ownerId: Id<"users">,
): Promise<void> {
  if (entity.team_id) {
    if (!(await isTeamMember(ctx, ownerId, entity.team_id))) {
      invalidScope("Owner must be a member of the entity's team");
    }
    return;
  }
  if (String(ownerId) !== String(entity.user_id)) {
    invalidScope("A personal entity can only be owned by its creator");
  }
}
