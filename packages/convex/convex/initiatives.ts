import { v, type Validator } from "convex/values";
import {
  INITIATIVE_STATUSES,
  INITIATIVE_UPDATE_HEALTHS,
  type InitiativeStatus,
  type InitiativeUpdateHealth,
} from "@codecast/shared/contracts/initiative";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { createDataContext, scopedFetch } from "./data";
import { nextShortId } from "./counters";
import { resolveActor } from "./lib/actor";
import { PRIORITIES, resolveOwnerRole } from "./lib/orgCharter";
import { performCoverProjects, type CoverProjectsResult } from "./orgRoles";
import { matchHandle, teamRoster } from "./lib/mentionResolve";
import {
  canAccessTask,
  requireAccessibleProject,
  requireSameWorkspace,
  resolveSessionConversation,
  workspaceForResource,
  workspaceGrantsAccess,
} from "./lib/access";
import { findInitiative, requireInitiative } from "./lib/initiativeRef";

// Initiatives (docs/architecture/initiatives-projects-role-page.md I1): a goal
// the company is trying to reach, carried by an intentional set of projects,
// with one owner who drives it.
//
// Access: the workspace stamp, the same one projects evaluate
// (lib/access.canAccessInitiative). An update has no rule of its own; every
// read and write of one resolves its parent initiative first.
//
// Sync: both tables stay off the change feed. A workspace holds tens of
// initiatives, so the web reads the whole visible set through one live query
// (`webList`) and one initiative's updates through another (`webUpdates`).
//
// One mutation serves the browser and the CLI: each takes an optional
// `api_token`, and the web's dispatch side effects call the same functions
// with the browser's identity. The row is raw (shared/contracts/initiative);
// the web derives progress, leads and sub initiatives at render. Only the CLI
// reads (`list`, `get`) join names and counts, because a terminal has no store.

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;
const MAX_BODY = 20_000;
const MAX_PROJECTS = 100;
const MAX_UPDATES_READ = 200;

// Typed (not `as any`): the create/update validators spread this into their
// args, so an untyped union widens `fields.status` to unknown and the
// fieldsPatch calls no longer typecheck.
const statusArg = v.union(...INITIATIVE_STATUSES.map((s) => v.literal(s))) as Validator<InitiativeStatus>;
const healthArg = v.union(...INITIATIVE_UPDATE_HEALTHS.map((h) => v.literal(h))) as any;
const priorityArg = v.union(...PRIORITIES.map((p) => v.literal(p))) as any;

// An owner arrives as a row value from the web, or as a reference from the
// CLI: "me", "@handle" (a role first, then a person), "or-N" or a role id.
const ownerArg = v.union(
  v.string(),
  v.object({ kind: v.literal("user"), user_id: v.string() }),
  v.object({ kind: v.literal("role"), role_id: v.string() }),
);

const workspaceArgs = {
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  team_id: v.optional(v.id("teams")),
};

type Ctx = { db: any };
type Owner = { kind: "user"; user_id: Id<"users"> } | { kind: "role"; role_id: Id<"org_roles"> };

