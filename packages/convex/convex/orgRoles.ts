import { mutation } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { nextShortId } from "./counters";
import { userCanAccessRole, userCanAdminRole } from "./lib/orgAccess";
import { performSetSessionOwner } from "./sessionOwnership";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { checkConversationAccess } from "./privacy";
import { canAccessPlan, canAccessProject, workspaceForResource, workspaceKey } from "./lib/access";
import { EMPTY_SCOPE, isWholeWorkspace, normalizeScope, sameScope, scopeIds, scopeOutside, scopeOverlap, type PlanProjectOf, type Scope } from "./lib/orgScope";

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

// ── Scope (docs/architecture/scopes-and-feed.md F1) ──────────────────────────

export type ScopeOverlap = {
  role_id: Id<"org_roles">;
  short_id: string;
  handle: string;
  name: string;
  project_ids: string[];
  plan_ids: string[];
};

const boundaryKey = (seat: { team_id?: any; scope_user_id?: any }): string =>
  seat.team_id ? `team:${seat.team_id}` : `user:${seat.scope_user_id}`;

// Every live role in a boundary. There is no parent index: the boundary's roles
// are few (a team's org chart), so siblings and children are filtered here.
export async function rolesInBoundary(ctx: Ctx, seat: { team_id?: any; scope_user_id?: any }): Promise<any[]> {
  const rows: any[] = seat.team_id
    ? await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", seat.team_id)).collect()
    : await ctx.db.query("org_roles").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", seat.scope_user_id)).collect();
  return rows.filter((r) => r.status !== "retired");
}

// The plan → project edge for every plan named by these scopes, read once.
export async function planProjectsOf(ctx: Ctx, scopes: Scope[]): Promise<PlanProjectOf> {
  const out: PlanProjectOf = new Map();
  for (const scope of scopes) {
    for (const id of scope.plan_ids) {
      const key = String(id);
      if (out.has(key)) continue;
      const plan = await ctx.db.get(id);
      out.set(key, plan?.project_id ? String(plan.project_id) : null);
    }
  }
  return out;
}

// Sibling overlap for one role: the roles reporting to the same parent that
// watch a project or plan this scope also watches. Allowed, shown as a warning.
export function overlapsAmong(role: { _id: any; reports_to: any; scope: Scope }, siblings: any[], planProjectOf: PlanProjectOf): ScopeOverlap[] {
  const parentKey = JSON.stringify(role.reports_to);
  const mine = scopeIds(role.scope);
  const out: ScopeOverlap[] = [];
  for (const other of siblings) {
    if (other._id.toString() === role._id.toString()) continue;
    if (JSON.stringify(other.reports_to) !== parentKey) continue;
    const shared = scopeOverlap(mine, scopeIds(other.scope), planProjectOf);
    if (shared.project_ids.length === 0 && shared.plan_ids.length === 0) continue;
    out.push({ role_id: other._id, short_id: other.short_id, handle: other.handle, name: other.name, ...shared });
  }
  return out;
}

async function refuseOutside(ctx: Ctx, outside: { project_ids: string[]; plan_ids: string[] }, who: string): Promise<never> {
  const names: string[] = [];
  for (const id of outside.project_ids) names.push(`project ${(await ctx.db.get(id))?.title ?? id}`);
  for (const id of outside.plan_ids) names.push(`plan ${(await ctx.db.get(id))?.short_id ?? id}`);
  throw new Error(`${who}: ${names.join(", ")}`);
}

