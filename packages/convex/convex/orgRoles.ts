import { internalMutation, mutation, query } from "./functions";
import { internalQuery } from "./_generated/server";
import { applyTaskUpdate, cancelTasksOriginatingFrom, insertTask } from "./agentTasks";
import { renderCapacityModel } from "@codecast/shared/contracts/orgCapacity";
import { defaultAvatarFor, isAvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { orgTenureError } from "@codecast/shared/contracts/orgProposal";
import { leadScopeChange } from "@codecast/shared/contracts/orgLead";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { nextShortId } from "./counters";
import { CHIEF_OF_STAFF_HANDLE, chiefOfStaffIn, liveRolesByHandle, requireRole, resolveRoleRef, rolesInBoundary, userCanAccessRole, userCanAdminRole } from "./lib/orgAccess";
import { performReparentSession, personName, reportsToLine } from "./sessionOwnership";
import { notifySessionAssigned, notifySessionOwnershipChanged } from "./sessionAssignmentNotifications";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { checkConversationAccess } from "./privacy";
import { canAccessPlan, canAccessProject, isTeamMember, workspaceForResource, workspaceKey } from "./lib/access";
import { charterPatch } from "./lib/orgCharter";
// Used inside handlers only: orgInit imports this module, and a cycle is safe
// for hoisted functions called at run time, never for values read at load.
import { takeOverSessions, takeoverPhrase } from "./orgInit";
import { EMPTY_SCOPE, isWholeWorkspace, normalizeScope, sameScope, scopeIds, scopeOutside, scopeOverlap, type PlanProjectOf, type Scope } from "./lib/orgScope";
import { announceSeating, decommissionAnchorRow, provisionStandingAgent, seatTitlePatch, userCanAdminAnchor, workspaceAnchorFor, type RoleBootstrap } from "./anchors";
import { enqueuePendingMessage } from "./pendingMessages";
import { enqueueKillAndResume, performSetThreadState } from "./conversations";
import { ACTIVE_AGENT_STATUSES, normalizeThreadState, parseThreadStateStatus } from "@codecast/shared/contracts";
import { siteUrl } from "./lib/siteUrl";
import { DEFAULT_CAPS, RESTART_CAUSE, capsFor, countersFor, enqueueRoleEvent, scheduleFlush, trustOf, unflushedRowsFor } from "./orgEvents";

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
// Tenure as the CLI and a proposal carry it: refs are strings (pl-N, a
// project ref), resolved to ids by resolveTenure inside the boundary.
const tenureValidator = v.union(
  v.object({ kind: v.literal("standing") }),
  v.object({
    kind: v.literal("program"),
    ends: v.union(v.object({ plan: v.string() }), v.object({ project: v.string() }), v.object({ date: v.number() })),
    then: v.union(v.literal("retire"), v.literal("review")),
  }),
);

function requireHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (!HANDLE_RE.test(h)) throw new Error("Handle must be 2 to 32 characters of a-z, 0-9 and -");
  return h;
}

// The role lookup and its gate live in lib/orgAccess so the session
// reparent core (sessionOwnership.ts) can use them without importing this
// module. Re-exported for the callers that read them from here.
export { CHIEF_OF_STAFF_HANDLE, resolveRoleRef, rolesInBoundary };

// Two rows share an access boundary when they are the same team role space or
// the same personal space. A role may only report to a role in its boundary.
function sameBoundary(a: { team_id?: any; scope_user_id?: any }, b: { team_id?: any; scope_user_id?: any }): boolean {
  if (a.team_id || b.team_id) return !!a.team_id && !!b.team_id && a.team_id.toString() === b.team_id.toString();
  return !!a.scope_user_id && !!b.scope_user_id && a.scope_user_id.toString() === b.scope_user_id.toString();
}

// Handles are unique among the boundary's live roles: a retired role's handle
// is free to reuse, the way a retired seat's title is.
async function handleTaken(ctx: Ctx, boundary: { team_id?: any; scope_user_id?: any }, handle: string, exceptId?: any): Promise<boolean> {
  return (await liveRolesByHandle(ctx, boundary, handle)).some((r) => !exceptId || r._id.toString() !== exceptId.toString());
}

async function resolveReportsTo(ctx: Ctx, userId: Id<"users">, boundary: { team_id?: any; scope_user_id?: any }, target: ReportsTo): Promise<ReportsTo> {
  if (target.kind === "user") {
    // A person parent must be inside the boundary too: a team member for a
    // team role, the owner for a personal role. Otherwise the tree draws a
    // role whose parent is not in `people`.
    const inside = boundary.team_id
      ? await isTeamMember(ctx as any, target.user_id, boundary.team_id)
      : !!boundary.scope_user_id && target.user_id.toString() === boundary.scope_user_id.toString();
    if (!inside) throw new Error("A role can only report to a person in the same workspace");
    return { kind: "user", user_id: target.user_id };
  }
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

// ── Tenure and avatar (org-staffing.md S10, S13) ────────────────────────────
export type TenureSpec =
  | { kind: "standing" }
  | { kind: "program"; ends: { plan: string } | { project: string } | { date: number }; then: "retire" | "review" };

/** A tenure spec (refs) → the stored tenure (ids). Validates the shape, then
 *  resolves a plan or project ref inside the boundary the way scope refs
 *  resolve; a date passes through. Throws on a bad shape or an unknown ref. */
export async function resolveTenure(ctx: Ctx, boundary: { team_id?: any; scope_user_id?: any }, spec: TenureSpec): Promise<any> {
  const fault = orgTenureError(spec);
  if (fault) throw new Error(fault);
  if (spec.kind === "standing") return { kind: "standing" };
  const e: any = spec.ends;
  if (e.date !== undefined) return { kind: "program", ends: { date: e.date }, then: spec.then };
  const which = e.plan !== undefined ? "plan" : "project";
  const ref = await resolveScopeRef(ctx, boundary, `${which}:${e[which]}`);
  return { kind: "program", ends: which === "plan" ? { plan: ref.id } : { project: ref.id }, then: spec.then };
}

/** A chosen avatar key, else the stable default for the handle. An empty
 *  string clears back to the default. */
export function normalizeAvatar(avatar: string | undefined, handle: string): string {
  if (avatar === undefined) return defaultAvatarFor(handle);
  const trimmed = avatar.trim();
  if (!trimmed) return defaultAvatarFor(handle);
  if (!isAvatarKey(trimmed)) throw new Error(`"${trimmed}" is not an avatar key (see shared/contracts/orgAvatars)`);
  return trimmed;
}

// `cast role scope <handle> --add project:<ref> --remove plan:<ref>`: edit the
// scope by refs, then run the update path with its rules and its log entry.
export async function performSetRoleScope(
  ctx: Ctx,
  userId: Id<"users">,
  args: { role_id: string; add?: string[]; remove?: string[]; from_session?: string; human_decision?: string },
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
    human_decision: args.human_decision,
  });
}

export async function performCreateRole(
  ctx: Ctx,
  userId: Id<"users">,
  args: { name: string; handle: string; team_id?: Id<"teams">; scope?: Scope; reports_to?: ReportsTo; charter?: string; review_backend?: string; tenure?: TenureSpec; avatar?: string },
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
  // Standing or program (S10) and the face (S13): tenure refs resolve to ids
  // inside the boundary; the avatar defaults to the handle's own face.
  const tenure = args.tenure ? await resolveTenure(ctx, { team_id: args.team_id, scope_user_id: args.team_id ? undefined : userId }, args.tenure) : undefined;
  const avatar = normalizeAvatar(args.avatar, handle);
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
    review_backend: normalizeBackend(args.review_backend),
    trust: "understand",
    caps: { ...DEFAULT_CAPS },
    tenure,
    avatar,
    created_by: userId,
    created_at: now,
    updated_at: now,
  });
  return await ctx.db.get(id);
}

