import { query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { createTeamFeedFilter, isTeamMember } from "./privacy";
import { classifyWorkStates } from "./conversations";
import { isOrphanOrSubagent, type WorkState } from "./inboxFilters";
import { nestParentIdOf } from "./ccAccountsShared";
import { derivePresenceState } from "./presenceState";
import { WORKING_SET_RECENCY_MS } from "@codecast/shared/contracts";

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
  work_state: WorkState;
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
    const d = STATE_ORDER.indexOf(a.work_state) - STATE_ORDER.indexOf(b.work_state);
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
  for (const c of topLevel) {
    const cid = c._id.toString();
    const session: OrgSession = {
      _id: c._id,
      short_id: c.short_id ?? null,
      title: c.title ?? "",
      agent_type: c.agent_type,
      work_state: workStates.get(cid) ?? "idle",
      updated_at: c.updated_at,
      owner_user_id: c.owner_user_id ?? c.user_id ?? null,
      org_role_id: c.org_role_id ?? null,
      subagent_count: childrenByParent.get(cid)?.length ?? 0,
      is_anchor: !!c.anchor_id,
      project_path: c.project_path ?? null,
      git_branch: c.git_branch ?? null,
    };
    // An anchor's standing session is emitted once, under the anchor.
    const anchor = anchorByConv.get(cid);
    if (anchor) { anchorSessions.set(anchor._id.toString(), session); continue; }
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
  return { memberIds, memberships, roles, anchors, anchorSessions, byParent, truncated };
}

function tallyOf(rows: OrgSession[]): StateCounts {
  const counts = emptyCounts();
  for (const r of rows) counts[r.work_state]++;
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
      conversation_id: a.conversation_id ?? undefined,
      short_id: session?.short_id ?? undefined,
      work_state: session?.work_state,
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
