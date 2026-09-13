import { query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { createTeamFeedFilter, isTeamMember } from "./privacy";
import { classifyWorkStates } from "./conversations";
import { isOrphanOrSubagent, type WorkState } from "./inboxFilters";
import { nestParentIdOf } from "./ccAccountsShared";
import { derivePresenceState } from "./presenceState";
import { WORKING_SET_RECENCY_MS, extractRepoFromRemoteUrl } from "@codecast/shared/contracts";
import { canAccessDoc, canAccessPlan, canAccessProject, canAccessTask } from "./lib/access";
import { userCanAccessRole } from "./lib/orgAccess";
import { overlapsAmong, planProjectsOf, resolveRoleRef, rolesInBoundary, type ScopeOverlap } from "./orgRoles";
import { isWholeWorkspace, type Scope } from "./lib/orgScope";
import { capsFor, countersFor } from "./orgEvents";
import { extractPlanTitleForWeb } from "./docs";

// The org page's read side (docs/architecture/org-roles.md S3, S4): one query
// returns the workspace's reporting tree — people, roles, anchors, and every
// recent session filed under the role it reports to or else its owner — and a
// paged sibling lists everything under one node.
//
// Membership is the workspace's active, unkilled, undismissed, top-level
// conversations updated inside the working-set window. Work state comes from
// classifyWorkStates: the inbox's own classifier over the inbox's own inputs,
// never a second rule.

export const ORG_TOP_N = 8;
export const ORG_ROW_CAP = 3000;
const ORG_WINDOW_MS = WORKING_SET_RECENCY_MS;
const PAGE_DEFAULT = 50;

type Ctx = { db: any };
type StateCounts = Record<WorkState, number>;
type OrgSession = {
  _id: Id<"conversations">;
  short_id: string | null;
  title: string;
  agent_type: string;
  state: WorkState;
  updated_at: number;
  owner_user_id: Id<"users"> | null;
  org_role_id: Id<"org_roles"> | null;
  subagent_count: number;
  is_anchor: boolean;
  project_path: string | null;
  git_branch: string | null;
};
type ParentKey = string; // "user:<id>" | "role:<id>"

const STATE_ORDER: WorkState[] = ["needs_input", "working", "dormant", "done", "idle"];
function emptyCounts(): StateCounts {
  return { working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0 };
}
function orderSessions(rows: OrgSession[]): OrgSession[] {
  return rows.sort((a, b) => {
    const d = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
    return d !== 0 ? d : b.updated_at - a.updated_at;
  });
}
export const parentKeyOf = (p: { kind: "user"; user_id: any } | { kind: "role"; role_id: any }): ParentKey =>
  p.kind === "user" ? `user:${p.user_id.toString()}` : `role:${p.role_id.toString()}`;

const scanFilter = (q: any) => q.eq(q.field("status"), "active");

// The workspace's sessions, filed. Shared by `tree` and `sessionsUnder` so a
// cluster expand lists exactly what its count promised.
export async function collectOrgSessions(
  ctx: Ctx,
  userId: Id<"users">,
  teamId: Id<"teams"> | undefined,
  now: number,
): Promise<{
  memberIds: Id<"users">[];
  memberships: any[];
  roles: any[];
  anchors: any[];
  anchorSessions: Map<string, OrgSession>;
  byParent: Map<ParentKey, OrgSession[]>;
  // Every top-level session the scan produced, keyed by id, with the raw row
  // beside it: the scope feed filters these by task, plan and project path.
  sessions: Map<string, { session: OrgSession; raw: any }>;
  truncated: boolean;
}> {
  const cutoff = now - ORG_WINDOW_MS;
  let truncated = false;

  // Roles and anchors of this workspace. A member sees every team role; a
  // personal workspace holds only the caller's.
  const [roles, anchors, teamFilter] = await Promise.all([
    (teamId
      ? ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect()
      : ctx.db.query("org_roles").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId)).collect()
    ).then((rows: any[]) => rows.filter((r) => r.status !== "retired")),
    (teamId
      ? ctx.db.query("anchors").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect()
      : ctx.db.query("anchors").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId)).collect()
    ).then((rows: any[]) => rows.filter((a) => a.status !== "decommissioned")),
    teamId ? createTeamFeedFilter(ctx as any, teamId) : Promise.resolve(null),
  ]);
  const memberships: any[] = teamFilter ? teamFilter.memberships : [];
  const memberIds: Id<"users">[] = teamFilter ? memberships.map((m: any) => m.user_id) : [userId];

  // The scan: one indexed range per member (team) or the caller's own range
  // (personal), newest first, bounded by the row cap across all of them.
  const rows: any[] = [];
  let budget = ORG_ROW_CAP;
  for (const memberId of memberIds) {
    if (budget <= 0) { truncated = true; break; }
    const range = teamId
      ? ctx.db.query("conversations").withIndex("by_team_user_updated", (q: any) =>
        q.eq("team_id", teamId).eq("user_id", memberId).gte("updated_at", cutoff))
      : ctx.db.query("conversations").withIndex("by_user_updated", (q: any) =>
        q.eq("user_id", memberId).gte("updated_at", cutoff));
    const got: any[] = await range.order("desc").filter(scanFilter).take(budget + 1);
    if (got.length > budget) { truncated = true; got.length = budget; }
    budget -= got.length;
    for (const c of got) {
      if (c.inbox_killed_at || c.inbox_dismissed_at) continue;
      // A teammate's private row is theirs alone; the caller's own rows are
      // always theirs to see.
      if (teamFilter && c.user_id.toString() !== userId.toString() && !teamFilter.isVisible(c)) continue;
      rows.push(c);
    }
  }

  // Subagents are counted under the session they nest in and never emitted;
  // they also feed the producing rollup the classifier reads.
  const childrenByParent = new Map<string, any[]>();
  const topLevel: any[] = [];
  for (const c of rows) {
    if (isOrphanOrSubagent(c)) {
      const pid = nestParentIdOf(c);
      if (!pid) continue;
      const list = childrenByParent.get(pid);
      if (list) list.push(c); else childrenByParent.set(pid, [c]);
    } else {
      topLevel.push(c);
    }
  }
  const workStates = await classifyWorkStates(ctx, userId, topLevel, childrenByParent, now);

  const roleIds = new Set(roles.map((r: any) => r._id.toString()));
  const anchorByConv = new Map<string, any>(anchors.filter((a: any) => a.conversation_id).map((a: any) => [a.conversation_id.toString(), a]));
  const memberSet = new Set(memberIds.map((id) => id.toString()));
  const byParent = new Map<ParentKey, OrgSession[]>();
  const anchorSessions = new Map<string, OrgSession>();
  const sessions = new Map<string, { session: OrgSession; raw: any }>();
  for (const c of topLevel) {
    const cid = c._id.toString();
    const session: OrgSession = {
      _id: c._id,
      short_id: c.short_id ?? null,
      title: c.title ?? "",
      agent_type: c.agent_type,
      state: workStates.get(cid) ?? "idle",
      updated_at: c.updated_at,
      owner_user_id: c.owner_user_id ?? c.user_id ?? null,
      org_role_id: c.org_role_id ?? null,
      subagent_count: childrenByParent.get(cid)?.length ?? 0,
      is_anchor: !!c.anchor_id,
      project_path: c.project_path ?? null,
      git_branch: c.git_branch ?? null,
    };
    sessions.set(cid, { session, raw: c });
    // An anchor's standing session is emitted once, under the anchor, and
    // never as a person's. A standing row whose anchor is not in this
    // workspace (decommissioned, or a member's personal anchor seen from the
    // team) is nobody's session here and is dropped.
    const anchor = anchorByConv.get(cid);
    if (anchor) { anchorSessions.set(anchor._id.toString(), session); continue; }
    if (c.anchor_id || c.standing_role_id) continue;
    let key: ParentKey | null = null;
    if (c.org_role_id && roleIds.has(c.org_role_id.toString())) {
      key = parentKeyOf({ kind: "role", role_id: c.org_role_id });
    } else {
      const owner = (c.owner_user_id ?? c.user_id).toString();
      const person = memberSet.has(owner) ? owner : memberSet.has(c.user_id.toString()) ? c.user_id.toString() : null;
      if (person) key = `user:${person}`;
    }
    if (!key) continue;
    const list = byParent.get(key);
    if (list) list.push(session); else byParent.set(key, [session]);
  }
  for (const list of byParent.values()) orderSessions(list);
  return { memberIds, memberships, roles, anchors, anchorSessions, byParent, sessions, truncated };
}