export async function performUpdateRole(
  ctx: Ctx,
  userId: Id<"users">,
  args: { role_id: string; name?: string; handle?: string; scope?: Scope; charter?: string; status?: "active" | "paused" | "retired"; tenure?: TenureSpec; avatar?: string; from_session?: string; review_backend?: string; api_token?: string; human_decision?: string },
): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  // A retired seat is closed: its handle may already belong to a live role
  // and its sessions have fallen back to their owners. Create a new one.
  if (role.status === "retired") throw new Error("That role is retired");
  // Scope and charter edits are human only (F1, T2): a call carrying the
  // session it runs in is an agent's, and an agent may not widen or narrow
  // what a role owns, nor rewrite the statement of its job. Tenure (S10) and
  // the avatar (S13) are set freely at create and edited the same way here:
  // the host sets whether a seat is standing or a program, like its name.
  if (args.scope !== undefined) await refuseUnlessHuman(ctx, args, "Scope");
  if (args.charter !== undefined) await refuseUnlessHuman(ctx, args, "Charter");
  // Retiring through update is the retire path: sessions must fall back to
  // their owners, not keep pointing at a hidden seat.
  if (args.status === "retired") return performRetireRole(ctx, userId, { role_id: args.role_id });
  const patch: Record<string, any> = { updated_at: Date.now() };
  if (args.review_backend !== undefined) patch.review_backend = normalizeBackend(args.review_backend);
  if (args.tenure !== undefined) patch.tenure = await resolveTenure(ctx, role, args.tenure);
  if (args.avatar !== undefined) { const t = args.avatar.trim(); patch.avatar = t ? normalizeAvatar(t, role.handle) : defaultAvatarFor(role.handle); }
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) throw new Error("A role needs a name");
    patch.name = name;
  }
  if (args.handle !== undefined) {
    const handle = requireHandle(args.handle);
    // The trust ceiling and the one seat per company rule both key on the
    // handle (org-staffing.md S6), so the seat keeps it: retire or hire.
    if (handle !== role.handle && (role.handle === CHIEF_OF_STAFF_HANDLE || handle === CHIEF_OF_STAFF_HANDLE)) {
      throw new Error("The chief of staff seat keeps its handle: retire it with cast role retire, or hire one with cast org staff");
    }
    if (handle !== role.handle && (await handleTaken(ctx, role, handle, role._id))) {
      throw new Error(`Handle @${handle} is already taken in this workspace`);
    }
    patch.handle = handle;
  }
  let overlaps: ScopeOverlap[] | undefined;
  const before = JSON.stringify(scopeIds(role.scope));
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
      old_value: before,
      new_value: JSON.stringify(scopeIds(patch.scope)),
      created_at: patch.updated_at,
    });
    // The role's world just changed shape: an immediate wake so its next
    // frame reads the new scope (org-roles-standing.md T3).
    await enqueueRoleEvent(ctx, role._id, { kind: "immediate", cause: "scope changed: your projects and plans were edited by a person; re-read cast brief" });
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
  args: { role_id: string; reports_to: ReportsTo; note?: string; from_session?: string },
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
  const now = Date.now();
  // The move lands in the role's history: org.health reads the newest row as
  // last_move_at for the stability cooldown. A no-op reparent logs nothing,
  // so it does not restart the clock. Read the old value before the patch.
  const before = role.reports_to;
  const same = before?.kind === reports_to.kind
    && String(reports_to.kind === "role" ? before.role_id : before.user_id) === String(reports_to.kind === "role" ? reports_to.role_id : reports_to.user_id);
  await ctx.db.patch(role._id, { reports_to, updated_at: now });
  const told = { sessions: 0, roles: 0 };
  if (!same) {
    await ctx.db.insert("org_role_history", {
      role_id: role._id,
      user_id: userId,
      actor_type: "user",
      action: "move",
      field: "reports_to",
      old_value: JSON.stringify(before),
      new_value: JSON.stringify(reports_to),
      created_at: now,
    });
    Object.assign(told, await tellRoleMoved(ctx, userId, await ctx.db.get(role._id), args.note));
  }
  return { ...(await ctx.db.get(role._id)), told };
}

// The agents hear about a role move (org-staffing.md S11): the role gets an
// immediate wake carrying the same line a moved session receives, and each
// live hand rides that frame as a passive fact (one row per hand, so the
// role sees which of its hands now report through it to the new parent).
// A role with no standing session has nobody to tell; the rail returns null
// and the counts say so.
async function tellRoleMoved(ctx: Ctx, userId: Id<"users">, role: any, note?: string): Promise<{ sessions: number; roles: number }> {
  const actor = await ctx.db.get(userId);
  const line = reportsToLine(await parentNameOf(ctx, role), note);
  const told = { sessions: 0, roles: 0 };
  const woke = await enqueueRoleEvent(ctx, role._id, {
    kind: "immediate",
    cause: `reporting line: ${line} (${personName(actor)} moved the role)`,
    ref: { table: "org_roles", id: String(role._id), short_id: role.short_id },
  });
  if (!woke) return told;
  told.roles = 1;
  for (const hand of await handsOf(ctx, role)) {
    const row = await enqueueRoleEvent(ctx, role._id, {
      kind: "passive",
      cause: `hand ${hand.short_id ?? String(hand._id).slice(0, 7)}: ${line}`,
      ref: { table: "conversations", id: String(hand._id), short_id: hand.short_id },
    });
    if (row) told.sessions++;
  }
  return told;
}

export type UnseatChoice = "keep" | "retire";

export async function performRetireRole(ctx: any, userId: Id<"users">, args: { role_id: string; standing_session?: UnseatChoice }): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  if (role.status === "retired") return { ...role, cleared: 0, rehomed: 0, interrupted: 0, cancelled_triggers: 0, standing_session: "kept" };
  const now = Date.now();
  // Unseating the chief of staff (org-staffing.md S16) keeps the workspace's
  // standing agent by default: the person is never left without the
  // assistant they had. Any other seat goes down with its role unless asked
  // to stay.
  const keepStanding = (args.standing_session ?? (role.handle === CHIEF_OF_STAFF_HANDLE ? "keep" : "retire")) === "keep";
  // Live hands hear it first (before org_role_id is cleared, or handsOf finds
  // nothing): stop at a safe point; the session now reports to its owner.
  const interrupted = await interruptHands(ctx, role, userId, "role-retired",
    `Your role ${role.name} (@${role.handle}) was retired. Stop at a safe point, pin your state with cast state, and end your turn. This session now reports to its owner.`);
  // The standing session goes down with the seat: its routines are cancelled
  // (or they would fire into a dead role and spend the host's account), its
  // held and pending turns dropped, its anchor decommissioned (kill command,
  // status completed, bot off the team roster). Outbox rows that never
  // flushed are dropped too.
  // Kept (S16), the thread is the assistant the person had before the hire:
  // only the seat's own routine goes, every trigger they armed on it stays,
  // and a message waiting for a wake is delivered as written, since the wake
  // that would have carried it is dropped below.
  let cancelledTriggers = 0;
  const standing = await standingConversationOf(ctx, role);
  if (standing) {
    cancelledTriggers += await cancelTasksOriginatingFrom(ctx, standing._id, now, keepStanding ? (t) => t.title === COMPANY_REVIEW_TITLE : undefined);
    const held: any[] = await ctx.db.query("pending_messages")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", standing._id).eq("status", "held")).collect();
    for (const p of held) await ctx.db.patch(p._id, keepStanding ? { status: "pending" } : { status: "cancelled", cancelled_at: now });
  }
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  if (keepStanding) {
    // The session runs on as a plain standing agent: the anchors row drops
    // the role pointer and answers as the workspace anchor again, the bot
    // is an anchor again, and the thread takes its old title back.
    if (anchor && anchor.status !== "decommissioned") {
      await ctx.db.patch(anchor._id, { org_role_id: undefined, updated_at: now });
      await ctx.db.patch(anchor.bot_user_id, { bot_kind: "anchor" });
    }
    if (standing) {
      const prev = standing.seat_previous;
      await ctx.db.patch(standing._id, {
        standing_role_id: undefined,
        updated_at: now,
        ...(prev ? { title: prev.title, title_is_custom: prev.title_is_custom, seat_previous: undefined } : {}),
      });
    }
  } else {
    if (anchor && anchor.status !== "decommissioned") await decommissionAnchorRow(ctx, anchor);
    // The seat's markers come off the session here, the one site that knows the
    // row was a role's seat (a plain workspace anchor keeps anchor_id so its
    // history still renders under the bot). Without this an adopted session
    // stays "another role's standing session" forever (org-staffing.md S6).
    if (standing) await ctx.db.patch(standing._id, { standing_role_id: undefined, anchor_id: undefined, acting_user_id: undefined, updated_at: now });
  }
  for (const row of await unflushedRowsFor(ctx, role._id)) await ctx.db.delete(row._id);
  const filed: any[] = await ctx.db
    .query("conversations")
    .withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id))
    .collect();
  for (const conv of filed) await ctx.db.patch(conv._id, { org_role_id: undefined });
  // Child roles re-home to the retired role's own parent, the way its sessions
  // fall back to their owners: the tree hides retired roles, so a child left
  // pointing here would draw with no parent. No cycle is possible: the parent
  // was already above this role.
  const children = (await rolesInBoundary(ctx, role)).filter(
    (r) => r.reports_to?.kind === "role" && r.reports_to.role_id.toString() === role._id.toString(),
  );
  for (const child of children) await ctx.db.patch(child._id, { reports_to: role.reports_to, updated_at: now });
  await ctx.db.patch(role._id, { status: "retired", updated_at: now });
  return { ...(await ctx.db.get(role._id)), cleared: filed.length, rehomed: children.length, interrupted, cancelled_triggers: cancelledTriggers, standing_session: standing ? (keepStanding ? "kept" : "retired") : "none" };
}

// Moving a session in the tree is the ownership gesture (org-staffing.md
// S11): one core in sessionOwnership.ts serves the org page, the ownership
// menu and `cast own`/`cast disown`, and it is the one place session_owners
// and org_role_id change together. Re-exported so the org callers keep
// their import.
export { performReparentSession };