// Validate a scope for `role`: every id resolves inside the role's boundary,
// the result sits inside the parent's scope (unless the parent is the root: a
// person, or a role with the whole workspace), and every child role still fits.
// Returns the normalized scope and the sibling overlaps to warn about.
export async function checkScope(
  ctx: Ctx,
  userId: Id<"users">,
  role: any,
  scope: Scope,
): Promise<{ scope: Scope; overlaps: ScopeOverlap[]; outside_children: Array<{ role_id: Id<"org_roles">; short_id: string; handle: string }> }> {
  const key = boundaryKey(role);
  for (const id of scope.project_ids) {
    const project = await ctx.db.get(id);
    if (!project || workspaceKey(workspaceForResource(project)) !== key || !(await canAccessProject(ctx as any, userId, project))) {
      throw new Error(`Project ${id} is not in this workspace`);
    }
  }
  for (const id of scope.plan_ids) {
    const plan = await ctx.db.get(id);
    if (!plan || workspaceKey(workspaceForResource(plan)) !== key || !(await canAccessPlan(ctx as any, userId, plan))) {
      throw new Error(`Plan ${id} is not in this workspace`);
    }
  }
  const siblings = await rolesInBoundary(ctx, role);
  const parent = role.reports_to?.kind === "role" ? siblings.find((r) => r._id.toString() === role.reports_to.role_id.toString()) ?? null : null;
  const children = siblings.filter((r) => r.reports_to?.kind === "role" && r.reports_to.role_id.toString() === role._id.toString());
  const planProjectOf = await planProjectsOf(ctx, [scope, ...siblings.map((r) => r.scope)]);
  const next = normalizeScope(scope, planProjectOf);
  const nextIds = scopeIds(next);

  if (parent) {
    const outside = scopeOutside(scopeIds(parent.scope), nextIds, planProjectOf);
    if (outside.project_ids.length || outside.plan_ids.length) {
      await refuseOutside(ctx, outside, `Outside the scope of @${parent.handle}, which this role reports to`);
    }
  }
  const outside_children: Array<{ role_id: Id<"org_roles">; short_id: string; handle: string }> = [];
  if (!isWholeWorkspace(nextIds)) {
    for (const child of children) {
      const outside = scopeOutside(nextIds, scopeIds(child.scope), planProjectOf);
      if (outside.project_ids.length || outside.plan_ids.length) outside_children.push({ role_id: child._id, short_id: child.short_id, handle: child.handle });
    }
  }
  if (outside_children.length) {
    throw new Error(`Narrow ${outside_children.map((c) => `@${c.handle}`).join(", ")} first: their scope would fall outside this role's`);
  }
  return { scope: next, overlaps: overlapsAmong({ ...role, scope: next }, siblings, planProjectOf), outside_children };
}

// A ref from the CLI: "project:<short id | id | title>" or "plan:<pl-N | id>",
// resolved inside the role's boundary.
export async function resolveScopeRef(ctx: Ctx, role: any, ref: string): Promise<{ kind: "project"; id: Id<"projects"> } | { kind: "plan"; id: Id<"plans"> }> {
  const m = /^(project|plan):(.+)$/.exec(ref.trim());
  if (!m) throw new Error(`Scope refs look like project:<ref> or plan:<ref>, not "${ref}"`);
  const kind = m[1] as "project" | "plan";
  const needle = m[2].trim();
  const table = kind === "project" ? "projects" : "plans";
  const key = boundaryKey(role);
  const inBoundary = (row: any) => !!row && workspaceKey(workspaceForResource(row)) === key;
  const byShort = await ctx.db.query(table).withIndex("by_short_id", (q: any) => q.eq("short_id", needle)).first();
  if (inBoundary(byShort)) return { kind, id: byShort._id };
  const id = typeof ctx.db.normalizeId === "function" ? ctx.db.normalizeId(table, needle) : needle;
  if (id) {
    const row = await ctx.db.get(id).catch(() => null);
    if (inBoundary(row)) return { kind, id: row._id };
  }
  if (kind === "project") {
    const rows: any[] = role.team_id
      ? await ctx.db.query("projects").withIndex("by_team_id", (q: any) => q.eq("team_id", role.team_id)).collect()
      : await ctx.db.query("projects").withIndex("by_user_id", (q: any) => q.eq("user_id", role.scope_user_id)).collect();
    const lc = needle.toLowerCase();
    const hits = rows.filter((r) => inBoundary(r) && r.title.toLowerCase().includes(lc));
    if (hits.length === 1) return { kind, id: hits[0]._id };
    if (hits.length > 1) throw new Error(`"${needle}" matches ${hits.length} projects: ${hits.map((h) => h.short_id ?? h.title).join(", ")}`);
  }
  throw new Error(`No ${kind} "${needle}" in this workspace`);
}

