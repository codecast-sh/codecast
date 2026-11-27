// Who a person reports to (the org chart's people layer): any number of
// people and roles, all equal (docs/architecture/org-people.md P2, P3). The
// fact is one list on the report's team membership, `managers`, read by the
// org tree (org.ts) and through it the chart and the inbox's By reports lens.
// It is routing only: who a person reports to never changes what anyone can
// read.
import { mutation, query } from "./functions";
import { memberHandle } from "@codecast/shared/chat";
import { cleanProfilePatch, personShortLine, type PersonProfile, type ReportWaits } from "@codecast/shared/contracts/personProfile";
import { personName } from "./lib/sessionTell";
import { coverDepth, roleManagers } from "@codecast/shared/contracts/orgLead";
import { isActiveTask } from "@codecast/shared/tasks";
import { canAccessConversation, canAccessTask } from "./lib/access";
import { sessionWork, taskWork } from "./lib/orgOwnership";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { internal } from "./_generated/api";
import { requireWorkspaceFeature } from "./lib/teamFeatureGuard";
import { isPriorityCard } from "@codecast/shared/contracts/priorityCard";

type Ctx = { db: any };

/** A manager: a person or a role, the shape `org_roles.reports_to` uses. */
export type OrgParty = { kind: "user"; user_id: Id<"users"> } | { kind: "role"; role_id: Id<"org_roles"> };

// Long enough for any real chart; a corrupt one cannot spin.
const MAX_CHAIN_STEPS = 256;
export const MAX_MANAGERS = 6;

async function membershipOf(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">): Promise<any | null> {
  return await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .first();
}

export const partyKey = (p: OrgParty) => (p.kind === "user" ? `user:${p.user_id}` : `role:${p.role_id}`);

/** Everyone a member reports to, as stored: `managers`, else the one person
 *  a row from before it named. Keeps only managers still there: a person who
 *  left or a retired role reads as gone, so nothing chases deletes. */
export function managersOf(m: any, members: Set<string>, liveRoleIds: Set<string>): OrgParty[] {
  const raw: OrgParty[] = m?.managers ?? (m?.reports_to_user_id ? [{ kind: "user", user_id: m.reports_to_user_id }] : []);
  const seen = new Set<string>();
  return raw.filter((p) => {
    const k = partyKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return p.kind === "role" ? liveRoleIds.has(String(p.role_id)) : String(p.user_id) !== String(m.user_id) && members.has(String(p.user_id));
  });
}

/** Whether a role's lines, followed up through roles and people (`up`, the
 *  people's managers), reach `userId`. */
function roleLinesReach(roleId: string, userId: string, rolesById: Map<string, any>, up: Map<string, OrgParty[]>): boolean {
  const seen = new Set<string>();
  const todo: OrgParty[] = [{ kind: "role", role_id: roleId as any }];
  while (todo.length) {
    const cur = todo.pop()!;
    const k = partyKey(cur);
    if (cur.kind === "user" && String(cur.user_id) === userId) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    if (seen.size > MAX_CHAIN_STEPS) return true;
    if (cur.kind === "role") {
      const r = rolesById.get(String(cur.role_id));
      if (r && r.status !== "retired") todo.push(...roleManagers<OrgParty>(r));
    } else todo.push(...(up.get(String(cur.user_id)) ?? []));
  }
  return false;
}

/** The entries of the roles' older lists (`org_roles.reports_user_ids`,
 *  org-roles-run-work.md R6) that can become reporting lines, settled once
 *  (migrations:foldOrgManagers): taken one at a time, each accepted line
 *  joins the chart the next is tested against, so no set of them loops. One
 *  that would close a loop (a person who asked a role they manage to keep
 *  their goals) is left on the role, where it means goals only. */
export function legacyLines(memberships: any[], liveRoleIds: Set<string>, roles: any[]): Array<{ role: any; uid: string }> {
  const members = new Set(memberships.map((m) => String(m.user_id)));
  const up = managersMap(memberships, liveRoleIds);
  const rolesById = new Map(roles.map((r) => [String(r._id), r]));
  const out: Array<{ role: any; uid: string }> = [];
  for (const role of roles) {
    if (!liveRoleIds.has(String(role._id))) continue;
    for (const u of role.reports_user_ids ?? []) {
      const uid = String(u);
      const list = up.get(uid);
      if (!members.has(uid) || !list || list.some((p) => p.kind === "role" && String(p.role_id) === String(role._id))) continue;
      if (roleLinesReach(String(role._id), uid, rolesById, up)) continue;
      list.push({ kind: "role", role_id: role._id });
      out.push({ role, uid });
    }
  }
  return out;
}