// ── Mutations (S5) ────────────────────────────────────────────────────────────

async function requireCaller(ctx: any, apiToken?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Authentication failed: invalid token or session");
  return userId;
}

// Staffing is a person's act (org-staffing.md S1, S4): the chart changes by a
// person's hand on the org page or through a proposal a person accepted
// (orgInit.applyOrgChange calls the perform functions directly and carries
// the decision). The same gate as trust, caps and proposal decisions.
export const create = mutation({
  args: {
    api_token: v.optional(v.string()),
    from_session: v.optional(v.string()),
    name: v.string(),
    handle: v.string(),
    team_id: v.optional(v.id("teams")),
    scope: v.optional(scopeValidator),
    reports_to: v.optional(reportsToValidator),
    charter: v.optional(v.string()),
    review_backend: v.optional(v.string()),
    tenure: v.optional(tenureValidator),
    avatar: v.optional(v.string()),
    // `cast role create` provisions the standing session in the same call
    // unless --no-session; these ride along to provisionStandingAgent.
    provision: v.optional(v.boolean()),
    model: v.optional(v.string()),
    project_path: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    // "Make this a role" on a session (org-roles-run-work.md R2): the session
    // becomes the role's standing session, so no new one starts. A session
    // that cannot be seated throws, and the role is not created either.
    adopt_conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, from_session, provision, model, project_path, agent_type, adopt_conversation_id, ...args }) => {
    await refuseUnlessHuman(ctx, { api_token, from_session }, "Staffing");
    const userId = await requireCaller(ctx, api_token);
    const role = await performCreateRole(ctx, userId, args);
    if (!provision && !adopt_conversation_id) return role;
    const provisioned = await performProvisionRole(ctx, userId, { role_id: String(role._id), model, project_path, agent_type, adopt_conversation_id });
    return { ...(await ctx.db.get(role._id)), provisioned };
  },
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
    tenure: v.optional(tenureValidator),
    avatar: v.optional(v.string()),
    // The session the CLI runs inside, when any: marks the call as an agent's.
    from_session: v.optional(v.string()),
    review_backend: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => performUpdateRole(ctx, await requireCaller(ctx, api_token), { ...args, api_token }),
});

// `cast role scope <handle> --add project:<ref> --remove plan:<ref>` (F1).
export const setScope = mutation({
  args: {
    api_token: v.optional(v.string()),
    role_id: v.string(),
    add: v.optional(v.array(v.string())),
    remove: v.optional(v.array(v.string())),
    from_session: v.optional(v.string()),
    // The person's one edit (org-roles-run-work.md R1): the scope lands and
    // the sessions in it stay with their owner.
    leave_sessions: v.optional(v.boolean()),
  },
  // A role that gains scope takes over the sessions in it (R1), in the same
  // write, and the answer says what moved so the caller can tell the person.
  handler: async (ctx, { api_token, leave_sessions, ...args }) => {
    const userId = await requireCaller(ctx, api_token);
    const role = await performSetRoleScope(ctx, userId, args);
    const took = args.add?.length ? await takeOverSessions(ctx, userId, role._id, { leave: leave_sessions }) : null;
    return { ...role, took_over: took ? { ...took, phrase: takeoverPhrase(role.handle, took, true) } : null };
  },
});

// Naming a project's lead from the project page (org-roles-run-work.md R4):
// one gesture that writes `owner_role_id` and, when the role's scope does not
// list the project, adds it. The owner goes through the charter's own patch
// (the workspace boundary, the retired check) and the scope through the one
// role update (containment, the history row, the role's wake), so neither rule
// is restated here. What happens to the scope is `leadScopeChange`, the same
// answer the web gave the person when they clicked, and a person who may set
// the owner but not reshape the role still names the lead: the scope is left
// for an admin, and the answer says so.
export async function performSetProjectLead(
  ctx: Ctx,
  userId: Id<"users">,
  args: { project_id: Id<"projects">; role_id: string | null },
): Promise<{ owner_role_id: string | null; scope: "added" | "listed" | "whole_workspace" | "outside_parent" | "not_admin" | "cleared"; took_over?: string }> {
  const project = await ctx.db.get(args.project_id);
  if (!project || !(await canAccessProject(ctx as any, userId, project))) throw new Error("Project not found");
  const patch = await charterPatch(ctx, project, { owner: args.role_id }, "projects");
  await ctx.db.patch(project._id, { ...patch, updated_at: Date.now() });
  if (!patch.owner_role_id) return { owner_role_id: null, scope: "cleared" };
  const role = await ctx.db.get(patch.owner_role_id as Id<"org_roles">);
  // The role hears it in its own words whatever happens to its scope.
  await enqueueRoleEvent(ctx, role._id, { kind: "immediate", cause: `you now lead the project ${project.title}: a person named you its lead`, ref: { table: "projects", id: String(project._id) } });
  const cover = await performCoverProjects(ctx, userId, role._id, [project._id]);
  return { owner_role_id: String(role._id), scope: cover.added.length ? "added" : cover.listed.length ? "listed" : cover.skipped[0].reason, took_over: cover.took_over };
}

// A role comes to answer for projects: a project's lead is named (R4), or an
// initiative's owner becomes a role and gains every project of the initiative
// (initiatives-projects-role-page.md I1 "The org"). ONE scope write for both:
// what happens to each project is `leadScopeChange`, the projects the scope
// does not list are added in one role update (containment, the history row,
// the role's wake), and the role takes over the sessions in them once. Safe to
// call with projects the scope already lists, and a person who may not reshape
// the role is told so instead of refused, so the caller's own write stands.
export type CoverProjectsResult = {
  added: string[];
  listed: string[];
  skipped: Array<{ project_id: string; reason: "whole_workspace" | "outside_parent" | "not_admin" | "human_only" }>;
  /** The sentence a person reads when the role took over sessions in the added projects. */
  took_over?: string;
};

export async function performCoverProjects(
  ctx: Ctx,
  userId: Id<"users">,
  roleId: Id<"org_roles">,
  projectIds: Id<"projects">[],
): Promise<CoverProjectsResult> {
  const role = await ctx.db.get(roleId);
  if (!role || role.status === "retired") throw new Error("Role not found");
  const out: CoverProjectsResult = { added: [], listed: [], skipped: [] };
  const roles = await rolesInBoundary(ctx, role);
  const toAdd: Id<"projects">[] = [];
  for (const id of new Set(projectIds)) {
    const change = leadScopeChange(id, role, roles);
    if (change.kind === "add") toAdd.push(id);
    else if (change.kind === "listed") out.listed.push(String(id));
    else out.skipped.push({ project_id: String(id), reason: change.kind });
  }
  if (!toAdd.length) return out;
  if (!(await userCanAdminRole(ctx, userId, role))) {
    out.skipped.push(...toAdd.map((id) => ({ project_id: String(id), reason: "not_admin" as const })));
    return out;
  }
  // A scope edit is human only (F1, T2), and a token call carries no browser
  // identity, so the role update would refuse it and take the caller's own
  // write (naming an owner, adding a project) down with it. Reported instead:
  // the write stands, and the person is told the scope is theirs to widen
  // from the role page. Never claim `human_decision` here: it names a
  // decision a person answered, and this is not one.
  if (!(await ctx.auth?.getUserIdentity?.())) {
    out.skipped.push(...toAdd.map((id) => ({ project_id: String(id), reason: "human_only" as const })));
    return out;
  }
  await performUpdateRole(ctx, userId, { role_id: String(role._id), scope: { project_ids: [...role.scope.project_ids, ...toAdd], plan_ids: role.scope.plan_ids } });
  out.added = toAdd.map(String);
  // A role that gains scope takes over the sessions in it that report to its
  // host and to no role (R1), through the one core every scope gain uses. The
  // sentence is the person's to read once the write lands.
  out.took_over = takeoverPhrase(role.handle, await takeOverSessions(ctx, userId, role._id), true) || undefined;
  return out;
}

export const setProjectLead = mutation({
  args: { project_id: v.id("projects"), role_id: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => performSetProjectLead(ctx, await requireCaller(ctx), args),
});

// ── Line (the-line.md L2) ────────────────────────────────────────────────────
// A scope owns one workflow; absent means the shipped "line" template. The
// sweep that starts it lives in orgLine.ts.
export const DEFAULT_LINE_SLUG = "line";
export const LINE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function lineSlugOf(role: { line_workflow_slug?: string | null }): string {
  return role.line_workflow_slug || DEFAULT_LINE_SLUG;
}

export function normalizeLineSlug(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/\.cast$/, "");
  if (!LINE_SLUG_RE.test(slug)) throw new Error("A line slug is 1 to 64 characters of a-z, 0-9 and -, like line or feature");
  return slug;
}