// `cast role scope <handle> --add project:<ref> --remove plan:<ref>`: edit the
// scope by refs, then run the update path with its rules and its log entry.
export async function performSetRoleScope(
  ctx: Ctx,
  userId: Id<"users">,
  args: { role_id: string; add?: string[]; remove?: string[]; from_session?: string },
): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  const projects = new Set(role.scope.project_ids.map(String));
  const plans = new Set(role.scope.plan_ids.map(String));
  for (const ref of args.remove ?? []) {
    const r = await resolveScopeRef(ctx, role, ref);
    (r.kind === "project" ? projects : plans).delete(String(r.id));
  }
  for (const ref of args.add ?? []) {
    const r = await resolveScopeRef(ctx, role, ref);
    (r.kind === "project" ? projects : plans).add(String(r.id));
  }
  return performUpdateRole(ctx, userId, {
    role_id: args.role_id,
    scope: { project_ids: Array.from(projects) as any, plan_ids: Array.from(plans) as any },
    from_session: args.from_session,
  });
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
  // A role born with a scope ("Add a lead" on a project page) obeys the same
  // containment rule as an edit; overlaps are the caller's to show.
  const scope = args.scope && !isWholeWorkspace(args.scope)
    ? (await checkScope(ctx, userId, { _id: "new", ...boundary, reports_to, scope: EMPTY_SCOPE }, args.scope)).scope
    : EMPTY_SCOPE;
  const short_id = await nextShortId(ctx.db, "or");
  const id = await ctx.db.insert("org_roles", {
    short_id,
    ...boundary,
    host_user_id: userId,
    name,
    handle,
    scope,
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
  args: { role_id: string; name?: string; handle?: string; scope?: Scope; charter?: string; status?: "active" | "paused" | "retired"; from_session?: string },
): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  // Scope edits are human only (F1): a call carrying the session it runs in
  // is an agent's, and an agent may not widen or narrow what a role owns.
  if (args.scope !== undefined && args.from_session) {
    throw new Error("Scope changes are human only: edit the scope from the scope page or run cast role scope outside an agent session");
  }
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
  let overlaps: ScopeOverlap[] | undefined;
  if (args.scope !== undefined) {
    const checked = await checkScope(ctx, userId, role, args.scope);
    if (!sameScope(scopeIds(checked.scope), scopeIds(role.scope))) patch.scope = checked.scope;
    overlaps = checked.overlaps;
  }
  if (args.charter !== undefined) patch.charter = args.charter.trim() || undefined;
  if (args.status !== undefined) patch.status = args.status;
  await ctx.db.patch(role._id, patch);
  // The log entry (F1): the charter is free text in this slice, so the edit
  // lands as a task_history style row on the role until it becomes a doc.
  if (patch.scope) {
    await ctx.db.insert("org_role_history", {
      role_id: role._id,
      user_id: userId,
      actor_type: "user",
      action: "scope",
      field: "scope",
      old_value: JSON.stringify(scopeIds(role.scope)),
      new_value: JSON.stringify(scopeIds(patch.scope)),
      created_at: patch.updated_at,
    });
  }
  const updated = await ctx.db.get(role._id);
  return overlaps ? { ...updated, overlaps } : updated;
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
    // Containment (F1) holds across a move too: the role's scope must fit
    // inside its new parent's.
    const planProjectOf = await planProjectsOf(ctx, [role.scope, parent.scope]);
    const outside = scopeOutside(scopeIds(parent.scope), scopeIds(role.scope), planProjectOf);
    if (outside.project_ids.length || outside.plan_ids.length) {
      await refuseOutside(ctx, outside, `Outside the scope of @${parent.handle}`);
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
    // The session the CLI runs inside, when any: marks the call as an agent's.
    from_session: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => performUpdateRole(ctx, await requireCaller(ctx, api_token), args),
});

// `cast role scope <handle> --add project:<ref> --remove plan:<ref>` (F1).
export const setScope = mutation({
  args: {
    api_token: v.optional(v.string()),
    role_id: v.string(),
    add: v.optional(v.array(v.string())),
    remove: v.optional(v.array(v.string())),
    from_session: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => performSetRoleScope(ctx, await requireCaller(ctx, api_token), args),
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