async function requireCaller(ctx: Ctx, apiToken?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

// A project joins an initiative only inside the initiative's own workspace, so
// a reader of the initiative can always read what it names.
async function requireProjects(ctx: Ctx, userId: Id<"users">, initiative: any, refs: readonly string[]): Promise<Id<"projects">[]> {
  const ids: Id<"projects">[] = [];
  for (const ref of refs) {
    const id = ctx.db.normalizeId("projects", ref);
    if (!id) throw new Error(`No project ${ref}`);
    if (ids.some((x) => String(x) === String(id))) continue;
    requireSameWorkspace(await requireAccessibleProject(ctx, userId, id), workspaceForResource(initiative), "project");
    ids.push(id);
  }
  if (ids.length > MAX_PROJECTS) throw new Error(`An initiative holds at most ${MAX_PROJECTS} projects`);
  return ids;
}

async function resolveOwner(ctx: Ctx, callerId: Id<"users">, initiative: any, owner: string | { kind: "user"; user_id: string } | { kind: "role"; role_id: string }): Promise<Owner> {
  if (typeof owner !== "string" && owner.kind === "role") {
    return { kind: "role", role_id: (await resolveOwnerRole(ctx, initiative, owner.role_id))._id };
  }
  let userId: Id<"users"> | null = null;
  if (typeof owner !== "string") userId = ctx.db.normalizeId("users", owner.user_id);
  else if (owner.trim().toLowerCase() === "me") userId = callerId;
  else {
    // A role first: a handle names a seat before it names a person. The
    // resolver throws when nothing matches, and a person is the second reading.
    const role = await resolveOwnerRole(ctx, initiative, owner).catch((e: Error) => {
      if (/is in another workspace/.test(e.message)) throw e;
      return null;
    });
    if (role) return { kind: "role", role_id: role._id };
    const person = initiative.team_id ? matchHandle(await teamRoster(ctx as any, initiative.team_id), owner) : null;
    if (!person) throw new Error(`No role or person ${owner} in this workspace`);
    userId = person._id;
  }
  // A person owns an initiative only where they can read it.
  if (!userId || !(await workspaceGrantsAccess(ctx, userId, initiative.workspace))) {
    throw new Error("That person is not in this workspace");
  }
  return { kind: "user", user_id: userId };
}

// One level of nesting: a parent is never a child, a child is never a parent.
async function requireParent(ctx: Ctx, userId: Id<"users">, initiative: any, ref: string): Promise<Id<"initiatives">> {
  const parent = await requireInitiative(ctx, userId, ref);
  if (initiative._id && String(parent._id) === String(initiative._id)) throw new Error("An initiative cannot sit under itself");
  requireSameWorkspace(parent, workspaceForResource(initiative), "parent initiative");
  if (parent.parent_initiative_id) throw new Error(`${parent.short_id} already sits under another initiative; nesting is one level`);
  if (initiative._id) {
    const child = await ctx.db.query("initiatives").withIndex("by_parent", (q: any) => q.eq("parent_initiative_id", initiative._id)).first();
    if (child) throw new Error(`${initiative.short_id} has sub initiatives (${child.short_id}); nesting is one level`);
  }
  return parent._id;
}

const clean = (text: string, max: number) => text.trim().slice(0, max);

// An owner role has every project of its initiative in its scope (I1 "The
// org"). The scope write is orgRoles' one path for a scope gain; this only
// decides WHEN: after any write that names a role owner or grows the project
// list under one. The answer travels back so the caller can tell the person
// what was added and which sessions the role took over. A role retired since
// it was named owns nothing new, so it is skipped and never an error.
async function coverOwnerScope(ctx: Ctx, userId: Id<"users">, initiativeId: Id<"initiatives">): Promise<CoverProjectsResult | null> {
  const initiative = await ctx.db.get(initiativeId);
  if (initiative?.owner?.kind !== "role" || !initiative.project_ids.length) return null;
  const role = await ctx.db.get(initiative.owner.role_id);
  if (!role || role.status === "retired") return null;
  return performCoverProjects(ctx as any, userId, role._id, initiative.project_ids);
}

/** What every write answers: the row as it now stands, and what happened to the owner role's scope. */
async function written(ctx: Ctx, userId: Id<"users">, id: Id<"initiatives">, cover: boolean, extra: Record<string, any> = {}) {
  const scope = cover ? await coverOwnerScope(ctx, userId, id) : null;
  const row = await ctx.db.get(id);
  return { id, short_id: row.short_id, row, scope, ...extra };
}

type Fields = {
  title?: string;
  description?: string | null;
  status?: InitiativeStatus;
  owner?: string | { kind: "user"; user_id: string } | { kind: "role"; role_id: string } | null;
  target_date?: number | null;
  priority?: (typeof PRIORITIES)[number] | null;
  labels?: string[];
  project_ids?: string[];
  parent_initiative_id?: string | null;
};

// The patch a create or an edit becomes, validated against the row's own
// workspace. Undefined is untouched; null, an empty string or an empty list
// clears. `row` is the stored initiative, or the fields a new one will carry.
async function fieldsPatch(ctx: Ctx, userId: Id<"users">, row: any, fields: Fields): Promise<Record<string, any>> {
  const patch: Record<string, any> = {};
  if (fields.title !== undefined) {
    patch.title = clean(fields.title, MAX_TITLE);
    if (!patch.title) throw new Error("An initiative needs a title");
  }
  if (fields.description !== undefined) patch.description = (fields.description && clean(fields.description, MAX_DESCRIPTION)) || undefined;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.target_date !== undefined) patch.target_date = fields.target_date ?? undefined;
  if (fields.priority !== undefined) patch.priority = fields.priority ?? undefined;
  if (fields.labels !== undefined) {
    const labels = [...new Set(fields.labels.map((l) => l.trim()).filter(Boolean))];
    patch.labels = labels.length ? labels : undefined;
  }
  if (fields.project_ids !== undefined) patch.project_ids = await requireProjects(ctx, userId, row, fields.project_ids);
  if (fields.owner !== undefined) {
    patch.owner = fields.owner === null || fields.owner === "" ? undefined : await resolveOwner(ctx, userId, row, fields.owner);
  }
  if (fields.parent_initiative_id !== undefined) {
    patch.parent_initiative_id = fields.parent_initiative_id ? await requireParent(ctx, userId, row, fields.parent_initiative_id) : undefined;
  }
  return patch;
}