function tallyOf(rows: OrgSession[]): StateCounts {
  const counts = emptyCounts();
  for (const r of rows) counts[r.state]++;
  return counts;
}

// Presence for the people row: the surface row plus the daemon heartbeat, two
// indexed reads per member. active/idle collapse to "online" — the page shows
// a dot, not a stopwatch.
async function presenceOf(ctx: Ctx, user: any, now: number): Promise<"online" | "away" | "offline"> {
  const presence = await ctx.db.query("user_presence").withIndex("by_user", (q: any) => q.eq("user_id", user._id)).first();
  const state = derivePresenceState({ presence, devices: [], machineWide: user.machine_wide_presence, daemonLastSeen: user.daemon_last_seen }, now);
  return state === "active" || state === "idle" ? "online" : state;
}

export async function computeOrgTree(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number) {
  const scan = await collectOrgSessions(ctx, userId, teamId, now);
  const team = teamId ? await ctx.db.get(teamId) : null;
  const caller = await ctx.db.get(userId);
  const roleById = new Map(scan.memberships.map((m: any) => [m.user_id.toString(), m.role ?? "member"]));

  const people = await Promise.all(scan.memberIds.map(async (uid) => {
    const user = uid.toString() === userId.toString() ? caller : await ctx.db.get(uid);
    if (!user) return null;
    const mine = scan.byParent.get(`user:${uid.toString()}`) ?? [];
    return {
      user_id: uid,
      name: user.name ?? user.email ?? "",
      image: user.image ?? undefined,
      role: roleById.get(uid.toString()) ?? "member",
      is_me: uid.toString() === userId.toString(),
      presence: await presenceOf(ctx, user, now),
      counts: tallyOf(mine),
      sessions: mine.slice(0, ORG_TOP_N),
      total: mine.length,
    };
  }));

  const roles = await Promise.all(scan.roles.map(async (role: any) => {
    const mine = scan.byParent.get(`role:${role._id.toString()}`) ?? [];
    const [projects, plans] = await Promise.all([
      Promise.all(role.scope.project_ids.map((id: any) => ctx.db.get(id))),
      Promise.all(role.scope.plan_ids.map((id: any) => ctx.db.get(id))),
    ]);
    return {
      ...role,
      counts: tallyOf(mine),
      sessions: mine.slice(0, ORG_TOP_N),
      total: mine.length,
      scope_names: {
        projects: projects.filter(Boolean).map((p: any) => ({ id: p._id, title: p.title, short_id: p.short_id ?? undefined })),
        plans: plans.filter(Boolean).map((p: any) => ({ id: p._id, title: p.title, short_id: p.short_id })),
      },
    };
  }));

  const anchors = scan.anchors.map((a: any) => {
    const session = scan.anchorSessions.get(a._id.toString());
    return {
      anchor_id: a._id,
      name: a.name,
      bot_user_id: a.bot_user_id,
      host_user_id: a.host_user_id,
      scope_type: a.scope_type,
      team_id: a.team_id ?? undefined,
      scope_user_id: a.scope_user_id ?? undefined,
      // A role's standing agent (org-roles-standing.md T1) names its role so
      // the page can nest it; absent on the workspace anchor.
      org_role_id: a.org_role_id ?? undefined,
      conversation_id: a.conversation_id ?? undefined,
      short_id: session?.short_id ?? undefined,
      state: session?.state,
      status: a.status,
    };
  });

  return {
    workspace: teamId
      ? { kind: "team" as const, id: teamId.toString(), name: team?.name ?? "" }
      : { kind: "user" as const, id: userId.toString(), name: caller?.name ?? "" },
    people: people.filter(Boolean),
    roles,
    anchors,
    truncated: scan.truncated,
    generated_at: now,
  };
}