// Changing the line is a scope edit: human only, logged to org_role_history,
// and the role wakes at once so its next frame reads it.
export async function performSetLine(
  ctx: any,
  userId: Id<"users">,
  args: { role_id: string; slug: string; from_session?: string; api_token?: string; human_decision?: string },
): Promise<any> {
  await refuseUnlessHuman(ctx, args, "Line");
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  if (role.status === "retired") throw new Error("That role is retired");
  const slug = normalizeLineSlug(args.slug);
  const previous = lineSlugOf(role);
  const now = Date.now();
  if (slug !== previous) {
    await ctx.db.patch(role._id, { line_workflow_slug: slug, updated_at: now });
    await ctx.db.insert("org_role_history", {
      role_id: role._id,
      user_id: userId,
      actor_type: "user",
      action: "line",
      field: "line_workflow_slug",
      old_value: previous,
      new_value: slug,
      created_at: now,
    });
    await enqueueRoleEvent(ctx, role._id, { kind: "immediate", cause: `line changed: your scope's tasks now run on the "${slug}" workflow (was "${previous}"); re-read cast brief` });
  }
  const updated = await ctx.db.get(role._id);
  return { ...updated, line_workflow_slug: lineSlugOf(updated), previous_line_workflow_slug: previous };
}

export async function lineOfRole(ctx: any, userId: Id<"users">, args: { role_id: string }): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "access");
  return { role_id: role._id, short_id: role.short_id, handle: role.handle, name: role.name, line_workflow_slug: lineSlugOf(role) };
}

// `cast role line <handle> [--set <slug>]` (L2).
export const line = query({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => lineOfRole(ctx, await requireCaller(ctx, api_token), args),
});
export const setLine = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), slug: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => performSetLine(ctx, await requireCaller(ctx, api_token), { ...args, api_token }),
});

export const reparent = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), reports_to: reportsToValidator, note: v.optional(v.string()), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => {
    await refuseUnlessHuman(ctx, { api_token, from_session: args.from_session }, "Staffing");
    return performReparentRole(ctx, await requireCaller(ctx, api_token), args);
  },
});

export const retire = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), role_id: v.string(), standing_session: v.optional(v.union(v.literal("keep"), v.literal("retire"))) },
  handler: async (ctx, { api_token, from_session, ...args }) => {
    await refuseUnlessHuman(ctx, { api_token, from_session }, "Staffing");
    return performRetireRole(ctx, await requireCaller(ctx, api_token), args);
  },
});

export const reparentSession = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.string(),
    target: v.union(
      v.object({
        kind: v.literal("user"),
        user_id: v.optional(v.id("users")),
        owners: v.optional(v.array(v.string())),
        mode: v.optional(v.union(v.literal("set"), v.literal("add"), v.literal("remove"))),
      }),
      v.object({ kind: v.literal("role"), role_id: v.string() }),
    ),
    note: v.optional(v.string()),
    from_session: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, conversation_id, ...args }) => {
    const authUserId = await requireCaller(ctx, api_token);
    const result = await performReparentSession(ctx, authUserId, { session_id: conversation_id, ...args });
    // The ownership menu now reaches the core through here (org-staffing.md
    // S11), so this path must notify the assignee exactly as addSessionOwner
    // did: the "assigned to you" push and inbox row, and the ownership-changed
    // notice. Without these an owner added from the chart or the menu would
    // hear nothing. notifySessionAssigned skips the actor and an empty set.
    await notifySessionAssigned(ctx, result.conversation_id, result.added, authUserId, args.note?.trim());
    await notifySessionOwnershipChanged(ctx, result.conversation_id, result, authUserId);
    return result;
  },
});

// ── Standing agent (org-roles-standing.md T1, T2, T4) ────────────────────────

const BACKENDS = new Set(["claude", "claude_code", "codex", "cursor", "gemini", "opencode", "pi", "grok", "muse"]);
function normalizeBackend(raw: string | undefined): string | undefined {
  const b = (raw ?? "").trim().toLowerCase();
  if (!b) return undefined;
  if (!BACKENDS.has(b)) throw new Error(`Unknown review backend "${raw}"; use one of claude, codex, cursor, gemini, opencode, pi, grok`);
  return b === "claude_code" ? "claude" : b;
}

// The line's review station must run on a backend other than the role's own
// (the-line.md L3). One rule, one message; the CLI prints it when it refuses.
export function reviewBackendConflict(role: { review_backend?: string | null }, ownAgent: string | undefined): string | null {
  const review = role.review_backend ?? null;
  if (!review) return null;
  const own = (ownAgent ?? "claude_code") === "claude_code" ? "claude" : (ownAgent ?? "claude");
  return review === own
    ? `Review backend "${review}" is this role's own agent; the line's review station must run on a different backend for an independent review (the-line.md L3). Set one with cast role update @handle --review-backend <agent>.`
    : null;
}

export const TRUST_STAGES = ["understand", "decide", "direct"] as const;

// The human only gate (T4): trust, caps, scope and the charter are a
// person's to change. Identity is the browser's auth session, never a body
// field: an api token call is a terminal's, and a terminal can be a hand's
// (a hand runs under its host's token, and the host is the role's admin).
// The from_session check stays only for the friendlier message.
//
// `human_decision` is the one other authority: a decision a person answered
// (session_decisions.answered_by.kind === "user"), applied by cast org apply
// (orgInit.performApplyDecision). It is a server side option, never a wire
// field: no mutation validator admits it, so a body cannot claim it.
export async function refuseUnlessHuman(ctx: any, args: { api_token?: string; from_session?: string; human_decision?: string }, what: string): Promise<void> {
  if (args.human_decision) return;
  if (args.from_session) throw new Error(`${what} changes are human only: an agent session may not make them; use the role page`);
  const identity = args.api_token ? null : await ctx.auth?.getUserIdentity?.();
  if (!identity) throw new Error(`${what} changes are human only: make them from the role page in the browser`);
}

async function scopeNamesOf(ctx: Ctx, role: any): Promise<string[]> {
  const names: string[] = [];
  for (const id of role.scope?.project_ids ?? []) { const p = await ctx.db.get(id); if (p) names.push(`project ${p.title}`); }
  for (const id of role.scope?.plan_ids ?? []) { const p = await ctx.db.get(id); if (p) names.push(`plan ${p.short_id} ${p.title}`); }
  return names;
}

async function parentNameOf(ctx: Ctx, role: any): Promise<string> {
  if (role.reports_to?.kind === "role") {
    const parent = await ctx.db.get(role.reports_to.role_id);
    return parent ? `${parent.name} (@${parent.handle})` : "a role";
  }
  const user = role.reports_to?.user_id ? await ctx.db.get(role.reports_to.user_id) : null;
  return user?.name || user?.email?.split("@")[0] || "a person";
}

// The rules of a role, as the charter carries them. The charter rides every
// restart frame in full, so a rule here survives compaction where the
// bootstrap message does not (anchors.ts bootstrapMessage says the same rules
// at length).
export const ROLE_RULES = [
  "1. Wake, read, act, brief: every turn starts from the frame and ends by updating the brief.",
  "2. Stay inside the scope; what falls outside goes up the reporting line.",
  "3. Escalate with a recommendation attached, never as a bare question.",
  "4. Caps on wakes, hands and tokens per day are real; a held cap is reported in the brief, not worked around.",
  "5. A person's message is answered here or handed on to a hand, and the reply says which; a request to remember or forget is a brief write in the same turn.",
  "6. Your sessions stay out of a person's inbox, so at every wake you read which of them wait on a person, answer what you may, and escalate the rest with one line saying what the person will decide.",
  "7. The people who report to you keep their goals in your brief, one section each; at every wake you read their sessions against those goals, update the matches, and name what stalled.",
];

export function charterTemplate(role: { name: string; handle: string; charter?: string | null }, scopeNames: string[], parentName: string): string {
  return [
    `# Charter: ${role.name} (@${role.handle})`,
    ``,
    role.charter?.trim() || `${role.name} owns the work in its scope on behalf of ${parentName}: it keeps the scope's plans and tasks moving, reports what changed and why, and raises what needs a person with a recommendation.`,
    ``,
    `## Scope`,
    scopeNames.length ? scopeNames.map((n) => `- ${n}`).join("\n") : `- the whole workspace`,
    ``,
    `## Rules`,
    ...ROLE_RULES,
  ].join("\n");
}

function briefTemplate(role: { name: string }): string {
  return [
    `${role.name}: newly provisioned, no wake yet`,
    `Status: waiting for the first frame`,
    `Next: read the charter, then post a one line hello`,
  ].join("\n");
}

async function insertRoleDoc(ctx: Ctx, userId: Id<"users">, role: any, docType: "charter" | "brief", title: string, content: string): Promise<Id<"docs">> {
  const now = Date.now();
  return await ctx.db.insert("docs", {
    user_id: userId,
    team_id: role.team_id ?? undefined,
    title,
    content,
    doc_type: docType,
    source: docType === "charter" ? "human" : "agent",
    created_at: now,
    updated_at: now,
  });
}