const fieldArgs = {
  description: v.optional(v.union(v.string(), v.null())),
  status: v.optional(statusArg),
  owner: v.optional(v.union(ownerArg, v.null())),
  target_date: v.optional(v.union(v.number(), v.null())),
  priority: v.optional(v.union(priorityArg, v.null())),
  labels: v.optional(v.array(v.string())),
  project_ids: v.optional(v.array(v.string())),
  parent_initiative_id: v.optional(v.union(v.string(), v.null())),
};

export const create = mutation({
  args: {
    api_token: v.optional(v.string()),
    // Writes are explicit: the caller names the workspace, never the server.
    workspace: v.union(v.literal("personal"), v.literal("team")),
    team_id: v.optional(v.id("teams")),
    client_key: v.optional(v.string()),
    title: v.string(),
    ...fieldArgs,
  },
  handler: async (ctx, { api_token, workspace, team_id, client_key, ...fields }) => {
    const userId = await requireCaller(ctx, api_token);
    const db = await createDataContext(ctx, { userId, workspace, team_id });

    // A retried create (the web's outbox, a CLI rerun) answers with the row it
    // already made.
    if (client_key) {
      const mine = await db.query("initiatives").collect();
      const existing = mine.find((r: any) => r.client_key === client_key && String(r.user_id) === String(userId));
      if (existing) return { id: existing._id, short_id: existing.short_id, row: existing };
    }

    // The row a new initiative will be, enough for the workspace checks.
    const draft = {
      user_id: userId,
      team_id: db.workspace.type === "team" ? db.workspace.teamId : undefined,
      workspace: db.workspaceKey,
    };
    const patch = await fieldsPatch(ctx, userId, draft, fields);
    const short_id = await nextShortId(ctx.db, "in");
    const id = await db.insert("initiatives", {
      status: "proposed",
      project_ids: [],
      ...patch,
      short_id,
      client_key,
      health: "none",
    });
    return written(ctx, userId, id, true);
  },
});

export const update = mutation({
  args: {
    api_token: v.optional(v.string()),
    id: v.string(),
    title: v.optional(v.string()),
    ...fieldArgs,
  },
  handler: async (ctx, { api_token, id, ...fields }) => {
    const userId = await requireCaller(ctx, api_token);
    const initiative = await requireInitiative(ctx, userId, id);
    const patch = await fieldsPatch(ctx, userId, initiative, fields);
    await ctx.db.patch(initiative._id, { ...patch, updated_at: Date.now() });
    return written(ctx, userId, initiative._id, "owner" in patch || "project_ids" in patch);
  },
});

// Add, remove and reorder are the project list's three gestures. Each is its
// own mutation so two people editing one initiative never overwrite each
// other's list with a stale copy of it.
export const addProject = mutation({
  args: { api_token: v.optional(v.string()), id: v.string(), project_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const initiative = await requireInitiative(ctx, userId, args.id);
    const project_ids = await requireProjects(ctx, userId, initiative, [...initiative.project_ids.map(String), args.project_id]);
    const added = project_ids.length > initiative.project_ids.length;
    if (added) await ctx.db.patch(initiative._id, { project_ids, updated_at: Date.now() });
    return written(ctx, userId, initiative._id, added, { added });
  },
});

