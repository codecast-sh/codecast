// The Decisions page's Team view: every decision of one workspace the viewer
// may read, whoever owns it, open ones whole and the last week's answered
// ones. A team's are the decisions routed to it (session_decisions.team_id:
// its problem's team, else the asking conversation's); the personal
// workspace's are the viewer's own sessions' routed to no team. Each row still answers to userMayRead, so a
// private session's decisions stay its owner's. Open line decisions are left
// to listOpenForLines, which the page mounts beside this, so every open row
// has one feed answering for it. Rows read the same as every other decision
// feed's (decisionRowsForViewer), stamped `team_workspace` for the web's prune.
import { query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isTeamMember } from "./privacy";
import { userMayRead } from "./lib/decisionAccess";
import { currentDecisions } from "./lib/superseded";
import { decisionRowsForViewer, inViewerQueue, withLiveSession } from "./sessionDecisions";

type Ctx = { db: any };
type DecisionRow = Doc<"session_decisions">;

/** Newest open decisions one read covers, the line feed's cap. */
const OPEN_CAP = 2000;
/** How far back the Answered tab reaches, and how many it reads. */
export const ANSWERED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ANSWERED_CAP = 500;

const isLineDecision = (d: DecisionRow) => !!d.workflow_run_id && !!d.task_id;

/** The rows the Team view lists for one workspace key, before the per-viewer stamps. A team's come off its own rows of
 *  by_team_status_created (session_decisions.team_id, lib/decisionTeam.ts); the personal workspace's off the viewer's
 *  own (by_user_status), those routed to no team. */
export async function teamDecisionsCore(ctx: Ctx, userId: Id<"users">, workspace: string, now: number): Promise<DecisionRow[]> {
  const [kind, id] = workspace.split(":");
  if (kind === "user" ? id !== String(userId) : kind !== "team" || !(await isTeamMember(ctx as any, userId, id as Id<"teams">))) return [];
  // An answer is recent by when it landed; it was asked before that, so a read by asking time reaches back twice the window.
  const since = now - ANSWERED_WINDOW_MS;
  let open: DecisionRow[];
  let answered: DecisionRow[];
  if (kind === "team") {
    const team = id as Id<"teams">;
    open = await ctx.db.query("session_decisions").withIndex("by_team_status_created", (q: any) => q.eq("team_id", team).eq("status", "pending")).order("desc").take(OPEN_CAP);
    answered = await ctx.db.query("session_decisions")
      .withIndex("by_team_status_created", (q: any) => q.eq("team_id", team).eq("status", "answered").gte("created_at", now - 2 * ANSWERED_WINDOW_MS))
      .order("desc").take(ANSWERED_CAP);
  } else {
    open = (await ctx.db.query("session_decisions").withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "pending")).take(OPEN_CAP))
      .filter((d: DecisionRow) => !d.team_id);
    answered = (await ctx.db.query("session_decisions")
      .withIndex("by_user_status_resolved", (q: any) => q.eq("user_id", userId).eq("status", "answered").gte("resolved_at", since))
      .order("desc").take(ANSWERED_CAP)).filter((d: DecisionRow) => !d.team_id);
  }
  const candidates = [
    ...open.filter((d) => !isLineDecision(d)),
    ...answered.filter((d) => (d.resolved_at ?? 0) >= since),
  ].filter((d) => !d.trial);
  const out: DecisionRow[] = [];
  for (const d of candidates) if (await userMayRead(ctx, userId, d)) out.push(d);
  return out;
}

/** `in_queue` as the viewer's queue feed (listForUser) would send the same row, so the two feeds never flip it: an open
 *  row by its inbox row, an answered one by whether the viewer was asked it. */
async function inQueueAsTheQueueSays(ctx: Ctx, row: DecisionRow, userId: Id<"users">): Promise<boolean> {
  if (row.status === "pending") return inViewerQueue(ctx, row, userId);
  return row.asked_user_ids === undefined ? String(row.user_id) === String(userId) : row.asked_user_ids.some((u) => String(u) === String(userId));
}

export const listForTeam = query({
  args: { workspace: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await teamDecisionsCore(ctx, userId, args.workspace, Date.now());
    const standing = await withLiveSession(ctx, await currentDecisions(ctx, rows));
    return decisionRowsForViewer(ctx, standing, (r) => inQueueAsTheQueueSays(ctx, r, userId), { team_workspace: args.workspace });
  },
});
