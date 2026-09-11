import { mutation } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { nextShortId } from "./counters";
import { userCanAccessRole, userCanAdminRole } from "./lib/orgAccess";
import { performSetSessionOwner } from "./sessionOwnership";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { checkConversationAccess } from "./privacy";

// Org roles: named seats in the reporting structure (docs/architecture/
// org-roles.md S1, S2, S5). A role has no standing session in this slice; it is
// the node sessions and other roles report to, plus the scope it owns.
//
// Every mutation is a thin wrapper over a `perform*` function that takes the
// db and the caller, so the fake-db tests drive the same code the mutation
// runs. Access is the anchor rule (lib/orgAccess): a team role is visible to
// its members and reshaped by its host or a team admin; a personal role is its
// owner's alone.

export const HANDLE_RE = /^[a-z0-9-]{2,32}$/;
// Reparent walks up through role parents this far before calling it a cycle.
export const MAX_ROLE_DEPTH = 32;

type Ctx = { db: any };
type ReportsTo = { kind: "user"; user_id: Id<"users"> } | { kind: "role"; role_id: Id<"org_roles"> };
type Scope = { project_ids: Id<"projects">[]; plan_ids: Id<"plans">[] };

const reportsToValidator = v.union(
  v.object({ kind: v.literal("user"), user_id: v.id("users") }),
  v.object({ kind: v.literal("role"), role_id: v.id("org_roles") }),
);
const scopeValidator = v.object({ project_ids: v.array(v.id("projects")), plan_ids: v.array(v.id("plans")) });

function requireHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (!HANDLE_RE.test(h)) throw new Error("Handle must be 2 to 32 characters of a-z, 0-9 and -");
  return h;
}

// A role ref from the CLI is "or-N" or a raw id; the web passes ids.
export async function resolveRoleRef(ctx: Ctx, ref: string): Promise<any | null> {
  const trimmed = (ref ?? "").trim();
  if (!trimmed) return null;
  const byShort = await ctx.db
    .query("org_roles")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", trimmed))
    .first();
  if (byShort) return byShort;
  const id = typeof ctx.db.normalizeId === "function" ? ctx.db.normalizeId("org_roles", trimmed) : trimmed;
  if (!id) return null;
  try { return await ctx.db.get(id); } catch { return null; }
}

async function requireRole(ctx: Ctx, userId: Id<"users">, ref: string, gate: "access" | "admin"): Promise<any> {
  const role = await resolveRoleRef(ctx, ref);
  if (!role) throw new Error("Role not found");
  const ok = gate === "admin" ? await userCanAdminRole(ctx, userId, role) : await userCanAccessRole(ctx, userId, role);
  if (!ok) throw new Error(gate === "admin" ? "Only an admin (or the host) can reshape this role" : "Role not found");
  return role;
}

// Two rows share an access boundary when they are the same team role space or
// the same personal space. A role may only report to a role in its boundary.
function sameBoundary(a: { team_id?: any; scope_user_id?: any }, b: { team_id?: any; scope_user_id?: any }): boolean {
  if (a.team_id || b.team_id) return !!a.team_id && !!b.team_id && a.team_id.toString() === b.team_id.toString();
  return !!a.scope_user_id && !!b.scope_user_id && a.scope_user_id.toString() === b.scope_user_id.toString();
}

// Handles are unique among the boundary's live roles: a retired role's handle
// is free to reuse, the way a retired seat's title is.
async function handleTaken(ctx: Ctx, boundary: { team_id?: any; scope_user_id?: any }, handle: string, exceptId?: any): Promise<boolean> {
  const rows: any[] = boundary.team_id
    ? await ctx.db.query("org_roles").withIndex("by_team_handle", (q: any) => q.eq("team_id", boundary.team_id).eq("handle", handle)).collect()
    : await ctx.db.query("org_roles").withIndex("by_scope_user_handle", (q: any) => q.eq("scope_user_id", boundary.scope_user_id).eq("handle", handle)).collect();
  return rows.some((r) => r.status !== "retired" && (!exceptId || r._id.toString() !== exceptId.toString()));
}