/** Every member of a team mapped to their managers (managersOf). A role's
 *  own list is not read here: it holds only the people whose goals the role
 *  keeps without them reporting to it (rolePeopleIds reads it). */
export function managersMap(memberships: any[], liveRoleIds: Set<string>, _roles?: any[]): Map<string, OrgParty[]> {
  const members = new Set(memberships.map((m) => String(m.user_id)));
  return new Map(memberships.map((m) => [String(m.user_id), managersOf(m, members, liveRoleIds)]));
}

/** The people a role keeps: everyone who reports to it (their managers name
 *  it), then everyone its own list names, whose goals it keeps without them
 *  reporting to it. */
export function rolePeopleIds(role: any, memberships: any[], roles: any[]): string[] {
  const live = new Set(roles.filter((r) => r.status !== "retired").map((r) => String(r._id)));
  const members = new Set(memberships.map((m) => String(m.user_id)));
  const out: string[] = [];
  for (const [uid, list] of managersMap(memberships, live, roles)) {
    if (list.some((p) => p.kind === "role" && String(p.role_id) === String(role._id))) out.push(uid);
  }
  if (live.has(String(role._id))) for (const u of role.reports_user_ids ?? []) if (members.has(String(u)) && !out.includes(String(u))) out.push(String(u));
  return out;
}

/** rolePeopleIds, read from the database: a team role's people from the
 *  memberships, a personal role's from its own list. */
export async function rolePeopleIdsOf(ctx: Ctx, role: any): Promise<string[]> {
  if (!role?.team_id) return (role?.reports_user_ids ?? []).map(String);
  const [memberships, roles] = await Promise.all([
    ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", role.team_id)).collect(),
    teamRolesOf(ctx, role.team_id),
  ]);
  return rolePeopleIds(role, memberships, roles);
}

async function teamRolesOf(ctx: Ctx, teamId: Id<"teams">): Promise<any[]> {
  return ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect();
}

/** The member ids mapped to the people (not roles) each reports to. */
export function personManagersMap(memberships: any[], liveRoleIds: Set<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, list] of managersMap(memberships, liveRoleIds)) {
    const people = list.filter((p) => p.kind === "user").map((p: any) => String(p.user_id));
    if (people.length) out.set(id, people);
  }
  return out;
}

async function liveRoleIdsOf(ctx: Ctx, teamId: Id<"teams">): Promise<Set<string>> {
  return new Set((await teamRolesOf(ctx, teamId)).filter((r) => r.status !== "retired").map((r) => String(r._id)));
}

/** Whether walking up from `start` reaches `needle` along any line, through
 *  people and roles alike: a role goes to every role and person it reports
 *  to, a person to every one of their managers. Every move that sets a
 *  manager, person or role, asks this of the new manager, so no loop closes. */
export async function chainReaches(ctx: Ctx, teamId: Id<"teams"> | undefined, start: OrgParty, needle: OrgParty): Promise<boolean> {
  const [memberships, roles]: any[][] = teamId
    ? await Promise.all([ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect(), teamRolesOf(ctx, teamId)])
    : [[], []];
  const up = managersMap(memberships, new Set(roles.filter((r) => r.status !== "retired").map((r) => String(r._id))), roles);
  const want = partyKey(needle);
  const seen = new Set<string>();
  const todo: OrgParty[] = [start];
  while (todo.length) {
    const cur = todo.pop()!;
    const k = partyKey(cur);
    if (k === want) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    // A chart this deep is corrupt; refuse the move rather than risk a loop.
    if (seen.size > MAX_CHAIN_STEPS) return true;
    if (cur.kind === "role") {
      const role: any = await ctx.db.get(cur.role_id);
      if (role && role.status !== "retired") todo.push(...roleManagers<OrgParty>(role));
    } else todo.push(...(up.get(String(cur.user_id)) ?? []));
  }
  return false;
}

/** Everyone a member reports to now, the legacy lists folded in. */
export async function currentManagers(ctx: Ctx, teamId: Id<"teams">, userId: Id<"users">): Promise<OrgParty[]> {
  const [all, roles] = await Promise.all([
    ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect(),
    teamRolesOf(ctx, teamId),
  ]);
  return managersMap(all, new Set(roles.filter((r: any) => r.status !== "retired").map((r: any) => String(r._id))), roles).get(String(userId)) ?? [];
}

