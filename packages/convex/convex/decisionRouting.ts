// Sharing decisions out by area (contracts/decisionAreas). At ask time an
// unaddressed decision's project picks the members covering it: its task's
// project, else its role scope's, else its session's. The member with the
// fewest decisions waiting in their queue owns it; a tie goes to whoever was
// given one longest ago (both read from decision_inbox, memberLoad); members who are away, who take no decisions, and bots are skipped.
// No match leaves the ask on the chain it always had (sessionDecisions
// routeFor). A decision asked of named people (--to), a protected category,
// a hosted assistant's question and a trial's keep their own rules.
//
// askCore calls routeByArea once; the owner it names becomes the decision's
// one person asked, and is told through noticeAreaOwner.
import type { Doc, Id } from "./_generated/dataModel";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { areaPool, pickAreaOwner, takesDecisions, type AreaMember } from "@codecast/shared/contracts/decisionAreas";
import { isProtectedCategory } from "./lib/decisionCategory";
import { sessionWork, taskWork } from "./lib/orgOwnership";
import { emitNotification } from "./notificationRouter";
import { teamVisibleConvTeam } from "./privacy";
import { scheduleAreasCard } from "./decisionAreas";

type Ctx = { db: any; scheduler?: any };

/** How many of one person's queued decisions the rotation counts; past this, they are simply busy. */
const OPEN_COUNT_CAP = 500;

export type AreaMemberRow = AreaMember;

/** The team's members who have areas, as the rotation reads them (their load is read later, for a pool only). */
export async function teamAreaMembers(ctx: Ctx, teamId: Id<"teams">): Promise<AreaMemberRow[]> {
  const memberships: Doc<"team_memberships">[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const out: AreaMemberRow[] = [];
  for (const m of memberships) {
    if (!m.focus_project_ids?.length) continue;
    const user: Doc<"users"> | null = await ctx.db.get(m.user_id);
    if (!user) continue;
    out.push({
      user_id: String(m.user_id),
      project_ids: m.focus_project_ids.map(String),
      takes_decisions: takesDecisions(m),
      away: user.status === "away",
      bot: !!user.is_bot,
      open: 0,
    });
  }
  return out;
}

/**
 * A person's load, read from their queue rows (decision_inbox, ~100 bytes
 * each), never from the decisions themselves: how many wait on them now, and
 * when they were last given one (their newest queue row, open or handled).
 * Nothing is written for the rotation, so routing a decision re-runs no query
 * that reads memberships.
 */
export async function memberLoad(ctx: Ctx, userId: string): Promise<{ open: number; assigned_at?: number }> {
  const pending: Array<{ created_at: number }> = await ctx.db.query("decision_inbox").withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "pending")).order("desc").take(OPEN_COUNT_CAP);
  const done: { created_at: number } | null = await ctx.db.query("decision_inbox").withIndex("by_user_status_at", (q: any) => q.eq("user_id", userId).eq("status", "done")).order("desc").first();
  const newest = Math.max(0, ...pending.map((r) => r.created_at), done?.created_at ?? 0);
  return { open: pending.length, ...(newest ? { assigned_at: newest } : {}) };
}

/** Fills each member's load in place. */
export async function readLoads(ctx: Ctx, members: AreaMemberRow[]): Promise<void> {
  for (const m of members) Object.assign(m, await memberLoad(ctx, m.user_id));
}

/** The projects a decision is about: its task's, else its role scope's, else its session's work. */
export async function areaProjectsOf(ctx: Ctx, a: { task?: any; role?: { scope?: { project_ids?: Id<"projects">[] } } | null; conversation?: any }): Promise<string[]> {
  if (a.task) {
    const work = await taskWork(ctx, a.task);
    if (work.project_id) return [String(work.project_id)];
  }
  const scope = a.role?.scope?.project_ids ?? [];
  if (scope.length) return scope.map(String);
  const work = a.conversation ? await sessionWork(ctx, a.conversation) : {};
  return work.project_id ? [String(work.project_id)] : [];
}

/**
 * Whether the team may read the decision already: its session is shared
 * with the team, or it is a run's decision about the team's problem
 * (lib/decisionAccess userMayRead). Being given a decision lets its new owner
 * read it, so a private session's question is never shared out.
 */
export function teamReadsDecision(conversation: any, task: any, workflowRunId: unknown, teamId: Id<"teams">): boolean {
  if (String(teamVisibleConvTeam(conversation) ?? "") === String(teamId)) return true;
  return !!workflowRunId && task?.workspace === `team:${teamId}`;
}

export type AreaRouteArgs = {
  conversation: any;
  task: any;
  role: any;
  category: string;
  team_id: Id<"teams"> | undefined;
  /** Asked of named people (--to). */
  addressed: boolean;
  /** A trial's decision (routeFor's trial). */
  trial: string | null;
  workflow_run_id?: unknown;
  /** A re-ask keeps its owner while they still cover its project. */
  keep?: Id<"users">;
  now: number;
};

/**
 * The person an unaddressed decision is shared out to, or null to leave it
 * on the chain it always had. A workspace with no areas set yet asks its
 * admins who decides for which areas (decisionAreas.scheduleAreasCard) instead.
 */
export async function routeByArea(ctx: Ctx, a: AreaRouteArgs): Promise<Id<"users"> | null> {
  if (!a.team_id || a.addressed || a.trial || isHostedAgentType(a.conversation.agent_type) || isProtectedCategory(a.category)) return null;
  if (!teamReadsDecision(a.conversation, a.task, a.workflow_run_id, a.team_id)) return null;
  const members = await teamAreaMembers(ctx, a.team_id);
  if (members.length === 0) {
    await scheduleAreasCard(ctx, a.team_id, a.conversation._id, a.now);
    return null;
  }
  const pool = areaPool(members, await areaProjectsOf(ctx, a));
  if (pool.length === 0) return null;
  const kept = a.keep ? pool.find((m) => m.user_id === String(a.keep)) : undefined;
  if (kept) return a.keep!;
  await readLoads(ctx, pool);
  return pickAreaOwner(pool)!.user_id as Id<"users">;
}

/** Tells the people decisions were shared out to: one notice each, never the person whose session asked. */
export async function noticeAreaOwner(
  ctx: Ctx,
  to: Id<"users">,
  d: { question: string; short_id?: string; conversation_id: Id<"conversations"> },
  actor: Id<"users"> | undefined,
  count = 1,
): Promise<void> {
  const question = d.question.length > 120 ? `${d.question.slice(0, 117)}...` : d.question;
  await emitNotification(ctx as any, {
    event_type: "decision_assigned",
    ...(actor ? { actor_user_id: actor } : {}),
    entity_type: "conversation",
    entity_id: String(d.conversation_id),
    conversation_id: d.conversation_id,
    message: count > 1 ? `shared ${count} decisions in your areas with you, first "${question}"` : `asked "${question}", in your areas`,
    link: count > 1 ? "/decisions" : d.short_id ? `/decisions/${d.short_id}` : "/decisions",
    recipient_ids: [to],
  });
}