async function requireWorkspaceCaller(ctx: any, apiToken: string | undefined, teamId: Id<"teams"> | undefined): Promise<Id<"users"> | null> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) return null;
  if (teamId && !(await isTeamMember(ctx, userId, teamId))) return null;
  return userId;
}

export const tree = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    return computeOrgTree(ctx, userId, args.team_id, Date.now());
  },
});

export const sessionsUnder = query({
  args: {
    api_token: v.optional(v.string()),
    parent: v.union(
      v.object({ kind: v.literal("user"), user_id: v.id("users") }),
      v.object({ kind: v.literal("role"), role_id: v.id("org_roles") }),
    ),
    team_id: v.optional(v.id("teams")),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return { sessions: [], next_cursor: undefined };
    const scan = await collectOrgSessions(ctx, userId, args.team_id, Date.now());
    const all = scan.byParent.get(parentKeyOf(args.parent)) ?? [];
    const offset = Math.max(0, Number(args.cursor ?? 0) || 0);
    const limit = Math.min(Math.max(1, args.limit ?? PAGE_DEFAULT), 200);
    const page = all.slice(offset, offset + limit);
    return { sessions: page, next_cursor: offset + limit < all.length ? String(offset + limit) : undefined };
  },
});

// ── Scope feed and summary (docs/architecture/scopes-and-feed.md F1, F2) ─────
//
// What a role owns, read as one stream: every source is read newest first with
// its own cursor, then merged by updated_at. Membership follows F1: a task is
// in scope by project, by plan, or by its plan's project; a session by the
// task or plan it is bound to, by project path, or by the role pointer.

export type FeedKind = "session" | "task" | "plan" | "doc" | "artifact" | "decision" | "update" | "commit";
export const FEED_KINDS: FeedKind[] = ["session", "task", "plan", "doc", "artifact", "decision", "update", "commit"];
export type FeedActor = { name: string; image?: string; is_bot?: boolean };
export type FeedRow = {
  kind: FeedKind;
  id: string;
  short_id?: string;
  title: string;
  state?: string;
  actor?: FeedActor;
  updated_at: number;
  href: string;
  preview?: string;
  image_url?: string;
};
// One position per source: the last row emitted from it. A row is "after"
// the cursor when it is older, or the same age with a smaller id.
type FeedCursor = Partial<Record<FeedKind, { ts: number; id: string }>>;

const FEED_LIMIT_DEFAULT = 40;
const FEED_LIMIT_MAX = 200;
const COMMIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ARTIFACTS_PER_MEMBER = 200;
const PREVIEW_CHARS = 200;

const preview = (text: string | undefined | null): string | undefined => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > PREVIEW_CHARS ? t.slice(0, PREVIEW_CHARS - 1) + "…" : t) : undefined;
};
const rowOrder = (a: { updated_at: number; id: string }, b: { updated_at: number; id: string }) =>
  b.updated_at - a.updated_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const afterCursor = (row: FeedRow, at?: { ts: number; id: string }) =>
  !at || row.updated_at < at.ts || (row.updated_at === at.ts && row.id < at.id);