async function resolveReportsTo(ctx: Ctx, userId: Id<"users">, boundary: { team_id?: any; scope_user_id?: any }, target: ReportsTo): Promise<ReportsTo> {
  if (target.kind === "user") return { kind: "user", user_id: target.user_id };
  const parent = await requireRole(ctx, userId, target.role_id.toString(), "access");
  if (!sameBoundary(boundary, parent)) throw new Error("A role can only report to a role in the same workspace");
  if (parent.status === "retired") throw new Error("That role is retired");
  return { kind: "role", role_id: parent._id };
}

export async function performCreateRole(
  ctx: Ctx,
  userId: Id<"users">,
  args: { name: string; handle: string; team_id?: Id<"teams">; scope?: Scope; reports_to?: ReportsTo; charter?: string },
): Promise<any> {
  const name = args.name.trim();
  if (!name) throw new Error("A role needs a name");
  const handle = requireHandle(args.handle);
  const boundary = args.team_id
    ? { scope_type: "team" as const, team_id: args.team_id }
    : { scope_type: "user" as const, scope_user_id: userId };
  // Creating inside a team is a member's act; the creator becomes the host.
  if (args.team_id && !(await userCanAccessRole(ctx, userId, { team_id: args.team_id }))) {
    throw new Error("You are not a member of that team");
  }
  if (await handleTaken(ctx, boundary, handle)) throw new Error(`Handle @${handle} is already taken in this workspace`);
  const reports_to = await resolveReportsTo(ctx, userId, boundary, args.reports_to ?? { kind: "user", user_id: userId });
  const now = Date.now();
  const short_id = await nextShortId(ctx.db, "or");
  const id = await ctx.db.insert("org_roles", {
    short_id,
    ...boundary,
    host_user_id: userId,
    name,
    handle,
    scope: args.scope ?? { project_ids: [], plan_ids: [] },
    reports_to,
    status: "active",
    charter: args.charter?.trim() || undefined,
    created_by: userId,
    created_at: now,
    updated_at: now,
  });
  return await ctx.db.get(id);
}

export async function performUpdateRole(
  ctx: Ctx,
  userId: Id<"users">,
  args: { role_id: string; name?: string; handle?: string; scope?: Scope; charter?: string; status?: "active" | "paused" | "retired" },
): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  // Retiring through update is the retire path: sessions must fall back to
  // their owners, not keep pointing at a hidden seat.
  if (args.status === "retired") return performRetireRole(ctx, userId, { role_id: args.role_id });
  const patch: Record<string, any> = { updated_at: Date.now() };
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) throw new Error("A role needs a name");
    patch.name = name;
  }
  if (args.handle !== undefined) {
    const handle = requireHandle(args.handle);
    if (handle !== role.handle && (await handleTaken(ctx, role, handle, role._id))) {
      throw new Error(`Handle @${handle} is already taken in this workspace`);
    }
    patch.handle = handle;
  }
  if (args.scope !== undefined) patch.scope = args.scope;
  if (args.charter !== undefined) patch.charter = args.charter.trim() || undefined;
  if (args.status !== undefined) patch.status = args.status;
  await ctx.db.patch(role._id, patch);
  return await ctx.db.get(role._id);
}

// Walk up from `start` through role parents; true when `needle` is an
// ancestor (or `start` itself). Bounded so a corrupt chain cannot spin.
async function roleChainReaches(ctx: Ctx, start: any, needle: string): Promise<boolean> {
  let cur: any = start;
  for (let depth = 0; cur && depth < MAX_ROLE_DEPTH; depth++) {
    if (cur._id.toString() === needle) return true;
    if (cur.reports_to?.kind !== "role") return false;
    cur = await ctx.db.get(cur.reports_to.role_id);
  }
  return false;
}

export async function performReparentRole(
  ctx: Ctx,
  userId: Id<"users">,
  args: { role_id: string; reports_to: ReportsTo },
): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  const reports_to = await resolveReportsTo(ctx, userId, role, args.reports_to);
  if (reports_to.kind === "role") {
    const parent = await ctx.db.get(reports_to.role_id);
    if (await roleChainReaches(ctx, parent, role._id.toString())) {
      throw new Error(`Cycle: ${parent.short_id} already reports to ${role.short_id}`);
    }
  }
  await ctx.db.patch(role._id, { reports_to, updated_at: Date.now() });
  return await ctx.db.get(role._id);
}

