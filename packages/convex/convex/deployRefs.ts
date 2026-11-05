// Deploys by their records (deploys.md DP12): where a dp-N lives (the team,
// target and repository the Deploys page opens on), and a team's newest
// deploys with what each carried out, the sessions and tasks in it. The page
// and the inbox read the records whether or not the team declared targets, so
// a team with deploys never sees an empty page.
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { workspaceGrantsAccess } from "./lib/access";

export const whereIs = query({
  args: { ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const d = await ctx.db.query("deploys").withIndex("by_short_id", (q) => q.eq("short_id", args.ref.trim().toLowerCase())).first();
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) return null;
    return { team_id: d.workspace.startsWith("team:") ? d.workspace.slice(5) : null, target: d.target, repository: d.repository ?? null };
  },
});

const RECENT = 80;
/** The commits a deploy row lists by name; the rest are counted. */
const COMMIT_ROWS = 40;

/** A team's newest deploys, every target, each with the sessions whose commits it carried and the tasks it took out. */
export const recentForTeam = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const workspace = `team:${args.team_id}`;
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return [];
    const rows: Doc<"deploys">[] = await ctx.db.query("deploys").withIndex("by_workspace_created", (q) => q.eq("workspace", workspace)).order("desc").take(RECENT);
    const convs = new Map<string, { title: string | null } | null>();
    const tasks = new Map<string, { short_id: string | null; title: string | null } | null>();
    const convOf = async (id: Id<"conversations">) => {
      const k = String(id);
      if (!convs.has(k)) { const c = await ctx.db.get(id); convs.set(k, c ? { title: (c.title || c.subtitle || null) as string | null } : null); }
      return convs.get(k);
    };
    const taskOf = async (id: Id<"tasks">) => {
      const k = String(id);
      if (!tasks.has(k)) { const t = await ctx.db.get(id); tasks.set(k, t ? { short_id: t.short_id ?? null, title: t.title ?? null } : null); }
      return tasks.get(k);
    };
    const out = [];
    for (const d of rows) {
      const sessionIds = [...new Set((d.commits ?? []).flatMap((c) => (c.conversation_id ? [String(c.conversation_id)] : [])))];
      const sessions = [];
      for (const id of sessionIds.slice(0, 12)) {
        const c = await convOf(id as Id<"conversations">);
        if (c) sessions.push({ conversation_id: id, short_id: id.slice(0, 7), title: c.title });
      }
      const taskIds = [...new Set([...d.carries.map((c) => String(c.task_id)), ...(d.commits ?? []).flatMap((c) => (c.task_ids ?? []).map(String))])];
      const taskRows = [];
      for (const id of taskIds.slice(0, 12)) {
        const t = await taskOf(id as Id<"tasks">);
        if (t?.short_id) taskRows.push(t);
      }
      out.push({
        _id: String(d._id),
        ...(d.client_key ? { client_key: d.client_key } : {}),
        workspace,
        target: d.target,
        repository: d.repository ?? "",
        short_id: d.short_id,
        status: d.status,
        trigger: d.trigger,
        action: d.action ?? "deploy",
        rollback_of: d.rollback_of ?? null,
        sha: d.sha ?? null,
        previous_sha: d.previous_sha ?? null,
        version: d.version ?? null,
        url: d.url ?? null,
        source: d.source,
        started_by: d.started_by?.name ?? null,
        note: d.note ?? null,
        commits: d.commits?.length ?? 0,
        // What it took out, change by change: each commit with the session that wrote it and the tasks it names.
        commit_rows: await Promise.all((d.commits ?? []).slice(0, COMMIT_ROWS).map(async (c) => ({
          sha: c.sha,
          subject: c.subject,
          ...(c.author ? { author: c.author } : {}),
          ...(c.conversation_id ? { conversation_id: String(c.conversation_id) } : {}),
          tasks: (await Promise.all((c.task_ids ?? []).slice(0, 3).map(async (t) => (await taskOf(t))?.short_id ?? null))).filter(Boolean),
        }))),
        sessions,
        tasks: taskRows,
        created_at: d.created_at,
        live_at: d.live_at ?? null,
        finished_at: d.finished_at ?? null,
      });
    }
    return out;
  },
});