// btoa/atob, not Buffer: the Convex runtime has no Node globals, and the
// cursor JSON (ids and timestamps) is ASCII.
export function encodeFeedCursor(c: FeedCursor): string {
  return btoa(JSON.stringify(c));
}
export function decodeFeedCursor(s: string | undefined): FeedCursor {
  if (!s) return {};
  try { return JSON.parse(atob(s)) ?? {}; } catch { return {}; }
}

const scopeArgs = {
  api_token: v.optional(v.string()),
  role_id: v.optional(v.string()),
  scope: v.optional(v.object({ project_ids: v.array(v.id("projects")), plan_ids: v.array(v.id("plans")) })),
  team_id: v.optional(v.id("teams")),
};

// The scope resolved to rows: the role (when named), its workspace, and every
// project, plan and task inside it, access checked per row.
export type ResolvedScope = {
  userId: Id<"users">;
  role: any | null;
  teamId: Id<"teams"> | undefined;
  scope: Scope;
  projects: any[];
  plans: any[];
  tasks: any[];
};

export async function resolveScope(
  ctx: Ctx,
  userId: Id<"users">,
  args: { role_id?: string; scope?: Scope; team_id?: Id<"teams"> },
): Promise<ResolvedScope | null> {
  let role: any = null;
  let scope: Scope;
  let teamId = args.team_id;
  if (args.role_id) {
    role = await resolveRoleRef(ctx, args.role_id);
    if (!role || role.status === "retired" || !(await userCanAccessRole(ctx, userId, role))) return null;
    scope = role.scope;
    teamId = role.team_id ?? undefined;
  } else if (args.scope) {
    scope = args.scope;
  } else {
    return null;
  }
  if (teamId && !(await isTeamMember(ctx as any, userId, teamId))) return null;

  const projects: any[] = [];
  for (const id of scope.project_ids) {
    const p = await ctx.db.get(id);
    if (p && (await canAccessProject(ctx as any, userId, p))) projects.push(p);
  }
  // Plans: the ones listed, plus every plan of a project in scope.
  const planById = new Map<string, any>();
  for (const id of scope.plan_ids) {
    const p = await ctx.db.get(id);
    if (p && (await canAccessPlan(ctx as any, userId, p))) planById.set(p._id.toString(), p);
  }
  for (const project of projects) {
    const rows: any[] = await ctx.db.query("plans").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
    for (const p of rows) if (!planById.has(p._id.toString()) && (await canAccessPlan(ctx as any, userId, p))) planById.set(p._id.toString(), p);
  }
  // Tasks: by project, by plan (a plan's project may be outside the listed
  // projects, so both reads run), deduped.
  const taskById = new Map<string, any>();
  const admit = async (rows: any[]) => {
    for (const t of rows) if (!taskById.has(t._id.toString()) && (await canAccessTask(ctx as any, userId, t))) taskById.set(t._id.toString(), t);
  };
  for (const project of projects) {
    await admit(await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect());
  }
  for (const plan of planById.values()) {
    await admit(await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).collect());
  }
  return { userId, role, teamId, scope, projects, plans: Array.from(planById.values()), tasks: Array.from(taskById.values()) };
}

// F1's session rule over the org scan: bound to a task or plan in scope, on a
// scope project's path, or filed under the role.
export async function sessionsInScope(ctx: Ctx, resolved: ResolvedScope, now: number): Promise<Array<{ session: OrgSession; raw: any }>> {
  if (isWholeWorkspace(resolved.scope) && !resolved.role) return [];
  const scan = await collectOrgSessions(ctx, resolved.userId, resolved.teamId, now);
  const taskIds = new Set(resolved.tasks.map((t) => t._id.toString()));
  const planIds = new Set(resolved.plans.map((p) => p._id.toString()));
  const paths = new Set(resolved.projects.map((p) => p.project_path).filter(Boolean));
  const roleId = resolved.role?._id?.toString();
  const out: Array<{ session: OrgSession; raw: any }> = [];
  for (const entry of scan.sessions.values()) {
    const c = entry.raw;
    const inScope =
      (roleId && c.org_role_id?.toString() === roleId) ||
      (c.active_task_id && taskIds.has(c.active_task_id.toString())) ||
      (c.active_plan_id && planIds.has(c.active_plan_id.toString())) ||
      (c.plan_ids ?? []).some((id: any) => planIds.has(id.toString())) ||
      (c.project_path && paths.has(c.project_path));
    if (inScope) out.push(entry);
  }
  return out;
}

// Actor lookups cached per query: a feed page names the same few people.
function actorCache(ctx: Ctx) {
  const users = new Map<string, Promise<FeedActor | undefined>>();
  return (userId: any): Promise<FeedActor | undefined> => {
    if (!userId) return Promise.resolve(undefined);
    const key = userId.toString();
    const cached = users.get(key);
    if (cached) return cached;
    const p: Promise<FeedActor | undefined> = ctx.db.get(userId).then((u: any) => u
      ? { name: u.name ?? u.email ?? "", image: u.github_avatar_url || u.image || undefined, is_bot: !!u.bot_kind || undefined }
      : undefined).catch(() => undefined);
    users.set(key, p);
    return p;
  };
}

const storageUrl = async (ctx: any, storageId: any): Promise<string | undefined> =>
  storageId && ctx.storage?.getUrl ? (await ctx.storage.getUrl(storageId)) ?? undefined : undefined;

