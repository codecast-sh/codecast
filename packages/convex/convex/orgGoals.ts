// A person who reports to a role (docs/architecture/org-roles-run-work.md
// R6): the role keeps their three to five goals in its brief, reads their
// sessions against those goals at every wake, and tells them once a day at
// most when a high priority goal stalls.
//
// Nothing derived is stored. The goals are text in the brief (shared
// contracts/roleGoals parses them); the sessions, tasks and plans the role
// matched to a goal are short ids on its line, read live here to say what
// moved and what stalled. One computation serves the wake frame and the
// brief query (org.computeBriefFacts), the health query (a stalled goal is an
// open stall) and the hourly stall sweep below.
import { internal } from "./_generated/api";
import { internalMutation } from "./functions";
import type { Id } from "./_generated/dataModel";
import { goalSectionMatchesPerson, parseGoalSections, type GoalPriority } from "@codecast/shared/contracts/roleGoals";
import { capacity } from "@codecast/shared/contracts/orgCapacity";
import { threadStateHeadline } from "@codecast/shared/contracts";
import { canAccessConversation, canAccessPlan, canAccessTask } from "./lib/access";
import { findPlanByRef, findTaskByRef } from "./taskEvidence";
import type { WorkState } from "./inboxFilters";

type Ctx = { db: any; runMutation?: any };

const DAY_MS = 24 * 3600_000;
/** A person's changed sessions listed in a frame before the rest is a count. */
export const PERSON_SESSION_LINES = 8;
const SWEEP_ROLES_CAP = 500;

export type GoalRef = { kind: "session" | "task" | "plan"; short_id: string; title: string; status: string; updated_at: number };
export type BriefGoal = {
  text: string;
  priority: GoalPriority | null;
  /** The line as the role wrote it in the brief. */
  raw: string;
  refs: GoalRef[];
  /** Short ids on the line that named nothing the viewer can read. */
  unresolved: string[];
  /** When the newest matched row last changed; null with nothing matched. */
  moved_at: number | null;
  /** Nothing matched moved inside the stall window (capacity goal_stall_days). */
  stalled: boolean;
  /** Nothing has been matched and the brief is older than goal_unmatched_days. */
  unmatched: boolean;
};
export type BriefPersonSession = { _id: string; short_id: string; title: string; state: WorkState; state_line: string | null; updated_at: number };
export type BriefPerson = {
  user_id: string;
  name: string;
  /** The brief has a goal section for this person. */
  has_section: boolean;
  goals: BriefGoal[];
  /** The person's sessions that changed since `since`, newest first. */
  sessions_changed: BriefPersonSession[];
  sessions_total: number;
  /** High priority goals that are stalled: the ones a notice is about. */
  stalled_high: number;
};

/** The org scan's shape as far as this reads it (org.collectOrgSessions). */
export type PeopleScan = {
  byParent: Map<string, Array<{ _id: any; short_id: string | null; title: string; state: WorkState; updated_at: number }>>;
  sessions: Map<string, { raw: any }>;
} | null;

/** A goal's key in org_roles.goal_first_seen: the person and a hash of the
 *  goal's words (record keys are plain ASCII; a goal is any text). Rewording
 *  a goal makes it a new goal, which is what the person would say too. */
export function goalKey(userId: string, text: string): string {
  let h = 5381;
  for (const ch of text.trim().toLowerCase()) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return `${userId}:${h.toString(16)}`;
}

async function resolveRef(ctx: Ctx, viewerId: Id<"users">, kind: GoalRef["kind"], shortId: string): Promise<GoalRef | null> {
  if (kind === "session") {
    const conv = await ctx.db.query("conversations").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
    if (!conv || !(await canAccessConversation(ctx as any, viewerId, conv))) return null;
    return { kind, short_id: shortId, title: conv.title ?? "", status: conv.thread_state_status ?? conv.status ?? "", updated_at: conv.updated_at ?? 0 };
  }
  const row = kind === "task" ? await findTaskByRef(ctx as any, shortId) : await findPlanByRef(ctx as any, shortId);
  if (!row) return null;
  const ok = kind === "task" ? await canAccessTask(ctx as any, viewerId, row) : await canAccessPlan(ctx as any, viewerId, row);
  if (!ok) return null;
  return { kind, short_id: shortId, title: row.title ?? "", status: row.status ?? "", updated_at: row.updated_at ?? row._creationTime ?? 0 };
}