// The conversation an adopt names must be the caller's own plain session: not
// a hand (it reports to a seat already) and not another role's standing
// session. The role's own standing session is accepted, so a repeat is a no-op.
async function requireAdoptable(ctx: Ctx, userId: Id<"users">, role: any, ref: string): Promise<any> {
  // The workspace anchor's session (org-staffing.md S12) is the company's,
  // not only its host's: whoever may reshape the anchor may seat it.
  const conv = await findConversationByAnyRefWhere(ctx, ref, async (c: any) => {
    if ((await checkConversationAccess(ctx, userId, c)) === "owner") return true;
    const anchor = c.anchor_id && !c.standing_role_id ? await ctx.db.get(c.anchor_id) : null;
    return !!anchor && anchor.status !== "decommissioned" && (await userCanAdminAnchor(ctx, userId, anchor));
  });
  if (!conv) throw new Error("Session not found, or you are not one of its owners");
  if (conv.org_role_id) throw new Error("That session is a hand of a role; a hand cannot become a standing session");
  // A pointer at a live role refuses; one left by a seat retired before
  // retire learned to clear it is stale and the row is free.
  if (conv.standing_role_id && String(conv.standing_role_id) !== String(role._id)) {
    const holder = await ctx.db.get(conv.standing_role_id);
    if (holder && holder.status !== "retired") throw new Error("That session is already another role's standing session");
  }
  if (role.team_id && (conv.team_id?.toString() ?? null) !== role.team_id.toString()) throw new Error("That session is not in the role's team");
  return conv;
}

// provision — the role becomes a live agent: charter and brief docs, a bot
// identity, an anchors row with org_role_id, and a persistent session
// carrying standing_role_id. Idempotent per role. With `adopt_conversation_id`
// (org-staffing.md S6) the given session becomes the standing session instead
// of a new one being started.
export async function performProvisionRole(
  ctx: any,
  userId: Id<"users">,
  args: { role_id: string; model?: string; project_path?: string; agent_type?: string; adopt_conversation_id?: string; announce?: string },
): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  if (role.status === "retired") throw new Error("That role is retired");
  const adopt = args.adopt_conversation_id ? await requireAdoptable(ctx, userId, role, args.adopt_conversation_id) : undefined;
  const scopeNames = await scopeNamesOf(ctx, role);
  const parentName = await parentNameOf(ctx, role);
  const patch: Record<string, any> = { updated_at: Date.now() };
  if (!role.charter_doc_id) patch.charter_doc_id = await insertRoleDoc(ctx, userId, role, "charter", `Charter: ${role.name}`, charterTemplate(role, scopeNames, parentName));
  if (!role.brief_doc_id) patch.brief_doc_id = await insertRoleDoc(ctx, userId, role, "brief", `Brief: ${role.name}`, briefTemplate(role));
  if (!role.trust) patch.trust = "understand";
  if (!role.caps) patch.caps = { ...DEFAULT_CAPS };
  const bootstrap: RoleBootstrap = { handle: role.handle, scopeNames, parentName, trust: trustOf(role) };
  const agentType = args.agent_type ? (normalizeBackend(args.agent_type) === "claude" ? "claude_code" : normalizeBackend(args.agent_type)) : undefined;
  const provisioned = await provisionStandingAgent(ctx, userId, {
    scope_type: role.scope_type,
    team_id: role.team_id ?? undefined,
    name: role.name,
    project_path: args.project_path ?? adopt?.project_path ?? undefined,
    model: args.model,
    agent_type: agentType as any,
    role: { _id: role._id, bootstrap, adopt, announce: adopt ? args.announce : undefined },
  });
  patch.anchor_id = provisioned.anchor_id;
  await ctx.db.patch(role._id, patch);
  return { ...provisioned, role_id: role._id, role_short_id: role.short_id, handle: role.handle, adopted: !!adopt && !provisioned.already_existed };
}