export async function computeScopeFeed(
  ctx: Ctx,
  resolved: ResolvedScope,
  opts: { cursor?: string; limit?: number; kinds?: FeedKind[]; now: number },
): Promise<{ rows: FeedRow[]; next_cursor?: string }> {
  const { now } = opts;
  const limit = Math.min(Math.max(1, opts.limit ?? FEED_LIMIT_DEFAULT), FEED_LIMIT_MAX);
  const kinds = new Set<FeedKind>(opts.kinds?.length ? opts.kinds : FEED_KINDS);
  const cursor = decodeFeedCursor(opts.cursor);
  const actor = actorCache(ctx);
  const want = (k: FeedKind) => kinds.has(k);

  const sessions = want("session") || want("artifact") || want("commit") ? await sessionsInScope(ctx, resolved, now) : [];
  const sessionIds = new Set(sessions.map((s) => s.session._id.toString()));
  const sessionRawById = new Map(sessions.map((s) => [s.session._id.toString(), s.raw]));

  const sources = new Map<FeedKind, FeedRow[]>();

  if (want("session")) {
    sources.set("session", await Promise.all(sessions.map(async ({ session, raw }) => ({
      kind: "session" as const,
      id: session._id.toString(),
      short_id: session.short_id ?? undefined,
      title: session.title || "(untitled)",
      state: session.state,
      actor: await actor(session.owner_user_id),
      updated_at: session.updated_at,
      href: `/conversation/${session.short_id ?? session._id}`,
      preview: preview(raw.idle_summary ?? raw.subtitle),
    }))));
  }
  if (want("task")) {
    sources.set("task", await Promise.all(resolved.tasks.map(async (t) => ({
      kind: "task" as const,
      id: t._id.toString(),
      short_id: t.short_id,
      title: t.title,
      state: t.status,
      actor: await actor(t.assignee),
      updated_at: t.updated_at,
      href: `/tasks/${t.short_id ?? t._id}`,
      preview: preview(t.description),
    }))));
  }
  if (want("plan")) {
    sources.set("plan", await Promise.all(resolved.plans.map(async (p) => ({
      kind: "plan" as const,
      id: p._id.toString(),
      short_id: p.short_id,
      title: p.title,
      state: p.status,
      actor: await actor(p.user_id),
      updated_at: p.updated_at,
      href: `/plans/${p.short_id ?? p._id}`,
      preview: preview(p.goal ?? p.description),
    }))));
  }
  if (want("doc")) {
    const docById = new Map<string, any>();
    for (const project of resolved.projects) {
      for (const d of await ctx.db.query("docs").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect()) docById.set(d._id.toString(), d);
    }
    for (const plan of resolved.plans) {
      for (const d of await ctx.db.query("docs").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).collect()) docById.set(d._id.toString(), d);
    }
    const rows: FeedRow[] = [];
    for (const d of docById.values()) {
      if (d.archived_at || !(await canAccessDoc(ctx as any, resolved.userId, d))) continue;
      const shaped = extractPlanTitleForWeb(d);
      rows.push({
        kind: "doc",
        id: d._id.toString(),
        title: shaped.display_title ?? d.title,
        state: d.doc_type,
        actor: await actor(d.user_id),
        updated_at: d.updated_at,
        href: `/docs/${d._id}`,
        preview: preview((d.content ?? "").replace(/^#.*$/m, "")),
      });
    }
    sources.set("doc", rows);
  }
  if (want("artifact")) {
    // Published pages whose owning session is in scope. Artifacts index by
    // publisher, so each member's recent pages are read and filtered.
    const publishers = new Set<string>(sessions.map((s) => (s.raw.user_id ?? "").toString()).filter(Boolean));
    const rows: FeedRow[] = [];
    for (const uid of publishers) {
      const pages: any[] = await ctx.db.query("artifacts").withIndex("by_user", (q: any) => q.eq("user_id", uid)).order("desc").take(ARTIFACTS_PER_MEMBER);
      for (const a of pages) {
        if (!a.session_conversation_id || !sessionIds.has(a.session_conversation_id.toString())) continue;
        rows.push({
          kind: "artifact",
          id: a._id.toString(),
          short_id: a.slug,
          title: a.title,
          state: a.kind ?? "html",
          actor: await actor(a.user_id),
          updated_at: a.updated_at,
          href: `/a/${a.slug}`,
          preview: a.session_short_id ? `published by ${a.session_short_id} · v${a.version}` : `v${a.version}`,
        });
      }
    }
    sources.set("artifact", rows);
  }
  if (want("decision")) {
    const rows: FeedRow[] = [];
    for (const t of resolved.tasks) {
      const decisions: any[] = await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", t._id)).collect();
      for (const d of decisions) {
        const conv = sessionRawById.get(d.conversation_id.toString()) ?? (await ctx.db.get(d.conversation_id));
        rows.push({
          kind: "decision",
          id: d._id.toString(),
          short_id: d.short_id,
          title: d.question,
          state: d.status,
          actor: await actor(conv?.owner_user_id ?? d.user_id),
          updated_at: d.updated_at ?? d.resolved_at ?? d.created_at,
          href: `/questions?s=${d.conversation_id}`,
          preview: preview(d.status === "answered" && d.answer_index != null ? `answered: ${d.options[d.answer_index]?.label ?? d.answer_text ?? ""}` : d.context_md),
        });
      }
    }
    sources.set("decision", rows);
  }
  if (want("update")) {
    const rows: FeedRow[] = [];
    for (const project of resolved.projects) {
      const updates: any[] = await ctx.db.query("project_updates")
        .withIndex("by_project_created", (q: any) => q.eq("project_id", project._id))
        .order("desc")
        .take(limit + 1);
      for (const u of updates) {
        rows.push({
          kind: "update",
          id: u._id.toString(),
          short_id: u.short_id,
          title: u.title || `${u.kind === "digest" ? "Digest" : "Update"} on ${project.title}`,
          state: u.kind,
          actor: (await actor(u.author_user_id)) ?? { name: u.author, is_bot: u.author_kind === "agent" || undefined },
          updated_at: u.updated_at ?? u.created_at,
          href: `/projects/${project._id}?tab=updates`,
          preview: preview(u.body),
        });
      }
    }
    sources.set("update", rows);
  }
  if (want("commit")) {
    // Repos in scope: the remotes of the sessions in scope, last 7 days.
    const repos = new Set<string>();
    for (const { raw } of sessions) {
      const repo = extractRepoFromRemoteUrl(raw.git_remote_url);
      if (repo) repos.add(repo);
    }
    const rows: FeedRow[] = [];
    const since = now - COMMIT_WINDOW_MS;
    for (const repo of repos) {
      const commits: any[] = await ctx.db.query("commits")
        .withIndex("by_repository_timestamp", (q: any) => q.eq("repository", repo).gte("timestamp", since))
        .order("desc")
        .take(limit + 1);
      for (const cm of commits) {
        const [subject, ...body] = (cm.message ?? "").split("\n");
        rows.push({
          kind: "commit",
          id: cm._id.toString(),
          short_id: cm.sha.slice(0, 7),
          title: subject || cm.sha.slice(0, 7),
          state: cm.branch,
          actor: { name: cm.author_login ?? cm.author_name, image: cm.author_avatar_url ?? undefined },
          updated_at: cm.timestamp,
          href: `/commit/${repo}/${cm.sha}`,
          preview: preview(body.join(" ")) ?? `${cm.files_changed} files, +${cm.insertions} −${cm.deletions}`,
        });
      }
    }
    sources.set("commit", rows);
  }

  // Merge: each source newest first past its own cursor, then the newest
  // `limit` across all of them. The next cursor records, per source, the last
  // row that page emitted; untouched sources keep their old position.
  const remaining = new Map<FeedKind, FeedRow[]>();
  for (const [kind, rows] of sources) remaining.set(kind, rows.filter((r) => afterCursor(r, cursor[kind])).sort(rowOrder));
  const merged = Array.from(remaining.values()).flat().sort(rowOrder);
  const page = merged.slice(0, limit);
  const next: FeedCursor = { ...cursor };
  for (const row of page) next[row.kind] = { ts: row.updated_at, id: row.id };
  const hasMore = merged.length > page.length;

  // Thumbnails only for the rows that ship: an image artifact or a page
  // thumbnail, and the newest image a session showed.
  for (const row of page) {
    if (row.kind === "artifact") {
      const a = await ctx.db.get(row.id as any);
      row.image_url = a?.kind === "image" ? await storageUrl(ctx, a.storage_id) : await storageUrl(ctx, a?.thumb_storage_id);
    } else if (row.kind === "session") {
      const img = await ctx.db.query("conversation_images")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", row.id))
        .order("desc")
        .first();
      if (img) row.image_url = (await storageUrl(ctx, img.storage_id)) ?? img.src ?? undefined;
    }
    if (row.image_url === undefined) delete row.image_url;
  }
  return { rows: page, next_cursor: hasMore ? encodeFeedCursor(next) : undefined };
}

export const scopeFeed = query({
  args: {
    ...scopeArgs,
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    kinds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { rows: [], next_cursor: undefined };
    const resolved = await resolveScope(ctx, userId, args);
    if (!resolved) return { rows: [], next_cursor: undefined };
    const kinds = (args.kinds ?? []).filter((k): k is FeedKind => (FEED_KINDS as string[]).includes(k));
    return computeScopeFeed(ctx, resolved, { cursor: args.cursor, limit: args.limit, kinds, now: Date.now() });
  },
});

// The board line's numbers: tasks by status and priority, plans with live
// progress, sessions by work state, decisions open and answered, and sibling
// overlaps when a role is named. The web scope page and the role's brief read
// this one shape.
export type ScopeSummary = {
  scope: { project_ids: string[]; plan_ids: string[] };
  projects: Array<{ id: string; title: string; short_id?: string; project_path?: string }>;
  plans: Array<{ id: string; short_id: string; title: string; status: string; updated_at: number; progress: { total: number; done: number; in_progress: number; open: number } }>;
  tasks: { total: number; open: number; by_status: Record<string, number>; by_priority: Record<string, number> };
  sessions: StateCounts & { total: number };
  decisions: { open: number; answered: number };
  overlaps: ScopeOverlap[];
  generated_at: number;
};

export async function computeScopeSummary(ctx: Ctx, resolved: ResolvedScope, now: number): Promise<ScopeSummary> {
  const by_status: Record<string, number> = { backlog: 0, open: 0, in_progress: 0, in_review: 0, done: 0, dropped: 0 };
  const by_priority: Record<string, number> = { urgent: 0, high: 0, medium: 0, low: 0, none: 0 };
  let open = 0;
  for (const t of resolved.tasks) {
    by_status[t.status] = (by_status[t.status] ?? 0) + 1;
    by_priority[t.priority ?? "none"] = (by_priority[t.priority ?? "none"] ?? 0) + 1;
    if (t.status !== "done" && t.status !== "dropped") open++;
  }
  // Plan progress from the live task set, the plan's own rule: top-level,
  // undropped tasks only (plans.recalcProgress).
  const plans = resolved.plans.map((p) => {
    const progress = { total: 0, done: 0, in_progress: 0, open: 0 };
    for (const t of resolved.tasks) {
      if (t.plan_id?.toString() !== p._id.toString() || t.parent_id || t.status === "dropped") continue;
      progress.total++;
      if (t.status === "done") progress.done++;
      else if (t.status === "in_progress" || t.status === "in_review") progress.in_progress++;
      else progress.open++;
    }
    return { id: p._id.toString(), short_id: p.short_id, title: p.title, status: p.status, updated_at: p.updated_at, progress };
  }).sort((a, b) => b.updated_at - a.updated_at);

  const sessions = await sessionsInScope(ctx, resolved, now);
  const counts = tallyOf(sessions.map((s) => s.session));

  const decisions = { open: 0, answered: 0 };
  for (const t of resolved.tasks) {
    for (const d of await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", t._id)).collect()) {
      if (d.status === "pending") decisions.open++;
      else if (d.status === "answered") decisions.answered++;
    }
  }

  let overlaps: ScopeOverlap[] = [];
  if (resolved.role) {
    const siblings = await rolesInBoundary(ctx, resolved.role);
    overlaps = overlapsAmong(resolved.role, siblings, await planProjectsOf(ctx, siblings.map((r) => r.scope)));
  }

  return {
    scope: { project_ids: resolved.scope.project_ids.map(String), plan_ids: resolved.scope.plan_ids.map(String) },
    projects: resolved.projects.map((p) => ({ id: p._id.toString(), title: p.title, short_id: p.short_id ?? undefined, project_path: p.project_path ?? undefined })),
    plans,
    tasks: { total: resolved.tasks.length, open, by_status, by_priority },
    sessions: { ...counts, total: sessions.length },
    decisions,
    overlaps,
    generated_at: now,
  };
}

export const scopeSummary = query({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const resolved = await resolveScope(ctx, userId, args);
    if (!resolved) return null;
    return computeScopeSummary(ctx, resolved, Date.now());
  },
});