/** The people who report to `role`, each with their goals read against the
 *  live rows and their sessions that changed since `since`. `viewerId` is
 *  whose grants the rows are read with (the role's host for a frame, the
 *  caller for the brief): a private session the viewer cannot open is never
 *  matched and never listed. */
export async function computeReportingPeople(
  ctx: Ctx,
  viewerId: Id<"users">,
  role: any,
  brief: { content: string; updated_at?: number } | null,
  scan: PeopleScan,
  since: number,
  now: number,
): Promise<BriefPerson[]> {
  const ids: Id<"users">[] = role.reports_user_ids ?? [];
  if (ids.length === 0) return [];
  const sections = parseGoalSections(brief?.content ?? "");
  const stallMs = capacity("goal_stall_days") * DAY_MS;
  const unmatchedMs = capacity("goal_unmatched_days") * DAY_MS;
  // How long a goal has been in the brief: since the sweep first saw it. A
  // goal the sweep has not reached yet is new.
  const seen: Record<string, number> = role.goal_first_seen ?? {};
  const out: BriefPerson[] = [];
  for (const uid of ids) {
    const user = await ctx.db.get(uid);
    if (!user || user.is_bot) continue;
    const name = user.name || user.email?.split("@")[0] || "someone";
    const section = sections.find((s) => goalSectionMatchesPerson(s.person, user));
    const goals: BriefGoal[] = [];
    for (const g of section?.goals ?? []) {
      const refs: GoalRef[] = [];
      const unresolved: string[] = [];
      const named: Array<[GoalRef["kind"], string]> = [
        ...g.refs.sessions.map((s): [GoalRef["kind"], string] => ["session", s]),
        ...g.refs.tasks.map((s): [GoalRef["kind"], string] => ["task", s]),
        ...g.refs.plans.map((s): [GoalRef["kind"], string] => ["plan", s]),
      ];
      for (const [kind, shortId] of named) {
        const ref = await resolveRef(ctx, viewerId, kind, shortId);
        if (ref) refs.push(ref); else unresolved.push(shortId);
      }
      const moved_at = refs.length ? Math.max(...refs.map((r) => r.updated_at)) : null;
      const heldFor = now - (seen[goalKey(String(uid), g.text)] ?? now);
      goals.push({
        text: g.text, priority: g.priority, raw: g.raw, refs, unresolved, moved_at,
        stalled: moved_at !== null ? now - moved_at > stallMs : heldFor > stallMs,
        unmatched: refs.length === 0 && heldFor > unmatchedMs,
      });
    }
    const mine = scan?.byParent.get(`user:${String(uid)}`) ?? [];
    const changed = mine
      .filter((s) => s.updated_at > since)
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((s): BriefPersonSession => {
        const raw = scan?.sessions.get(String(s._id))?.raw;
        const line = raw?.thread_state ? threadStateHeadline(String(raw.thread_state)) : "";
        return { _id: String(s._id), short_id: s.short_id ?? String(s._id).slice(0, 7), title: s.title, state: s.state, state_line: line || null, updated_at: s.updated_at };
      });
    out.push({
      user_id: String(uid), name, has_section: !!section, goals,
      sessions_changed: changed, sessions_total: mine.length,
      stalled_high: goals.filter((g) => g.priority === "high" && g.stalled).length,
    });
  }
  return out;
}