/**
 * Write everyone `user_id` reports to, as a whole list, after the caller's
 * right to do so was checked (performSetManagers, orgRoles.performSetReports).
 * Each manager is in the team, and no added one closes a loop. The list is
 * the one home: the older pointers (`reports_to_user_id`, and the person's id
 * in any role's `reports_user_ids`) are cleared as it is written.
 */
export async function writeManagers(ctx: Ctx, teamId: Id<"teams">, userId: Id<"users">, managers: OrgParty[]): Promise<{ managers: OrgParty[]; added: OrgParty[]; removed: OrgParty[] }> {
  const subject = await membershipOf(ctx, userId, teamId);
  if (!subject) throw new Error("That person is not a member of this team");
  const seen = new Set<string>();
  const next = managers.filter((p) => !seen.has(partyKey(p)) && !!seen.add(partyKey(p)));
  if (next.length > MAX_MANAGERS) throw new Error(`A person reports to at most ${MAX_MANAGERS} managers`);
  const before = await currentManagers(ctx, teamId, userId);
  for (const p of next.filter((m) => !before.some((b) => partyKey(b) === partyKey(m)))) {
    if (p.kind === "user") {
      if (String(p.user_id) === String(userId)) throw new Error("A person cannot report to themself");
      if (!(await membershipOf(ctx, p.user_id, teamId))) throw new Error("A person can only report to a member of the same team");
      // A seat's agent account sits on the roster, but a role reports through its role.
      if ((await ctx.db.get(p.user_id))?.is_bot) throw new Error("A person reports to a person or a role, not an agent account");
    } else {
      const role: any = await ctx.db.get(p.role_id);
      if (!role || role.status === "retired" || String(role.team_id ?? "") !== String(teamId)) throw new Error("A person can only report to an active role of the same team");
    }
  }
  const current = before;
  const was = new Set(current.map(partyKey));
  const added = next.filter((p) => !was.has(partyKey(p)));
  const removed = current.filter((p) => !seen.has(partyKey(p)));
  for (const p of added) {
    if (await chainReaches(ctx, teamId, p, { kind: "user", user_id: userId })) {
      const role: any = p.kind === "role" ? await ctx.db.get(p.role_id) : null;
      throw new Error(role ? `Cycle: @${role.handle} already reports up to them` : "Cycle: that person already reports to them");
    }
  }
  const sameList = !added.length && !removed.length && JSON.stringify(subject.managers ?? []) === JSON.stringify(next);
  if (!sameList || subject.reports_to_user_id !== undefined) {
    await ctx.db.patch(subject._id, { managers: next.length ? next : undefined, reports_to_user_id: undefined });
  }
  // Reporting to a role now, the person needs no goals-only entry on it.
  for (const p of added) if (p.kind === "role") await dropLegacyEntry(ctx, p.role_id, userId);
  return { managers: next, added, removed };
}

/** Take a person off a role's older list (`reports_user_ids`). */
export async function dropLegacyEntry(ctx: Ctx, roleId: Id<"org_roles">, userId: Id<"users">): Promise<void> {
  const role: any = await ctx.db.get(roleId);
  const ids: any[] = role?.reports_user_ids ?? [];
  if (!ids.some((u) => String(u) === String(userId))) return;
  const rest = ids.filter((u) => String(u) !== String(userId));
  await ctx.db.patch(roleId, { reports_user_ids: rest.length ? rest : undefined });
}

/** Whether `callerId` answers for a manager: it is them, or it is a role
 *  with them among its managers. */
async function answersFor(ctx: Ctx, callerId: Id<"users">, p: OrgParty): Promise<boolean> {
  if (p.kind === "user") return String(p.user_id) === String(callerId);
  const role: any = await ctx.db.get(p.role_id);
  return !!role && roleManagers<OrgParty>(role).some((m) => m.kind === "user" && String(m.user_id) === String(callerId));
}

export type SetManagersArgs = { team_id: Id<"teams">; user_id: Id<"users">; managers: OrgParty[] };

/** Whether a caller who is neither an admin nor the person may make this
 *  change to the person's managers: they already manage the person (directly
 *  or through a role they manage), and every manager added or removed is one
 *  they answer for. Letting yourself go is always yours. One rule for both
 *  doors (performSetManagers, orgRoles.performSetReports). */