// ── The brief's facts (org-roles-standing.md T2) ─────────────────────────────
//
// Never stored: computed from the same membership as the tree plus the scope's
// tasks and plans (resolveScope / computeScopeSummary), the role's hands, the
// decisions on its ladder, and today's spend against the caps. The wake frame
// (orgWakes.buildFrame) and `cast brief` read the same shape.

export type BriefHand = {
  _id: Id<"conversations">;
  short_id: string;
  title: string;
  state: WorkState;
  state_line: string | null;
  state_status: string | null;
  state_at: number | null;
  updated_at: number;
  // The task the hand is bound to, with its last handoff status and verdict.
  task: { short_id: string; title: string; status: string; execution_status?: string; review_verdict?: string; review_note?: string } | null;
};
export type BriefChange = { kind: "task" | "plan"; short_id?: string; title: string; status: string; updated_at: number };
export type BriefFacts = {
  scope: { projects: { id: string; title: string; short_id?: string }[]; plans: { id: string; short_id: string; title: string }[]; whole_workspace: boolean };
  tasks: { total: number; open: number; by_status: Record<string, number>; by_priority: Record<string, number> };
  plans: ScopeSummary["plans"];
  hands: BriefHand[];
  changed: BriefChange[];
  decisions: { open: number; answered_today: number };
  usage: { day: string; wakes: number; hands: number; tokens: number; caps: { hands_per_day: number; wakes_per_day: number; tokens_per_day: number }; uncounted_sessions: number };
  generated_at: number;
};