export const provision = mutation({
  args: {
    api_token: v.optional(v.string()),
    role_id: v.string(),
    model: v.optional(v.string()),
    project_path: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    adopt_conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => performProvisionRole(ctx, await requireCaller(ctx, api_token), args),
});

// ── The Chief of Staff (docs/architecture/org-staffing.md S6) ────────────────
//
// One role per company, handle `chief-of-staff`, scope the whole company,
// trust understand and never above: it reads how work flows, proposes the
// chart, and applies nothing. `performStaff` creates it, provisions or adopts
// its standing session, arms the weekly company review on that session and
// queues the first review as an immediate wake. Idempotent per company.

export const CHIEF_OF_STAFF_NAME = "Chief of Staff";
export const COMPANY_REVIEW_TITLE = "Company review";
export const COMPANY_REVIEW_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

export const CHIEF_OF_STAFF_CHARTER = [
  `You are the chief of staff of this company. The executives decide; you propose. Your job is to see how work actually flows, between people, roles and hands, and to propose the organization that lets it flow better.`,
  ``,
  `Read before you touch the chart. Every proposal rests on what \`cast org health\`, \`cast org inputs\` and the roles' briefs show: who is overloaded, who is idle, where decisions wait, where reviews stall, which projects have no owner and which work has no home. What you cannot verify you say you could not verify; you never invent tasks to justify a role.`,
  ``,
  `Size every scope against the capacity model: one role holds one context window, and a person answers for only so many roles. Respect the stability rules: a chart that moves every review never settles, so a recent move gets time to work, an overload is a pattern before it is a split, and an idle role is retired only when the company around it is busy.`,
  ``,
  `Propose the smallest change that removes a bottleneck, and say what you expect it to change and how you will know. Staffing is budgeting: a change that moves scope or people moves budget with it, and the budgets under a person must add up to what that person allowed.`,
  ``,
  `Every change carries evidence a person can click: counts, session and task short ids, commits. You never apply a change yourself; a person accepts, edits or skips each one on the org page or at a shell. Anything about budget or people goes to the person you report to, with your recommendation attached.`,
  ``,
  `Write for a founder reading on a phone: the summary first, one idea per sentence, no jargon of your own making.`,
  ``,
  `## The capacity model`,
  renderCapacityModel(),
].join("\n");

// The seating note (org-staffing.md S16): one message from the person who
// seated the agent, read before the briefing. It names the new job in a
// sentence, links the role page, and says what did not change, so a thread
// the person already talks to never reads as taken over.
export function seatingNote(role: { short_id: string; handle: string; name: string }, workspaceName: string): string {
  return [
    `I have seated you as the ${role.name} of ${workspaceName} (@${role.handle}, ${role.short_id}): ${siteUrl()}/org/${role.short_id}.`,
    `Your job now is to read how work flows across the company and propose the organization that lets it flow better; the weekly company review is part of it.`,
    `Nothing else changed: your memory, your handle, your chat and Slack bindings and this thread are as they were.`,
    `The next message is your briefing. Once you have read it, restate your job in your own words.`,
  ].join("\n");
}

// The routine's prompt: the standing session runs the review and proposes only
// when the stability rules warrant it.
export const COMPANY_REVIEW_PROMPT = [
  `Company review. Run \`cast org review\` (it reads \`cast org health --json\` and the inputs) and read each role's brief.`,
  `Propose changes only when the stability rules in your charter warrant them: a bottleneck the flags show more than once, a role idle past the retire window while the company works, a project with no owner or no charter. A program role whose end has arrived (health flags it \`program_ended\`) is due rather than a judgement call: propose the retirement or the review its tenure names. When nothing warrants a change, say so in one line in your brief and end the turn; a quiet review is a good review.`,
  `Every proposed change carries evidence a person can click. You apply nothing.`,
].join("\n");

// The seat's live review routine, brought up to the current prompt. The
// routine holds its own copy of the text, so a prompt change reaches a seat
// already hired only through here: the one audited writer for routine edits.
async function liveCompanyReview(ctx: any, standing: any): Promise<any | null> {
  const rows: any[] = await ctx.db
    .query("agent_tasks")
    .withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", standing._id))
    .collect();
  const live = rows.find((t) => t.title === COMPANY_REVIEW_TITLE && (t.status === "scheduled" || t.status === "running"));
  if (live) await applyTaskUpdate(ctx, live, { prompt: COMPANY_REVIEW_PROMPT }, { userId: standing.user_id, source: "cli" });
  return live ?? null;
}

// The review routine on the standing session, once. Keyed on its title so a
// repeat staff call, or a re-provision, never arms a second one.
async function ensureCompanyReview(ctx: any, standing: any, everyMs: number): Promise<{ id: Id<"agent_tasks">; short_id?: string; created: boolean }> {
  const live = await liveCompanyReview(ctx, standing);
  if (live) return { id: live._id, short_id: live.short_id, created: false };
  const interval = Math.max(60_000, Math.round(everyMs || COMPANY_REVIEW_EVERY_MS));
  const created = await insertTask(ctx, standing.user_id, {
    title: COMPANY_REVIEW_TITLE,
    prompt: COMPANY_REVIEW_PROMPT,
    originating_conversation_id: String(standing._id),
    project_path: standing.project_path ?? undefined,
    schedule_type: "recurring",
    interval_ms: interval,
    run_at: Date.now() + interval,
    mode: "apply",
  });
  return { ...created, created: true };
}

export type SeatChoice = "existing" | "fresh";

export async function performStaff(
  ctx: any,
  userId: Id<"users">,
  args: { team_id?: Id<"teams">; reports_to?: Id<"users">; adopt_conversation_id?: string; every_ms?: number; project_path?: string; seat?: SeatChoice },
): Promise<{
  role: { _id: Id<"org_roles">; short_id: string; handle: string; name: string };
  standing: { conversation_id: Id<"conversations">; short_id?: string } | null;
  routine: { id: Id<"agent_tasks">; short_id?: string } | null;
  created: boolean;
  adopted: boolean;
  already_existed: boolean;
  // What happened to the workspace's standing agent (S16): the existing one
  // was seated, or a fresh session was started and the old one retired.
  seated: SeatChoice;
  conversation_short_id: string | null;
  previous_title: string | null;
  // The retired standing agent's thread, kept and linked from the role page.
  previous_standing: { conversation_id: Id<"conversations">; short_id?: string } | null;
}> {
  const boundary = args.team_id ? { team_id: args.team_id } : { scope_user_id: userId };
  const existing = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === CHIEF_OF_STAFF_HANDLE);
  const role = existing ?? await performCreateRole(ctx, userId, {
    name: CHIEF_OF_STAFF_NAME,
    handle: CHIEF_OF_STAFF_HANDLE,
    team_id: args.team_id,
    reports_to: { kind: "user", user_id: args.reports_to ?? userId },
    charter: CHIEF_OF_STAFF_CHARTER,
  });
  const created = !existing;
  // A seat that already stands is left as it is: the standing session, its
  // routine and its first review happened once. Only a seat with no session
  // yet (created earlier without provisioning) is provisioned now.
  // A seat whose anchor was decommissioned on its own (`cast anchor rm`) is
  // empty again: staff fills it rather than reporting a dead chief as hired.
  const seatAnchor = existing?.anchor_id ? await ctx.db.get(existing.anchor_id) : null;
  const already_existed = !!seatAnchor && seatAnchor.status !== "decommissioned";
  if (already_existed && args.adopt_conversation_id) {
    const named = await findConversationByAnyRefWhere(ctx, args.adopt_conversation_id, async () => true);
    if (!named || String(named._id) !== String(seatAnchor.conversation_id)) {
      throw new Error("The chief of staff already stands in another session; retire it first to seat this one");
    }
  }
  // The chief of staff IS the workspace's standing agent (S12, S16). With a
  // standing agent already in the workspace and no session named, the
  // default seats it: nothing restarts, the anchors row gains the role
  // pointer. `fresh` starts a new session and retires the old agent in the
  // same act, its thread kept and linked from the role, so the workspace
  // never ends with two root agents.
  const anchor = already_existed ? null : await workspaceAnchorFor(ctx, boundary);
  const seat: SeatChoice = args.seat ?? (args.adopt_conversation_id || anchor ? "existing" : "fresh");
  if (already_existed && args.seat && args.seat !== "existing") {
    throw new Error("The chief of staff already stands; retire it first to seat a fresh session");
  }
  let previousStanding: { conversation_id: Id<"conversations">; short_id?: string } | null = null;
  let adoptId = args.adopt_conversation_id;
  let previousTitle: string | null = null;
  if (!already_existed) {
    if (seat === "existing" && !adoptId && anchor?.conversation_id) adoptId = String(anchor.conversation_id);
    if (seat === "fresh") {
      adoptId = undefined;
      if (anchor && anchor.status !== "decommissioned") {
        if (!(await userCanAdminAnchor(ctx, userId, anchor))) throw new Error("Only the standing agent's host or a team admin can retire it for a fresh seat");
        const old = anchor.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
        await decommissionAnchorRow(ctx, anchor);
        if (old) {
          previousStanding = { conversation_id: old._id, short_id: old.short_id ?? undefined };
          await ctx.db.patch(role._id, { previous_standing_conversation_id: old._id, updated_at: Date.now() });
        }
      }
    }
    if (adoptId) {
      const adopting = await findConversationByAnyRefWhere(ctx, adoptId, async () => true);
      previousTitle = adopting?.title ?? null;
    }
  }
  const workspaceName = args.team_id ? ((await ctx.db.get(args.team_id))?.name ?? "the team") : "your workspace";
  const provisioned = already_existed
    ? null
    : await performProvisionRole(ctx, userId, {
      role_id: String(role._id),
      adopt_conversation_id: adoptId,
      project_path: args.project_path ?? anchor?.project_path ?? undefined,
      announce: seatingNote(role, workspaceName),
    });
  const fresh = await ctx.db.get(role._id);
  const standing = await standingConversationOf(ctx, fresh);
  let routine: { id: Id<"agent_tasks">; short_id?: string } | null = null;
  if (standing) {
    const ensured = await ensureCompanyReview(ctx, standing, args.every_ms ?? COMPANY_REVIEW_EVERY_MS);
    routine = { id: ensured.id, short_id: ensured.short_id };
    // The first review runs at once: an immediate wake carrying the prompt,
    // the same rail a fired routine rides (org-roles-standing.md T3).
    if (provisioned) await enqueueRoleEvent(ctx, fresh._id, { kind: "immediate", cause: `first ${COMPANY_REVIEW_TITLE.toLowerCase()}:\n${COMPANY_REVIEW_PROMPT}` });
  }
  return {
    role: { _id: fresh._id, short_id: fresh.short_id, handle: fresh.handle, name: fresh.name },
    standing: standing ? { conversation_id: standing._id, short_id: standing.short_id ?? undefined } : null,
    routine,
    created,
    adopted: !!provisioned?.adopted,
    already_existed,
    seated: already_existed ? "existing" : seat,
    conversation_short_id: standing?.short_id ?? (standing ? String(standing._id).slice(0, 7) : null),
    previous_title: previousTitle,
    previous_standing: previousStanding ?? (fresh.previous_standing_conversation_id
      ? { conversation_id: fresh.previous_standing_conversation_id, short_id: (await ctx.db.get(fresh.previous_standing_conversation_id))?.short_id ?? undefined }
      : null),
  };
}

// One-time backfill (S16): a chief seated before seating learned to explain
// itself sits in a thread still titled after the anchor, with no note. Bring
// every such seat up to the shipped behaviour: keep the current title in
// seat_previous, retitle after the role, and post the seating note from the
// role's host. Idempotent: a thread that carries seat_previous is skipped.
// Run once on prod: `npx convex run orgRoles:backfillSeatedChiefs '{"dry_run":true}'`, then without.
export async function performBackfillSeatedChiefs(ctx: any, dryRun: boolean): Promise<{ dry_run: boolean; updated: Array<{ role: string; conversation: string | null; previous_title: string | null; title: string; workspace: string }>; skipped: number }> {
  const roles: any[] = await ctx.db.query("org_roles").collect();
  const updated: Array<{ role: string; conversation: string | null; previous_title: string | null; title: string; workspace: string }> = [];
  let skipped = 0;
  for (const role of roles) {
    if (role.handle !== CHIEF_OF_STAFF_HANDLE || role.status === "retired" || !role.anchor_id) continue;
    const standing = await standingConversationOf(ctx, role);
    // Refresh only: a routine a person cancelled stays cancelled.
    if (standing && !dryRun) await liveCompanyReview(ctx, standing);
    // Nothing to explain: already explained (seat_previous is the mark), a
    // thread born as the role (a fresh seat was never anyone's assistant, and
    // its title is the role's from its first row), or a note already waiting.
    const bornAsRole = !!standing && standing.title === role.name && standing.title_is_custom === true;
    const noteWaiting = !!standing && (await ctx.db.query("pending_messages")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", standing._id).eq("status", "pending")).collect())
      .some((p: any) => typeof p.client_id === "string" && p.client_id.startsWith("seat:"));
    if (!standing || standing.seat_previous || bornAsRole || noteWaiting) { skipped++; continue; }
    const workspace = role.team_id ? ((await ctx.db.get(role.team_id))?.name ?? "the team") : "your workspace";
    if (!dryRun) {
      await ctx.db.patch(standing._id, { ...seatTitlePatch(standing, role.name), updated_at: Date.now() });
      await announceSeating(ctx, standing._id, role.host_user_id, seatingNote(role, workspace));
    }
    updated.push({ role: role.short_id, conversation: standing.short_id ?? null, previous_title: standing.title ?? null, title: role.name, workspace });
  }
  return { dry_run: dryRun, updated, skipped };
}

export const backfillSeatedChiefs = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => performBackfillSeatedChiefs(ctx, !!args.dry_run),
});