export async function performRetireRole(ctx: Ctx, userId: Id<"users">, args: { role_id: string }): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  const filed: any[] = await ctx.db
    .query("conversations")
    .withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id))
    .collect();
  for (const conv of filed) await ctx.db.patch(conv._id, { org_role_id: undefined });
  await ctx.db.patch(role._id, { status: "retired", updated_at: Date.now() });
  return { ...(await ctx.db.get(role._id)), cleared: filed.length };
}

// Move a session in the tree. A user target changes ownership (the existing
// owner path) and clears the role pointer; a role target sets the pointer and
// leaves owners alone.
export async function performReparentSession(
  ctx: Ctx,
  userId: Id<"users">,
  args: { conversation_id: string; target: { kind: "user"; user_id: Id<"users"> } | { kind: "role"; role_id: string } },
): Promise<{ ok: true; conversation_id: Id<"conversations">; org_role_id: Id<"org_roles"> | null }> {
  const targetRole = args.target.kind === "role" ? await requireRole(ctx, userId, args.target.role_id, "access") : null;
  const canReshapeTarget = targetRole ? await userCanAdminRole(ctx, userId, targetRole) : false;
  // The conversation access rule decides who may file: an owner always, a
  // team viewer only when they can reshape the target role, and a session the
  // caller cannot see never.
  const conv = await findConversationByAnyRefWhere(ctx, args.conversation_id, async (c: any) => {
    const access = await checkConversationAccess(ctx, userId, c);
    return access === "owner" || (access === "team" && canReshapeTarget);
  });
  if (!conv) throw new Error("Session not found, or you are not one of its owners");

  if (args.target.kind === "user") {
    await performSetSessionOwner(ctx, userId, { session_id: conv._id.toString(), owner: args.target.user_id.toString() });
    if (conv.org_role_id) await ctx.db.patch(conv._id, { org_role_id: undefined });
    return { ok: true, conversation_id: conv._id, org_role_id: null };
  }
  if (targetRole.status === "retired") throw new Error("That role is retired");
  // A team role only takes sessions routed to its team; a personal role takes
  // anything its owner may reparent.
  if (targetRole.team_id && (conv.team_id?.toString() ?? null) !== targetRole.team_id.toString()) {
    throw new Error("That session is not in the role's team");
  }
  await ctx.db.patch(conv._id, { org_role_id: targetRole._id });
  return { ok: true, conversation_id: conv._id, org_role_id: targetRole._id };
}

// ── Mutations (S5) ────────────────────────────────────────────────────────────

async function requireCaller(ctx: any, apiToken?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Authentication failed: invalid token or session");
  return userId;
}

export const create = mutation({
  args: {
    api_token: v.optional(v.string()),
    name: v.string(),
    handle: v.string(),
    team_id: v.optional(v.id("teams")),
    scope: v.optional(scopeValidator),
    reports_to: v.optional(reportsToValidator),
    charter: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => performCreateRole(ctx, await requireCaller(ctx, api_token), args),
});

export const update = mutation({
  args: {
    api_token: v.optional(v.string()),
    role_id: v.string(),
    name: v.optional(v.string()),
    handle: v.optional(v.string()),
    scope: v.optional(scopeValidator),
    charter: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"), v.literal("retired"))),
  },
  handler: async (ctx, { api_token, ...args }) => performUpdateRole(ctx, await requireCaller(ctx, api_token), args),
});

export const reparent = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), reports_to: reportsToValidator },
  handler: async (ctx, { api_token, ...args }) => performReparentRole(ctx, await requireCaller(ctx, api_token), args),
});

export const retire = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => performRetireRole(ctx, await requireCaller(ctx, api_token), args),
});

export const reparentSession = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.string(),
    target: v.union(
      v.object({ kind: v.literal("user"), user_id: v.id("users") }),
      v.object({ kind: v.literal("role"), role_id: v.string() }),
    ),
  },
  handler: async (ctx, { api_token, ...args }) => performReparentSession(ctx, await requireCaller(ctx, api_token), args),
});