const BRIEF_CHANGES_MAX = 40;
const WHOLE_WORKSPACE_TASK_CAP = 2000;

// A role whose scope is the whole workspace owns every task and plan in its
// boundary; resolveScope answers nothing for that case, so read them here.
async function wholeWorkspaceItems(ctx: Ctx, role: any): Promise<{ tasks: any[]; plans: any[] }> {
  const key = role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id}`;
  const tasks: any[] = await ctx.db.query("tasks").withIndex("by_workspace", (q: any) => q.eq("workspace", key)).take(WHOLE_WORKSPACE_TASK_CAP);
  const plans: any[] = await ctx.db.query("plans").withIndex("by_workspace", (q: any) => q.eq("workspace", key)).take(500);
  return { tasks: tasks.filter((t) => t.status !== "dropped"), plans };
}

export async function computeBriefFacts(ctx: Ctx, role: any, now: number): Promise<BriefFacts> {
  const viewer: Id<"users"> = role.host_user_id;
  let resolved = await resolveScope(ctx, viewer, { role_id: String(role._id) });
  const whole = isWholeWorkspace(role.scope ?? { project_ids: [], plan_ids: [] });
  if (!resolved) {
    resolved = { userId: viewer, role, teamId: role.team_id ?? undefined, scope: role.scope, projects: [], plans: [], tasks: [] };
  }
  if (whole) {
    const items = await wholeWorkspaceItems(ctx, role);
    resolved = { ...resolved, tasks: items.tasks, plans: items.plans };
  }
  const summary = await computeScopeSummary(ctx, resolved, now);

  // Hands: every live session filed under the role, with its pinned line and
  // the task it is bound to.
  const handRows: any[] = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id)).collect();
  const live = handRows.filter((c) => c.status === "active" && !c.inbox_killed_at);
  const states = await classifyWorkStates(ctx, viewer, live, new Map(), now);
  const hands: BriefHand[] = [];
  for (const c of live) {
    const task = c.active_task_id ? await ctx.db.get(c.active_task_id) : null;
    hands.push({
      _id: c._id,
      short_id: c.short_id ?? String(c._id).slice(0, 7),
      title: c.title ?? "",
      state: states.get(c._id.toString()) ?? "idle",
      state_line: c.thread_state ? String(c.thread_state).split("\n")[0] : null,
      state_status: c.thread_state_status ?? null,
      state_at: c.thread_state_at ?? null,
      updated_at: c.updated_at,
      task: task ? {
        short_id: task.short_id,
        title: task.title,
        status: task.status,
        execution_status: task.execution_status ?? undefined,
        review_verdict: task.review_verdict?.verdict ?? undefined,
        review_note: task.review_verdict?.note ?? undefined,
      } : null,
    });
  }
  hands.sort((a, b) => b.updated_at - a.updated_at);

  const changed: BriefChange[] = [
    ...resolved.tasks.map((t): BriefChange => ({ kind: "task", short_id: t.short_id, title: t.title, status: t.status, updated_at: t.updated_at })),
    ...resolved.plans.map((p): BriefChange => ({ kind: "plan", short_id: p.short_id, title: p.title, status: p.status, updated_at: p.updated_at })),
  ].sort((a, b) => b.updated_at - a.updated_at).slice(0, BRIEF_CHANGES_MAX);

  // Decisions on the role's ladder: open now, answered today.
  const dayStart = now - (now % 86_400_000);
  const decisions = { open: 0, answered_today: 0 };
  const ladderRows: any[] = await ctx.db.query("session_decisions").withIndex("by_status_created", (q: any) => q.eq("status", "pending")).take(500);
  for (const d of ladderRows) if ((d.hops ?? []).some((h: any) => String(h.role_id) === String(role._id))) decisions.open++;
  const answered: any[] = await ctx.db.query("session_decisions").withIndex("by_status_created", (q: any) => q.eq("status", "answered").gte("created_at", dayStart)).take(500);
  for (const d of answered) if ((d.hops ?? []).some((h: any) => String(h.role_id) === String(role._id))) decisions.answered_today++;

  const counters = countersFor(role, now);
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  const standing = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  const uncounted = [standing, ...live].filter((c) => c && c.agent_type !== "claude_code").length;

  return {
    scope: { projects: summary.projects, plans: resolved.plans.map((p) => ({ id: p._id.toString(), short_id: p.short_id, title: p.title })), whole_workspace: whole },
    tasks: summary.tasks,
    plans: summary.plans,
    hands,
    changed,
    decisions,
    usage: { ...counters, caps: capsFor(role), uncounted_sessions: uncounted },
    generated_at: now,
  };
}

// org.brief — facts plus the narrative the role keeps (T2). Any member of the
// boundary may read it; the CLI resolves @handle to the role first.
export const brief = query({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const role = await resolveRoleRef(ctx, args.role_id);
    if (!role || !(await userCanAccessRole(ctx, userId, role))) return null;
    const now = Date.now();
    const facts = await computeBriefFacts(ctx, role, now);
    // `role` is untyped (resolveRoleRef), so the ids below resolve to the
    // union of every table; the rows are read as plain objects.
    const briefDoc: any = role.brief_doc_id ? await ctx.db.get(role.brief_doc_id) : null;
    const charterDoc: any = role.charter_doc_id ? await ctx.db.get(role.charter_doc_id) : null;
    const anchor: any = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
    const standing: any = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
    return {
      role: {
        _id: role._id, short_id: role.short_id, name: role.name, handle: role.handle, status: role.status,
        trust: role.trust ?? "understand", reports_to: role.reports_to, review_backend: role.review_backend ?? null,
        standing_short_id: standing?.short_id ?? null, standing_conversation_id: standing?._id ?? null,
        last_wake_at: role.last_wake_at ?? null,
      },
      facts,
      narrative: briefDoc?.content ?? "",
      brief_doc_id: role.brief_doc_id ?? null,
      charter: charterDoc?.content ?? role.charter ?? "",
      charter_doc_id: role.charter_doc_id ?? null,
    };
  },
});