export async function mayEditManagersAs(ctx: Ctx, callerId: Id<"users">, current: OrgParty[], touched: OrgParty[]): Promise<boolean> {
  if (!touched.length) return true;
  const self: OrgParty = { kind: "user", user_id: callerId };
  if (touched.length === 1 && partyKey(touched[0]) === partyKey(self) && current.some((p) => partyKey(p) === partyKey(self))) return true;
  let manages = false;
  for (const p of current) if (await answersFor(ctx, callerId, p)) { manages = true; break; }
  if (!manages) return false;
  for (const p of touched) if (!(await answersFor(ctx, callerId, p))) return false;
  return true;
}

/**
 * Set everyone `user_id` reports to, as a whole list (empty: nobody). Who
 * may: a team admin or the person themself, any list; one of their managers,
 * only the managers they answer for (mayEditManagersAs).
 */
export async function performSetManagers(ctx: Ctx, callerId: Id<"users">, args: SetManagersArgs): Promise<{ user_id: Id<"users">; managers: OrgParty[]; changed: boolean }> {
  const { team_id, user_id } = args;
  const caller = await membershipOf(ctx, callerId, team_id);
  if (!caller) throw new Error("Not a member of this team");
  if (!(await membershipOf(ctx, user_id, team_id))) throw new Error("That person is not a member of this team");
  if (caller.role !== "admin" && String(callerId) !== String(user_id)) {
    const current = await currentManagers(ctx, team_id, user_id);
    const keys = new Set(args.managers.map(partyKey));
    const was = new Set(current.map(partyKey));
    const touched = [...args.managers.filter((p) => !was.has(partyKey(p))), ...current.filter((p) => !keys.has(partyKey(p)))];
    if (!(await mayEditManagersAs(ctx, callerId, current, touched))) {
      throw new Error("Only a team admin, the person, or one of their managers (for a manager they answer for) can change who someone reports to");
    }
  }
  const { managers, added, removed } = await writeManagers(ctx, team_id, user_id, args.managers);
  return { user_id, managers, changed: added.length > 0 || removed.length > 0 };
}

/** The one-person shape an older client or a queued write sends meant "the
 *  person they report to": it replaces only the person managers and keeps
 *  the roles. */
export function onePersonShape(before: OrgParty[], userId: Id<"users"> | null): OrgParty[] {
  return [...before.filter((p) => p.kind === "role"), ...(userId ? [{ kind: "user" as const, user_id: userId }] : [])];
}

const partyArg = v.union(
  v.object({ kind: v.literal("user"), user_id: v.id("users") }),
  v.object({ kind: v.literal("role"), role_id: v.id("org_roles") }),
);

// The chart's drag and its menu, and `cast org reparent <person>`. A person's
// act, like every staffing change. `reports_to_user_id` is the shape queued
// before a person could have several managers: one person, or nobody.
export const reparentPerson = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.id("teams"),
    user_id: v.id("users"),
    managers: v.optional(v.array(partyArg)),
    reports_to_user_id: v.optional(v.union(v.id("users"), v.null())),
  },
  handler: async (ctx, { api_token, managers, reports_to_user_id, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    await requireWorkspaceFeature(ctx, { team_id: args.team_id, user_id: userId }, "org");
    const before = await currentManagers(ctx, args.team_id, args.user_id);
    const list: OrgParty[] = managers ?? onePersonShape(before, reports_to_user_id ?? null);
    const result = await performSetManagers(ctx, userId, { ...args, managers: list });
    // A role's morning agenda follows who reports to it (orgAgenda); its sync
    // lives above this module, so it runs as its own step.
    const role_ids = [...before, ...result.managers].flatMap((p) => (p.kind === "role" ? [p.role_id] : []));
    if (result.changed && role_ids.length) await ctx.scheduler.runAfter(0, internal.orgRoles.syncAgendas, { role_ids });
    return result;
  },
});

// ── Profiles (docs/architecture/org-people.md P4) ────────────────────────────
// What a person does here: a title, a one line focus, labels, and a longer
// `about`. On the membership, so one home per person per workspace. Written by
// the person or a team admin; an agent writes one only through its person's
// token, and the Head of People proposes rather than writes (P5).

export type SetProfileArgs = { team_id: Id<"teams">; user_id: Id<"users"> } & PersonProfile;