export const removeProject = mutation({
  args: { api_token: v.optional(v.string()), id: v.string(), project_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const initiative = await requireInitiative(ctx, userId, args.id);
    const project_ids = initiative.project_ids.filter((p: any) => String(p) !== args.project_id);
    const removed = project_ids.length < initiative.project_ids.length;
    if (removed) await ctx.db.patch(initiative._id, { project_ids, updated_at: Date.now() });
    return written(ctx, userId, initiative._id, false, { removed });
  },
});

// A reorder names the same projects in a new order, and nothing else.
export const setProjects = mutation({
  args: { api_token: v.optional(v.string()), id: v.string(), project_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const initiative = await requireInitiative(ctx, userId, args.id);
    const project_ids = await requireProjects(ctx, userId, initiative, args.project_ids);
    await ctx.db.patch(initiative._id, { project_ids, updated_at: Date.now() });
    return written(ctx, userId, initiative._id, true);
  },
});

// Health lives on the update; the initiative carries a copy of the latest one
// so a list reads it with no join. This is the only writer of that copy, and
// it reads the latest update back instead of trusting the one just written,
// so an update posted out of order never rewinds the initiative.
async function denormalizeHealth(ctx: Ctx, initiativeId: Id<"initiatives">): Promise<void> {
  const latest = await ctx.db
    .query("initiative_updates")
    .withIndex("by_initiative_at", (q: any) => q.eq("initiative_id", initiativeId))
    .order("desc")
    .first();
  await ctx.db.patch(initiativeId, {
    health: latest?.health ?? "none",
    health_at: latest?.at,
    latest_update_id: latest?._id,
    updated_at: Date.now(),
  });
}

export const postUpdate = mutation({
  args: {
    api_token: v.optional(v.string()),
    id: v.string(),
    body: v.string(),
    // Omitted means "as the last update said"; the first update must say it.
    health: v.optional(healthArg),
    client_key: v.optional(v.string()),
    // The calling session, so a role's standing session writes as the role.
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const initiative = await requireInitiative(ctx, userId, args.id);
    const body = clean(args.body, MAX_BODY);
    if (!body) throw new Error("An update needs a body");
    const health: InitiativeUpdateHealth | undefined = args.health ?? (initiative.health === "none" ? undefined : initiative.health);
    if (!health) throw new Error(`Say how it is going: ${INITIATIVE_UPDATE_HEALTHS.join(", ")}`);

    if (args.client_key) {
      const prior = await ctx.db
        .query("initiative_updates")
        .withIndex("by_initiative_at", (q: any) => q.eq("initiative_id", initiative._id))
        .collect();
      const existing = prior.find((u: any) => u.client_key === args.client_key);
      if (existing) return { id: existing._id, row: existing };
    }

    const conversation = args.session_id ? await resolveSessionConversation(ctx, userId, args.session_id) : null;
    const actor = await resolveActor(ctx, userId, conversation);
    const at = Date.now();
    const id = await ctx.db.insert("initiative_updates", {
      initiative_id: initiative._id,
      user_id: userId,
      team_id: initiative.team_id,
      workspace: initiative.workspace,
      client_key: args.client_key,
      body,
      health,
      by: actor.kind === "role" && actor.role
        ? { kind: "role", role_id: actor.role._id, conversation_id: conversation?._id }
        : { kind: "user", user_id: userId },
      at,
    });
    await denormalizeHealth(ctx, initiative._id);
    return { id, row: await ctx.db.get(id) };
  },
});

// ── Reads ────────────────────────────────────────────────────────────────────

async function visibleInitiatives(ctx: Ctx, userId: Id<"users">, args: { workspace?: "personal" | "team"; team_id?: Id<"teams"> }): Promise<any[]> {
  const { records } = await scopedFetch(ctx, "initiatives", {
    userId,
    ...(args.workspace ? { workspace: args.workspace, teamId: args.team_id } : { workspace: "all" }),
  });
  return records;
}