// What each seated chief's thread looks like now: for verifying the backfill.
export const seatedChiefs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const roles: any[] = await ctx.db.query("org_roles").collect();
    const out: any[] = [];
    for (const role of roles) {
      if (role.handle !== CHIEF_OF_STAFF_HANDLE || role.status === "retired") continue;
      const standing = await standingConversationOf(ctx, role);
      const pending: any[] = standing
        ? await ctx.db.query("pending_messages").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", standing._id).eq("status", "pending")).collect()
        : [];
      const note = pending.find((p) => typeof p.client_id === "string" && p.client_id.startsWith("seat:"));
      out.push({
        role: role.short_id, workspace: role.team_id ? ((await ctx.db.get(role.team_id as Id<"teams">))?.name ?? null) : "personal", status: role.status,
        conversation: standing?.short_id ?? null, title: standing?.title ?? null, title_is_custom: standing?.title_is_custom ?? null, seat_previous: standing?.seat_previous ?? null,
        seating_note: note ? { status: note.status, head: String(note.content).split("\n").slice(0, 2).join(" | ") } : null,
      });
    }
    return out;
  },
});

export const staff = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    reports_to: v.optional(v.id("users")),
    adopt_conversation_id: v.optional(v.string()),
    every_ms: v.optional(v.number()),
    project_path: v.optional(v.string()),
    seat: v.optional(v.union(v.literal("existing"), v.literal("fresh"))),
    from_session: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, from_session: _from, ...args }) => performStaff(ctx, await requireCaller(ctx, api_token), args),
});

// The standing session behind a role, or null when none was provisioned.
export async function standingConversationOf(ctx: Ctx, role: any): Promise<any | null> {
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  return anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
}

async function handsOf(ctx: Ctx, role: any): Promise<any[]> {
  const rows: any[] = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id)).collect();
  return rows.filter((c) => c.status === "active" && !c.inbox_killed_at);
}

// pause — flush holds; hands get one interrupt; the spawn path refuses new
// hands. resume — held rows ship as one wake.
export async function performPauseRole(ctx: any, userId: Id<"users">, args: { role_id: string }): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  if (role.status === "retired") throw new Error("That role is retired");
  // Idempotent: a second pause changes nothing and interrupts nobody twice.
  if (role.status === "paused") return { ...role, interrupted: 0 };
  await ctx.db.patch(role._id, { status: "paused", updated_at: Date.now() });
  const interrupted = await interruptHands(ctx, role, userId, "role-paused",
    `Your role ${role.name} (@${role.handle}) was paused. Stop at a safe point: finish the step in flight, pin your state with cast state, and end your turn.`);
  return { ...(await ctx.db.get(role._id)), interrupted };
}

// Tell every LIVE hand of a role to stop at a safe point. Only a hand whose
// agent is producing is told; a dormant hand would be woken for one turn
// just to be told to rest. Shared by pause and retire.
export async function interruptHands(ctx: any, role: any, userId: Id<"users">, tag: string, text: string): Promise<number> {
  let interrupted = 0;
  for (const hand of await handsOf(ctx, role)) {
    const managed = await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", hand._id)).first();
    if (!managed || !ACTIVE_AGENT_STATUSES.has(managed.agent_status ?? "")) continue;
    await enqueuePendingMessage(ctx, hand, userId, {
      content: `<${tag} ${role.short_id}>${text}</${tag}>`,
      client_id: `${tag}:${role._id}:${hand._id}`,
    });
    interrupted++;
  }
  return interrupted;
}

export async function performResumeRole(ctx: any, userId: Id<"users">, args: { role_id: string }): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  if (role.status !== "paused") return await ctx.db.get(role._id);
  await ctx.db.patch(role._id, { status: "active", updated_at: Date.now() });
  await scheduleFlush(ctx, role._id, 0);
  return await ctx.db.get(role._id);
}

// restart — kill and resume the standing session; the next frame carries the
// charter and the brief in full.
export async function performRestartRole(ctx: any, userId: Id<"users">, args: { role_id: string }): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  const conv = await standingConversationOf(ctx, role);
  if (!conv) throw new Error("This role has no standing session yet (cast role create provisions one, or run cast role provision)");
  await enqueueKillAndResume(ctx, conv.user_id, conv);
  await enqueueRoleEvent(ctx, role._id, { kind: "immediate", cause: `${RESTART_CAUSE} your session was restarted; the charter and brief follow in full` });
  return { role_id: role._id, conversation_id: conv._id, short_id: conv.short_id };
}

// trust — human only, logged on the charter as a doc entry.
export async function performSetTrust(ctx: any, userId: Id<"users">, args: { role_id: string; trust: string; from_session?: string; api_token?: string; human_decision?: string }): Promise<any> {
  await refuseUnlessHuman(ctx, args, "Trust stage");
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  const trust = args.trust.trim().toLowerCase();
  if (!(TRUST_STAGES as readonly string[]).includes(trust)) throw new Error(`Unknown trust stage "${args.trust}"; use understand, decide or direct`);
  // The chief of staff proposes and applies nothing (org-staffing.md S6): its
  // trust never rises above understand.
  if (role.handle === CHIEF_OF_STAFF_HANDLE && trust !== "understand") throw new Error("The chief of staff stays at understand: it proposes, a person applies");
  const previous = trustOf(role);
  const now = Date.now();
  await ctx.db.patch(role._id, { trust, updated_at: now });
  if (role.charter_doc_id) {
    const charter = await ctx.db.get(role.charter_doc_id);
    if (charter) {
      const user = await ctx.db.get(userId);
      const entries = [...(charter.entries ?? []), { type: "note", timestamp: now, content: `Trust stage ${previous} → ${trust}`, author: user?.name ?? "a person" }];
      await ctx.db.patch(charter._id, { entries, updated_at: now });
    }
  }
  return { ...(await ctx.db.get(role._id)), previous_trust: previous };
}