export async function performSetProfile(ctx: Ctx, callerId: Id<"users">, args: SetProfileArgs, now: number): Promise<{ user_id: Id<"users">; changed: boolean }> {
  const { team_id, user_id, ...profile } = args;
  const [caller, subject] = await Promise.all([membershipOf(ctx, callerId, team_id), membershipOf(ctx, user_id, team_id)]);
  if (!caller) throw new Error("Not a member of this team");
  if (!subject) throw new Error("That person is not a member of this team");
  if (caller.role !== "admin" && String(callerId) !== String(user_id)) throw new Error("Only the person or a team admin can change a person's profile");
  const cleaned = cleanProfilePatch(profile);
  if (!cleaned.ok) throw new Error(cleaned.error);
  const patch: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(cleaned.patch)) {
    const empty = val === "" || (Array.isArray(val) && val.length === 0);
    const before = subject[k];
    if (JSON.stringify(before ?? null) === JSON.stringify(empty ? null : val)) continue;
    patch[k] = empty ? undefined : val;
  }
  if (!Object.keys(patch).length) return { user_id, changed: false };
  await ctx.db.patch(subject._id, { ...patch, profile_updated: { by: callerId, at: now } });
  return { user_id, changed: true };
}

export const setProfile = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.id("teams"),
    user_id: v.id("users"),
    title: v.optional(v.string()),
    focus: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    about: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return performSetProfile(ctx, userId, args, Date.now());
  },
});

/** The short profile fields as the org payloads carry them. */
export function profileFields(m: any): { title?: string; focus?: string; labels?: string[] } {
  return {
    ...(m?.title ? { title: m.title } : {}),
    ...(m?.focus ? { focus: m.focus } : {}),
    ...(m?.labels?.length ? { labels: m.labels } : {}),
  };
}

export type PersonDetail = {
  user_id: Id<"users">;
  name: string;
  handle?: string;
  role: string;
  is_me: boolean;
  title?: string;
  focus?: string;
  labels?: string[];
  about?: string;
  areas: string[];
  takes_decisions: boolean;
  reports_to: string[];
  reports: string[];
  roles: string[];
  profile_updated: { by: string; at: number } | null;
};

/** The long version of one person (`cast org person`): the profile, the
 *  projects they decide for, who they report to, and who reports to them,
 *  people and roles. Structure only: nothing about their sessions. */
export async function computePersonDetail(ctx: Ctx, callerId: Id<"users">, teamId: Id<"teams">, userId: Id<"users">): Promise<PersonDetail | null> {
  const all: any[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const m = all.find((r) => String(r.user_id) === String(userId));
  if (!m) return null;
  const user: any = await ctx.db.get(userId);
  if (!user || user.is_bot) return null;
  const nameOf = async (id: string) => personName(await ctx.db.get(id as Id<"users">));
  const roles: any[] = await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect();
  const live = roles.filter((r) => r.status !== "retired");
  const up = managersMap(all, new Set(live.map((r) => String(r._id))), roles);
  const managers = up.get(String(userId)) ?? [];
  const reportIds = [...up.entries()].filter(([, list]) => list.some((p) => p.kind === "user" && String(p.user_id) === String(userId))).map(([from]) => from);
  const projects = await Promise.all((m.focus_project_ids ?? []).map((id: Id<"projects">) => ctx.db.get(id)));
  const updater = m.profile_updated ? await nameOf(String(m.profile_updated.by)) : "";
  return {
    user_id: userId,
    name: personName(user),
    handle: memberHandle(user) ?? undefined,
    role: m.role ?? "member",
    is_me: String(userId) === String(callerId),
    ...profileFields(m),
    ...(m.about ? { about: m.about } : {}),
    areas: projects.filter(Boolean).map((p: any) => p.title),
    takes_decisions: m.takes_decisions !== false,
    reports_to: await Promise.all(managers.map((p) => p.kind === "role"
      ? Promise.resolve(`@${live.find((r) => String(r._id) === String(p.role_id))?.handle}`)
      : nameOf(String(p.user_id)))),
    reports: await Promise.all(reportIds.map(nameOf)),
    roles: live
      .filter((r) => roleManagers<OrgParty>(r).some((p) => p.kind === "user" && String(p.user_id) === String(userId)))
      .map((r) => `@${r.handle}`),
    profile_updated: m.profile_updated ? { by: updater, at: m.profile_updated.at } : null,
  };
}

export const person = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<PersonDetail | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    if (!(await membershipOf(ctx, userId, args.team_id))) return null;
    return computePersonDetail(ctx, userId, args.team_id, args.user_id);
  },
});