async function updatesOf(ctx: Ctx, initiativeId: Id<"initiatives">): Promise<any[]> {
  return ctx.db
    .query("initiative_updates")
    .withIndex("by_initiative_at", (q: any) => q.eq("initiative_id", initiativeId))
    .order("desc")
    .take(MAX_UPDATES_READ);
}

/** The complete visible set of a workspace, raw: the web's one feed. */
export const webList = query({
  args: workspaceArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    return userId ? visibleInitiatives(ctx, userId, args) : [];
  },
});

/** One initiative by `in-N` or id, raw: the pill's resolver when the store has no row. */
export const webGet = query({
  args: { ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    return userId ? findInitiative(ctx, userId, args.ref) : null;
  },
});

/** One initiative's updates, newest first. Null when the initiative is not the caller's to read. */
export const webUpdates = query({
  args: { initiative_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    const initiative = userId ? await findInitiative(ctx, userId, args.initiative_id) : null;
    return initiative ? updatesOf(ctx, initiative._id) : null;
  },
});

// The CLI has no store to derive from, so its two reads join what a terminal
// prints: the owner's name, each project's title, and the task counts that
// make the progress line.
async function ownerLabel(ctx: Ctx, owner: Owner | undefined): Promise<string | undefined> {
  if (!owner) return undefined;
  if (owner.kind === "role") {
    const role = await ctx.db.get(owner.role_id);
    return role ? `@${role.handle}` : undefined;
  }
  const user = await ctx.db.get(owner.user_id);
  return user?.name || user?.github_username || user?.email || undefined;
}

async function projectSummaries(ctx: Ctx, userId: Id<"users">, initiative: any) {
  const out = [];
  for (const id of initiative.project_ids) {
    const project = await ctx.db.get(id);
    if (!project) continue;
    const tasks = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", id)).collect();
    let total = 0;
    let done = 0;
    for (const task of tasks) {
      if (!(await canAccessTask(ctx, userId, task))) continue;
      total++;
      if (task.status === "done") done++;
    }
    const lead = project.owner_role_id ? await ctx.db.get(project.owner_role_id) : null;
    out.push({ _id: project._id, title: project.title, status: project.status, lead: lead ? `@${lead.handle}` : undefined, task_counts: { total, done } });
  }
  return out;
}

async function forTerminal(ctx: Ctx, userId: Id<"users">, initiative: any) {
  const projects = await projectSummaries(ctx, userId, initiative);
  return {
    ...initiative,
    owner_label: await ownerLabel(ctx, initiative.owner),
    projects,
    task_counts: projects.reduce((sum, p) => ({ total: sum.total + p.task_counts.total, done: sum.done + p.task_counts.done }), { total: 0, done: 0 }),
  };
}

export const list = query({
  args: { api_token: v.optional(v.string()), status: v.optional(statusArg), ...workspaceArgs },
  handler: async (ctx, { api_token, status, ...scope }) => {
    const userId = await requireCaller(ctx, api_token);
    const rows = (await visibleInitiatives(ctx, userId, scope)).filter((r) => !status || r.status === status);
    return Promise.all(rows.map((r) => forTerminal(ctx, userId, r)));
  },
});

export const get = query({
  args: { api_token: v.optional(v.string()), id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const initiative = await findInitiative(ctx, userId, args.id);
    if (!initiative) return null;
    const [parent, children, updates] = await Promise.all([
      initiative.parent_initiative_id ? ctx.db.get(initiative.parent_initiative_id) : null,
      ctx.db.query("initiatives").withIndex("by_parent", (q: any) => q.eq("parent_initiative_id", initiative._id)).collect(),
      updatesOf(ctx, initiative._id),
    ]);
    const brief = (r: any) => ({ _id: r._id, short_id: r.short_id, title: r.title, status: r.status, health: r.health });
    return {
      ...(await forTerminal(ctx, userId, initiative)),
      parent: parent ? brief(parent) : undefined,
      sub_initiatives: children.map(brief),
      updates: await Promise.all(updates.map(async (u: any) => ({ ...u, by_label: await ownerLabel(ctx, u.by) }))),
    };
  },
});
