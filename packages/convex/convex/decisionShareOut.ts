// Share out: the area rule (decisionRouting.ts) rerun over a team's open
// decisions, from the Decisions page's Team view. `preview` says who would
// get what and how many, and moves nothing; `shareOutCore` applies exactly
// the moves a preview showed, each checked again at apply time, so what a
// person confirmed is what happens. Admins only.
//
// A decision stays where it is when a person chose its owner (passed,
// escalated, or asked of named people with --to), when a role holds it, when
// it is a protected category, a trial's, a hosted assistant's or the areas
// card itself, when its session is private to its owner, or when nobody
// covers its project.
import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { decisionOwnerOf, planShareOut, type ShareOutMove, type ShareOutRow } from "@codecast/shared/contracts/decisionAreas";
import { isProtectedCategory } from "./lib/decisionCategory";
import { syncDecisionInbox } from "./lib/decisionInbox";
import { roleOfConversation } from "./lib/actor";
import { areaProjectsOf, noticeAreaOwner, readLoads, teamAreaMembers, teamReadsDecision } from "./decisionRouting";

type Ctx = { db: any; scheduler?: any };
type DecisionRow = Doc<"session_decisions">;

/** Open decisions one Share out reads, newest first. */
const OPEN_CAP = 1000;

export type ShareOutPreview = {
  moves: Array<ShareOutMove & { short_id?: string; question: string }>;
  /** Per person, how many they get, most first. */
  to: Array<{ user_id: string; name: string; count: number }>;
  /** Open decisions the rule read; those whose project nobody covers. */
  considered: number;
  unmatched: number;
};

async function requireAdmin(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">): Promise<string | null> {
  const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId)).first();
  if (!m) return "Not a member of this team";
  return m.role === "admin" ? null : "Only a team admin shares decisions out";
}

/** Whether Share out may move this decision at all (the header's list). */
async function movable(ctx: Ctx, d: DecisionRow, teamId: Id<"teams">): Promise<{ conversation: any; task: any } | null> {
  if (d.status !== "pending" || d.trial || d.silent || d.passed_to || d.escalated || d.addressed) return null;
  if (isProtectedCategory(d.category) || d.holder?.kind === "role") return null;
  const conversation = await ctx.db.get(d.conversation_id);
  if (!conversation || isHostedAgentType(conversation.agent_type)) return null;
  const task = d.task_id ? await ctx.db.get(d.task_id) : null;
  if (!teamReadsDecision(conversation, task, d.workflow_run_id, teamId)) return null;
  return { conversation, task };
}

/** The plan over a team's open decisions as they stand now. */
async function planFor(ctx: Ctx, teamId: Id<"teams">, now: number): Promise<{ moves: ShareOutMove[]; rows: Map<string, DecisionRow>; considered: number; unmatched: number }> {
  const members = await teamAreaMembers(ctx, teamId);
  const open: DecisionRow[] = await ctx.db.query("session_decisions").withIndex("by_team_status_created", (q: any) => q.eq("team_id", teamId).eq("status", "pending")).order("desc").take(OPEN_CAP);
  const rows = new Map<string, DecisionRow>();
  const input: ShareOutRow[] = [];
  if (members.length) {
    for (const d of open) {
      const ok = await movable(ctx, d, teamId);
      if (!ok) continue;
      const owner = decisionOwnerOf(d as any);
      rows.set(String(d._id), d);
      input.push({
        id: String(d._id),
        project_ids: await areaProjectsOf(ctx, { task: ok.task, role: await roleOfConversation(ctx, ok.conversation), conversation: ok.conversation }),
        owner: owner?.kind === "user" ? owner.id : null,
        created_at: d.created_at,
      });
    }
    await readLoads(ctx, members);
  }
  const { moves, unmatched } = planShareOut(input, members, now);
  return { moves, rows, considered: input.length, unmatched };
}

export async function shareOutPreviewCore(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">, now: number): Promise<ShareOutPreview | { error: string }> {
  const refused = await requireAdmin(ctx, userId, teamId);
  if (refused) return { error: refused };
  const { moves, rows, considered, unmatched } = await planFor(ctx, teamId, now);
  const counts = new Map<string, number>();
  for (const m of moves) counts.set(m.to, (counts.get(m.to) ?? 0) + 1);
  const to = [];
  for (const [user_id, count] of counts) {
    const u: Doc<"users"> | null = await ctx.db.get(user_id as Id<"users">);
    to.push({ user_id, name: u?.name || u?.email || "a teammate", count });
  }
  to.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    moves: moves.map((m) => ({ ...m, short_id: rows.get(m.decision_id)?.short_id, question: rows.get(m.decision_id)?.question ?? "" })),
    to,
    considered,
    unmatched,
  };
}

/** Who Share out would give what, for the confirm. Moves nothing. */
export const preview = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args): Promise<ShareOutPreview | { error: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in first" };
    return shareOutPreviewCore(ctx, userId, args.team_id, Date.now());
  },
});

/**
 * Applies the moves a preview showed. Each is checked again against the plan
 * as it stands now and applied only when the rule still gives that decision
 * to that person; the rest are counted as skipped. Each person is told once.
 */
export async function shareOutCore(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">, shown: Array<{ decision_id: string; to: string }>, now = Date.now()): Promise<{ moved: number; skipped: number } | { error: string }> {
  const refused = await requireAdmin(ctx, userId, teamId);
  if (refused) return { error: refused };
  const { moves, rows } = await planFor(ctx, teamId, now);
  const fresh = new Map(moves.map((m) => [m.decision_id, m.to]));
  const given = new Map<string, DecisionRow[]>();
  let moved = 0;
  for (const s of shown) {
    const row = rows.get(String(s.decision_id));
    if (!row || fresh.get(String(s.decision_id)) !== String(s.to)) continue;
    const to = s.to as Id<"users">;
    await ctx.db.patch(row._id, { holder: { kind: "user", id: String(to) }, holder_key: `user:${to}`, asked_user_ids: [to], updated_at: now });
    await syncDecisionInbox(ctx, row._id, [to], now);
    given.set(String(to), [...(given.get(String(to)) ?? []), row]);
    moved++;
  }
  for (const [to, list] of given) await noticeAreaOwner(ctx, to as Id<"users">, list[0], userId, list.length);
  return { moved, skipped: shown.length - moved };
}