export async function performSetCaps(ctx: any, userId: Id<"users">, args: { role_id: string; hands?: number; wakes?: number; tokens?: number; from_session?: string; api_token?: string; human_decision?: string }): Promise<any> {
  await refuseUnlessHuman(ctx, args, "Cap");
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  const caps = capsFor(role);
  const pos = (n: number | undefined, name: string) => {
    if (n === undefined) return undefined;
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non negative number`);
    return Math.floor(n);
  };
  const next = {
    hands_per_day: pos(args.hands, "--hands") ?? caps.hands_per_day,
    wakes_per_day: pos(args.wakes, "--wakes") ?? caps.wakes_per_day,
    tokens_per_day: pos(args.tokens, "--tokens") ?? caps.tokens_per_day,
  };
  await ctx.db.patch(role._id, { caps: next, updated_at: Date.now() });
  return { ...(await ctx.db.get(role._id)), caps: next };
}

// wake — a person (or their session) pokes the role. The message rides the
// standing session's rail; enqueuePendingMessage turns it into an immediate
// outbox row, so the frame carries it.
export async function performWakeRole(ctx: any, userId: Id<"users">, args: { role_id: string; message: string; from_session?: string }): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "access");
  const conv = await standingConversationOf(ctx, role);
  if (!conv) throw new Error("This role has no standing session yet");
  const from = await callerSession(ctx, userId, args.from_session);
  const pendingId = await enqueuePendingMessage(ctx, conv, userId, {
    content: args.message,
    from_conversation_id: from?._id,
    human: !from,
  });
  // The flush holds every row while the role is paused (orgWakes gate 1), so
  // the caller learns the line waits for a resume rather than a wake.
  return { role_id: role._id, conversation_id: conv._id, short_id: conv.short_id, pending_message_id: pendingId, held: wakeIsHeld(role) };
}

/** A paused role reads its lines when someone resumes it (orgWakes gate 1). */
export function wakeIsHeld(role: { status: string }): boolean {
  return role.status === "paused";
}

export async function listWakes(ctx: Ctx, userId: Id<"users">, args: { role_id: string; limit?: number }): Promise<any[]> {
  const role = await requireRole(ctx, userId, args.role_id, "access");
  const rows: any[] = await ctx.db
    .query("role_wakes")
    .withIndex("by_role_created", (q: any) => q.eq("role_id", role._id))
    .order("desc")
    .take(Math.min(Math.max(args.limit ?? 20, 1), 200));
  return rows;
}

// brief edit — the narrative from stdin; its first line mirrors into the
// standing session's thread state (the same four fields stateCommand writes).
export async function performBriefEdit(ctx: any, userId: Id<"users">, args: { role_id: string; content: string; from_session?: string }): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "access");
  // Who may write: the role's own standing session, or a person who can
  // reshape the role (its parent side).
  const from = await callerSession(ctx, userId, args.from_session);
  const isOwnSession = !!from && String(from.standing_role_id ?? "") === String(role._id);
  if (!isOwnSession && !(await userCanAdminRole(ctx, userId, role))) {
    throw new Error("Only the role's own session or an admin of the role may edit its brief");
  }
  const content = args.content.trim();
  if (!content) throw new Error("An empty brief: pass the narrative on stdin");
  const now = Date.now();
  let briefDocId = role.brief_doc_id;
  if (!briefDocId) {
    briefDocId = await insertRoleDoc(ctx, userId, role, "brief", `Brief: ${role.name}`, content);
    await ctx.db.patch(role._id, { brief_doc_id: briefDocId, updated_at: now });
  } else {
    await ctx.db.patch(briefDocId, { content, updated_at: now });
  }
  const mirror = await mirrorBriefState(ctx, role, content);
  return { role_id: role._id, brief_doc_id: briefDocId, ...mirror };
}

// The first line (plus the Status:/Next:/Blocked: lines) is the standing
// session's thread state, written through the one path `cast state` uses.
// The status word after "Status:" is read the way `cast state --status`
// reads its flag; anything else is "working". One mirror for every path that
// writes a brief: cast brief edit, docs.update, the collab editor's snapshot.
export async function mirrorBriefState(ctx: any, role: any, content: string): Promise<{ state: string; status: string; mirrored: boolean }> {
  const conv = await standingConversationOf(ctx, role);
  const text = normalizeThreadState(briefStateText(content));
  const statusLine = content.split("\n").find((l) => /^Status:/i.test(l.trim())) ?? "";
  const status = parseThreadStateStatus(statusLine.replace(/^Status:\s*/i, "").trim().split(/\s+/)[0] ?? "") ?? "working";
  if (conv && text) await performSetThreadState(ctx, conv, text, status);
  return { state: text.split("\n")[0], status, mirrored: !!(conv && text) };
}

// The role a brief or charter doc belongs to: the doc carries no back pointer,
// so the boundary's roles are scanned for the one naming this doc.
async function rolesOwningDoc(ctx: Ctx, doc: any, field: "brief_doc_id" | "charter_doc_id"): Promise<any[]> {
  const rows: any[] = doc.team_id
    ? await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", doc.team_id)).collect()
    : await ctx.db.query("org_roles").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", doc.user_id)).collect();
  return rows.filter((role) => String(role[field] ?? "") === String(doc._id));
}

// A charter edit wakes its role at once (T3): the rules just changed.
export async function wakeRolesOfCharter(ctx: Ctx, doc: any): Promise<void> {
  for (const role of await rolesOwningDoc(ctx, doc, "charter_doc_id")) {
    await enqueueRoleEvent(ctx, role._id, {
      kind: "immediate",
      cause: `your charter changed; re-read it (cast brief) before acting`,
      ref: { table: "docs", id: String(doc._id) },
    });
  }
}

// After any write to a role document's content, whichever path wrote it: a
// brief mirrors its first line into the standing session's state (T2); a
// charter wakes the role (T3). Other doc types are untouched.
export async function afterRoleDocWrite(ctx: Ctx, doc: any, content: string): Promise<void> {
  if (doc?.doc_type === "brief") {
    for (const role of await rolesOwningDoc(ctx, doc, "brief_doc_id")) await mirrorBriefState(ctx, role, content);
  } else if (doc?.doc_type === "charter") {
    await wakeRolesOfCharter(ctx, doc);
  }
}

// The session the caller RUNS (lib/actor: identity follows the token). A row
// the caller can merely read (a team role's standing session is team
// visible) is not the caller's own session and grants nothing.
async function callerSession(ctx: any, userId: Id<"users">, ref?: string): Promise<any | null> {
  if (!ref) return null;
  return await findConversationByAnyRefWhere(ctx, ref, async (c: any) => String(c.user_id) === String(userId));
}

// The state line of a brief: its first line, then the labelled lines the
// thread state renders as labels (Status:, Next:, Blocked:).
export function briefStateText(content: string): string {
  const lines = content.split("\n").map((l) => l.trim());
  const first = lines.find((l) => l.length > 0) ?? "";
  const labelled = lines.filter((l) => /^(Status|Next|Blocked):/i.test(l));
  return [first, ...labelled].join("\n");
}

// The role a calling session speaks for, with what the line needs to start:
// the trust stage, the review backend, and the session's own agent.
export async function roleForSession(ctx: Ctx, userId: Id<"users">, sessionRef: string): Promise<any | null> {
  const conv = await callerSession(ctx, userId, sessionRef);
  const roleId = conv?.standing_role_id ?? conv?.org_role_id;
  if (!conv || !roleId) return null;
  const role = await ctx.db.get(roleId);
  if (!role) return null;
  return {
    role_id: role._id,
    short_id: role.short_id,
    handle: role.handle,
    name: role.name,
    status: role.status,
    trust: trustOf(role),
    review_backend: role.review_backend ?? null,
    // the-line.md L2: `cast workflow run` with no file runs this slug.
    line_workflow_slug: lineSlugOf(role),
    own_agent: conv.agent_type,
    is_standing: String(conv.standing_role_id ?? "") === String(role._id),
    review_conflict: reviewBackendConflict(role, conv.agent_type),
    counters: countersFor(role, Date.now()),
    caps: capsFor(role),
  };
}

export const pause = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => performPauseRole(ctx, await requireCaller(ctx, api_token), args),
});
export const resume = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => performResumeRole(ctx, await requireCaller(ctx, api_token), args),
});
export const restart = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => performRestartRole(ctx, await requireCaller(ctx, api_token), args),
});
export const setTrust = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), trust: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => performSetTrust(ctx, await requireCaller(ctx, api_token), { ...args, api_token }),
});
export const setCaps = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), hands: v.optional(v.number()), wakes: v.optional(v.number()), tokens: v.optional(v.number()), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => performSetCaps(ctx, await requireCaller(ctx, api_token), { ...args, api_token }),
});
export const wake = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), message: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => performWakeRole(ctx, await requireCaller(ctx, api_token), args),
});
export const wakes = query({
  args: { api_token: v.optional(v.string()), role_id: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { api_token, ...args }) => listWakes(ctx, await requireCaller(ctx, api_token), args),
});
// Who reports to a role (org-roles-run-work.md R6). A person may add or
// remove themself; an admin of the role may name anyone in its boundary. A
// new report wakes the role at once so it asks for their goals.
export async function performSetReports(
  ctx: Ctx,
  userId: Id<"users">,
  args: { role_id: string; add?: Id<"users">[]; remove?: Id<"users">[]; set?: Id<"users">[]; from_session?: string },
): Promise<any> {
  const role = await requireRole(ctx, userId, args.role_id, "access");
  if (role.status === "retired") throw new Error("That role is retired");
  const admin = await userCanAdminRole(ctx, userId, role);
  // `set` is the whole list as a surface holds it (the Settings tab): the
  // difference against the stored row is taken here, where the row is, so
  // the same per person rule below covers it.
  const held = (role.reports_user_ids ?? []) as Id<"users">[];
  const wanted = args.set ? new Set(args.set.map(String)) : null;
  const add = wanted ? args.set!.filter((uid) => !held.some((h) => String(h) === String(uid))) : args.add ?? [];
  const remove = wanted ? held.filter((uid) => !wanted.has(String(uid))) : args.remove ?? [];
  if (add.length + remove.length === 0) return role;
  const names = new Map<string, string>();
  for (const uid of [...add, ...remove]) {
    if (String(uid) !== String(userId) && !admin) throw new Error("Only an admin of the role may change who reports to it; you may add or remove yourself");
    const u = await ctx.db.get(uid);
    if (!u || u.is_bot) throw new Error("Only a person can report to a role");
    if (role.team_id ? !(await isTeamMember(ctx as any, uid, role.team_id)) : String(uid) !== String(role.scope_user_id)) {
      throw new Error(`${u.name ?? u.email ?? "That person"} is not in this workspace`);
    }
    names.set(String(uid), u.name || u.email?.split("@")[0] || "someone");
  }
  const current = new Set<string>((role.reports_user_ids ?? []).map(String));
  for (const uid of remove) current.delete(String(uid));
  const added = add.filter((uid) => !current.has(String(uid)));
  for (const uid of added) current.add(String(uid));
  const now = Date.now();
  await ctx.db.patch(role._id, { reports_user_ids: Array.from(current) as Id<"users">[], updated_at: now });
  await ctx.db.insert("org_role_history", {
    role_id: role._id, user_id: userId, actor_type: "user", action: "reports", field: "reports_user_ids",
    old_value: JSON.stringify((role.reports_user_ids ?? []).map(String)), new_value: JSON.stringify(Array.from(current)), created_at: now,
  });
  for (const uid of added) {
    const name = names.get(String(uid))!;
    await enqueueRoleEvent(ctx, role._id, {
      kind: "immediate",
      cause: `${name} now reports to you: ask them for their three to five goals and keep them in your brief under "## Goals: ${name}"`,
      ref: { table: "users", id: String(uid) },
    });
  }
  return await ctx.db.get(role._id);
}

export const setReports = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), add: v.optional(v.array(v.id("users"))), remove: v.optional(v.array(v.id("users"))), set: v.optional(v.array(v.id("users"))), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => performSetReports(ctx, await requireCaller(ctx, api_token), args),
});

export const briefEdit = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), content: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => performBriefEdit(ctx, await requireCaller(ctx, api_token), args),
});
export const selfForSession = query({
  args: { api_token: v.optional(v.string()), session: v.string() },
  handler: async (ctx, { api_token, session }) => roleForSession(ctx, await requireCaller(ctx, api_token), session),
});