// ── A role's people (docs/architecture/org-people.md P2) ─────────────────────
// The people who report to a role, and what of its area waits on each: the
// one reading the role's card, its brief, `cast org show`, `cast org where`
// and health all share. Read as `viewerId`, so it says only what that reader
// may already read: reporting grants nothing.

/** How long a decision or a review waits on a person before it counts as stuck. */
export const REPORT_WAIT_MS = 24 * 3_600_000;
const REPORT_INBOX_CAP = 200;
const REPORT_TASKS_CAP = 200;
const OPEN_TASK_STATUSES = ["backlog", "open", "in_progress", "in_review"] as const;

export type RoleReport = {
  user_id: string;
  name: string;
  /** Their short line (personShortLine), without who they report to. */
  line: string;
  waits: ReportWaits;
  /** The decisions in their queue past a day, oldest first. */
  decisions: Array<{ short_id: string | null; question: string; created_at: number }>;
  /** The open tasks assigned to them in the role's area, oldest update first. */
  tasks: Array<{ short_id: string; title: string; status: string; updated_at: number }>;
};

/** The people who report to `role` with what waits on each in its area. */
export async function roleReportsOf(
  ctx: Ctx,
  role: any,
  viewerId: Id<"users">,
  now: number,
  opts?: { memberships?: any[]; roles?: any[] },
): Promise<RoleReport[]> {
  if (!role || role.status === "retired") return [];
  const memberships: any[] = !role.team_id ? [] : opts?.memberships
    ?? await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", role.team_id)).collect();
  const ids = role.team_id
    ? rolePeopleIds(role, memberships, opts?.roles ?? await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", role.team_id)).collect())
    : await rolePeopleIdsOf(ctx, role);
  if (!ids.length) return [];
  const membershipOfId = new Map(memberships.map((m) => [String(m.user_id), m]));
  const inArea = (work: { project_id?: unknown; plan_id?: unknown }) => coverDepth(role, work) >= 0;
  const out: RoleReport[] = [];
  for (const uid of ids) {
    const user: any = await ctx.db.get(uid as Id<"users">);
    if (!user || user.is_bot) continue;
    const m = membershipOfId.get(uid);
    if (role.team_id && !m) continue;

    const decisions: RoleReport["decisions"] = [];
    const inbox: any[] = await ctx.db.query("decision_inbox").withIndex("by_user_status", (q: any) => q.eq("user_id", uid).eq("status", "pending")).take(REPORT_INBOX_CAP);
    for (const row of inbox) {
      const d: any = await ctx.db.get(row.decision_id);
      // A priority card is its person's alone (isPriorityCard): it never reaches a manager's or a role's report.
      if (!d || d.status !== "pending" || isPriorityCard(d) || now - d.created_at <= REPORT_WAIT_MS) continue;
      const conv: any = await ctx.db.get(d.conversation_id);
      if (!conv || !(await canAccessConversation(ctx as any, viewerId, conv))) continue;
      if (!inArea(await sessionWork(ctx, conv))) continue;
      decisions.push({ short_id: d.short_id ?? null, question: String(d.question ?? "").split("\n")[0].slice(0, 120), created_at: d.created_at });
    }
    decisions.sort((a, b) => a.created_at - b.created_at);

    const tasks: RoleReport["tasks"] = [];
    for (const status of OPEN_TASK_STATUSES) {
      const rows: any[] = await ctx.db.query("tasks").withIndex("by_assignee_status", (q: any) => q.eq("assignee", uid).eq("status", status)).take(REPORT_TASKS_CAP);
      for (const t of rows) {
        if (!isActiveTask(t) || !inArea(await taskWork(ctx, t))) continue;
        if (!(await canAccessTask(ctx as any, viewerId, t))) continue;
        tasks.push({ short_id: t.short_id, title: t.title, status: t.status, updated_at: t.updated_at ?? t._creationTime ?? 0 });
      }
    }
    tasks.sort((a, b) => a.updated_at - b.updated_at);

    const name = personName(user);
    out.push({
      user_id: uid,
      name,
      line: personShortLine({ name, handle: memberHandle(user) ?? undefined, role: m?.role, ...profileFields(m) }),
      waits: {
        decisions_over_day: decisions.length,
        open_tasks: tasks.length,
        review_over_day: tasks.filter((t) => t.status === "in_review" && now - t.updated_at > REPORT_WAIT_MS).length,
      },
      decisions,
      tasks,
    });
  }
  return out;
}
