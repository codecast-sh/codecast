// A session's own flow runs (docs/architecture/flows.md FL4): the runs a
// session started for its change (`cast flow run` from the session sets the
// run's spawner to it), newest first. The session's Ship control and its run
// card read them to show where the session's change is, so a second Ship is
// never offered while one is in flight.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canReadRun, enrichRun, withAgentSessions } from "./workflow_runs";
import { flowGraphAttr } from "@codecast/shared/contracts/flowPool";
import { workspaceGrantsAccess } from "./lib/access";

/** A run of a flow a session's change goes through (its graph takes a branch: the session's edits frozen onto one), not a deploy or a line run it also started. */
async function takesSessionChange(ctx: any, run: any, cache: Map<string, boolean>): Promise<boolean> {
  if (!run.workflow_id) return false;
  const key = String(run.workflow_id);
  if (!cache.has(key)) {
    const wf = await ctx.db.get(run.workflow_id);
    const takes = flowGraphAttr(wf?.source, "takes") ?? "";
    cache.set(key, flowGraphAttr(wf?.source, "kind") === "line" && /\bbranch\b/.test(takes));
  }
  return cache.get(key)!;
}

const LIVE = ["pending", "running", "paused"] as const;

export const forConversation = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    // Every live run, then the newest few that ended: a session rarely holds more than one of each.
    const live = (await Promise.all(LIVE.map((status) => ctx.db
      .query("workflow_runs")
      .withIndex("by_spawner_status", (q) => q.eq("spawner_conversation_id", args.conversation_id).eq("status", status))
      .take(5)))).flat();
    const ended = (await Promise.all((["completed", "failed"] as const).map((status) => ctx.db
      .query("workflow_runs")
      .withIndex("by_spawner_status", (q) => q.eq("spawner_conversation_id", args.conversation_id).eq("status", status))
      .order("desc")
      .take(3)))).flat();
    const runs = [...live, ...ended].filter((r) => r.run_kind !== "workflow");
    const readable = [];
    const kinds = new Map<string, boolean>();
    for (const r of runs) if ((await takesSessionChange(ctx, r, kinds)) && (await canReadRun(ctx, userId, r))) readable.push(r);
    const budget = { reads: 120 };
    const out = await Promise.all(readable.map(async (r) => enrichRun(ctx, await withAgentSessions(ctx, r, budget))));
    return out.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  },
});

const RECENT_RUNS = 120;

/**
 * A team's sessions' newest change runs, one per session (the newest it started): what an inbox card reads to say
 * where the session's change is. Runs of other flows a session started (a deploy, a line run) are left out.
 */
export const forTeam = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const workspace = `team:${args.team_id}`;
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return [];
    const runs = await ctx.db.query("workflow_runs").withIndex("by_workspace_updated", (q) => q.eq("workspace", workspace)).order("desc").take(RECENT_RUNS);
    const kinds = new Map<string, boolean>();
    const seen = new Set<string>();
    const picked: any[] = [];
    for (const r of runs) {
      if (!r.spawner_conversation_id || r.run_kind === "workflow" || seen.has(String(r.spawner_conversation_id))) continue;
      if (!(await takesSessionChange(ctx, r, kinds))) continue;
      seen.add(String(r.spawner_conversation_id));
      if (await canReadRun(ctx, userId, r)) picked.push(r);
    }
    // The same rows every run feed writes (one home: workflowRuns), so an inbox card and a run card read one run.
    const budget = { reads: 150 };
    const out = await Promise.all(picked.map(async (r) => enrichRun(ctx, await withAgentSessions(ctx, r, budget))));
    return out;
  },
});