/** The one line a person reads about their stalled goals, in the role's voice. */
export function stallNoticeLine(roleHandle: string, goals: BriefGoal[], now: number): string {
  const days = (g: BriefGoal) => Math.max(1, Math.floor((now - (g.moved_at ?? now)) / DAY_MS));
  const named = goals.map((g) => `"${g.text}"${g.moved_at ? ` (${days(g)}d)` : " (nothing matched yet)"}`);
  return goals.length === 1
    ? `@${roleHandle}: your high priority goal ${named[0]} has not moved. Open the role to see what is matched to it.`
    : `@${roleHandle}: ${goals.length} of your high priority goals have not moved: ${named.join(", ")}.`;
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Tell each reporting person about their stalled high goals, once per UTC
 *  day (org_roles.goal_notices). The notice is a notification from the
 *  role's bot user that opens the role's page. Returns how many went out. */
export async function noticeGoalStalls(ctx: Ctx, role: any, anchor: any | null, people: BriefPerson[], now: number): Promise<number> {
  const today = utcDay(now);
  const notices: Record<string, string> = { ...(role.goal_notices ?? {}) };
  let sent = 0;
  for (const person of people) {
    const stalled = person.goals.filter((g) => g.priority === "high" && g.stalled);
    if (stalled.length === 0 || notices[person.user_id] === today) continue;
    if (!ctx.runMutation) continue;
    const res = await ctx.runMutation(internal.notificationRouter.emit, {
      event_type: "goal_stall" as const,
      entity_type: "org_role" as const,
      entity_id: role.short_id,
      direct_recipient_id: person.user_id as Id<"users">,
      actor_user_id: anchor?.bot_user_id ?? undefined,
      actor_name: role.name,
      message: stallNoticeLine(role.handle, stalled, now),
      push_body: stallNoticeLine(role.handle, stalled, now),
    });
    notices[person.user_id] = today;
    sent += res?.notified ?? 0;
  }
  await ctx.db.patch(role._id, { goal_notices: notices });
  return sent;
}

/** Stamp when each goal in the brief was first seen, and forget goals that
 *  left it. Returns the role as it now stands. */
export async function stampGoalsSeen(ctx: Ctx, role: any, briefContent: string, now: number): Promise<any> {
  const before: Record<string, number> = role.goal_first_seen ?? {};
  const after: Record<string, number> = {};
  const sections = parseGoalSections(briefContent);
  for (const uid of role.reports_user_ids ?? []) {
    const user = await ctx.db.get(uid);
    if (!user) continue;
    for (const g of sections.find((s) => goalSectionMatchesPerson(s.person, user))?.goals ?? []) {
      const key = goalKey(String(uid), g.text);
      after[key] = before[key] ?? now;
    }
  }
  if (JSON.stringify(Object.entries(before).sort()) === JSON.stringify(Object.entries(after).sort())) return role;
  await ctx.db.patch(role._id, { goal_first_seen: after });
  return { ...role, goal_first_seen: after };
}

/** Every active role with people reporting to it, read as its host. */
export async function sweepGoalStalls(ctx: Ctx, now: number): Promise<{ roles: number; notices: number }> {
  const roles: any[] = await ctx.db.query("org_roles").filter((q: any) => q.eq(q.field("status"), "active")).take(SWEEP_ROLES_CAP);
  let checked = 0;
  let notices = 0;
  for (const row of roles) {
    if (!row.reports_user_ids?.length || !row.anchor_id) continue;
    checked++;
    const brief = row.brief_doc_id ? await ctx.db.get(row.brief_doc_id) : null;
    const role = await stampGoalsSeen(ctx, row, brief?.content ?? "", now);
    const anchor = await ctx.db.get(role.anchor_id);
    const people = await computeReportingPeople(ctx, role.host_user_id, role, brief ? { content: brief.content ?? "" } : null, null, now, now);
    notices += await noticeGoalStalls(ctx, role, anchor, people, now);
  }
  return { roles: checked, notices };
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => sweepGoalStalls(ctx as any, Date.now()),
});
