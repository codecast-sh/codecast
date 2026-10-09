// The line workspace's reads and writes (docs/architecture/line-workspace.md):
// what a station received when its run started it, and the labels people put
// on the decisions steps made (LW4). Every read is one equality against a
// workspace key, or a run the viewer may read.
import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext } from "./data";
import { resolveWorkspaceKey } from "./lib/access";
import { canReadRun } from "./workflow_runs";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { pageConversationMessages } from "./conversations";
import { checkConversationAccess } from "./privacy";

/** How much of a station's brief the workspace shows; the session holds the rest. */
export const STATION_INPUT_MAX_CHARS = 40_000;
/** The labels a workspace feed carries, newest first. */
const LABELS_CAP = 2000;

/** One label's identity: one verdict per person per decision. */
export const lineLabelKey = (runId: string, nodeId: string, userId: string) => `${runId}:${nodeId}:${userId}`;

/** Whether `conversationId` is the session a run started for one of its stations. */
async function isStationOfRun(ctx: any, run: any, conversationId: string): Promise<boolean> {
  for (const n of run.node_statuses ?? []) {
    if (!n.session_id) continue;
    const conv: any = await findConversationByAnyRef(ctx, n.session_id, run.user_id);
    if (conv && String(conv._id) === conversationId) return true;
  }
  return false;
}

/**
 * What a station received: the first message its session was given (the
 * brief the runner wrote from the step's prompt and the run's inputs). A
 * viewer who can read the session reads it; so does one who can read the run
 * that started it, since a teammate's station sessions are the run's record.
 * `_id` is the conversation id, so the answer lands in the store keyed by it.
 */
export const stationInput = query({
  args: { conversation_id: v.id("conversations"), run_id: v.optional(v.id("workflow_runs")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    let allowed = (await checkConversationAccess(ctx, userId, conv as any)) !== "denied";
    if (!allowed && args.run_id) {
      const run = await ctx.db.get(args.run_id);
      allowed = !!run && (await canReadRun(ctx, userId, run)) && (await isStationOfRun(ctx, run, String(conv._id)));
    }
    if (!allowed) return null;
    const { messages } = await pageConversationMessages(ctx.db, conv._id, { order: "asc", limit: 12 });
    const first = messages.find((m: any) => m.role === "user" && !m.is_encrypted && typeof m.content === "string" && m.content.trim());
    const text: string = first?.content ?? "";
    return {
      _id: String(conv._id),
      conversation_id: String(conv._id),
      text: text.slice(0, STATION_INPUT_MAX_CHARS),
      truncated: text.length > STATION_INPUT_MAX_CHARS,
      at: first?.timestamp ?? null,
      found: !!first,
    };
  },
});

/** A label as every reader gets it. */
const shapeLabel = (row: any) => ({
  _id: String(row._id),
  key: row.key,
  workspace: row.workspace,
  ...(row.team_id ? { team_id: String(row.team_id) } : {}),
  ...(row.project_id ? { project_id: String(row.project_id) } : {}),
  run_id: String(row.run_id),
  node_id: row.node_id,
  verdict: row.verdict,
  ...(row.note ? { note: row.note } : {}),
  by: String(row.by),
  at: row.at,
});

/** A workspace's labels, newest first: the active one, or the team named. */
export const labels = query({
  args: { team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const { workspaceKey } = await createDataContext(ctx, args.team_id
      ? { userId, workspace: "team", team_id: args.team_id }
      : { userId, workspace: "personal" });
    const rows = await ctx.db
      .query("line_labels")
      .withIndex("by_workspace_at", (q) => q.eq("workspace", workspaceKey))
      .order("desc")
      .take(LABELS_CAP);
    return rows.map(shapeLabel);
  },
});

/**
 * Mark the decision a step made in a run right or wrong, with a note; a null
 * verdict takes the viewer's label back. The label lives where the run lives
 * (the run's workspace key and team), so it is explicit without the caller
 * naming a workspace: the run already does.
 */
export const label = mutation({
  args: {
    run_id: v.id("workflow_runs"),
    node_id: v.string(),
    verdict: v.union(v.literal("right"), v.literal("wrong"), v.null()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const run = await ctx.db.get(args.run_id);
    if (!run || !(await canReadRun(ctx, userId, run))) throw new Error("Not found");
    const node = args.node_id.trim();
    if (!node || !(run.node_statuses ?? []).some((n: any) => n.node_id === node)) throw new Error("No such step in this run");
    const key = lineLabelKey(String(run._id), node, String(userId));
    const had = await ctx.db.query("line_labels").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (args.verdict === null) {
      if (had) await ctx.db.delete(had._id);
      return null;
    }
    const note = args.note?.trim().slice(0, 4000) || undefined;
    const now = Date.now();
    if (had) {
      await ctx.db.patch(had._id, { verdict: args.verdict, note, at: now });
      return String(had._id);
    }
    const task: any = run.task_id ? await ctx.db.get(run.task_id) : null;
    const id = await ctx.db.insert("line_labels", {
      key,
      workspace: await resolveWorkspaceKey(ctx, run),
      ...(run.team_id ? { team_id: run.team_id as Id<"teams"> } : {}),
      ...(task?.project_id ? { project_id: task.project_id } : {}),
      run_id: run._id,
      node_id: node,
      verdict: args.verdict,
      ...(note ? { note } : {}),
      by: userId,
      at: now,
    });
    return String(id);
  },
});
