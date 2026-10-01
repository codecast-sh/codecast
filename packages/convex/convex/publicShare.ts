// "Anyone with the link" for every shared object kind but conversations
// (whose link also carries a profile pin and an owner-only rule, see
// conversations.writeShareLink): docs, plans, tasks and calls. One write rule
// and one token claim, so the kinds cannot drift apart; the public views of
// the kinds born here (tasks, calls) live beside it. The URL grammar is
// @codecast/shared/entities sharePath.
//
// The web mints the token (a v4 UUID) so its optimistic draft and the stored
// value are the same string (dispatch setObjectShareLink). Turning the link
// off clears the token, killing every copy; turning it back on takes a new
// one, so an old link never comes back to life.
import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { canAccessDoc, canAccessPlan, canAccessTask } from "./lib/access";
import { canReadCall } from "./transcripts";
import { assigneeNamesFor } from "./tasks";
import { isRecRoomKey } from "@codecast/shared/contracts";

export const SHARE_TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ShareTable = "conversations" | "docs" | "plans" | "tasks" | "transcripts";

/** Point `row`'s share token at `token` (null clears it). A token already
 *  serving another row of the table is refused, so one link can never be
 *  re-aimed at a different object. */
export async function claimShareToken(
  ctx: Pick<MutationCtx, "db">,
  table: ShareTable,
  row: { _id: Id<ShareTable>; share_token?: string | null },
  token: string | null,
): Promise<void> {
  if (token === null) {
    if (row.share_token) await ctx.db.patch(row._id, { share_token: undefined } as any);
    return;
  }
  if (row.share_token === token) return;
  if (!SHARE_TOKEN_SHAPE.test(token)) throw new Error("Invalid share token");
  const taken = await (ctx.db.query(table) as any)
    .withIndex("by_share_token", (q: any) => q.eq("share_token", token))
    .first();
  if (taken) throw new Error("Invalid share token");
  await ctx.db.patch(row._id, { share_token: token } as any);
}

// Who may turn a kind's link on or off: whoever may read the object. Docs,
// plans and tasks are team-editable, and a call's record belongs to everyone
// who sat through it. Wrapped, not referenced: this module sits in an import
// cycle with conversations.ts, and a bare binding read at load is a TDZ.
const SHARE_KINDS = {
  doc: { table: "docs", canManage: (ctx: any, u: Id<"users">, row: any) => canAccessDoc(ctx, u, row) },
  plan: { table: "plans", canManage: (ctx: any, u: Id<"users">, row: any) => canAccessPlan(ctx, u, row) },
  task: { table: "tasks", canManage: (ctx: any, u: Id<"users">, row: any) => canAccessTask(ctx, u, row) },
  call: { table: "transcripts", canManage: (ctx: any, u: Id<"users">, row: any) => canReadCall(ctx, u, row) },
} as const satisfies Record<string, { table: TableNames; canManage: (ctx: any, userId: Id<"users">, row: any) => Promise<boolean> }>;

export type ObjectShareKind = keyof typeof SHARE_KINDS;

export function isObjectShareKind(kind: string): kind is ObjectShareKind {
  return Object.prototype.hasOwnProperty.call(SHARE_KINDS, kind);
}

export async function writeObjectShareLink(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  kind: string,
  id: string,
  token: string | null,
): Promise<void> {
  if (!isObjectShareKind(kind)) throw new Error("Unknown share kind");
  const { table, canManage } = SHARE_KINDS[kind];
  const rowId = ctx.db.normalizeId(table, id);
  const row = rowId ? await ctx.db.get(rowId) : null;
  // One error for "no row" and "not yours", so a probe learns nothing.
  if (!row || !(await canManage(ctx, userId, row))) throw new Error("Not found");
  await claimShareToken(ctx, table, row as any, token);
}

async function byShareToken<T extends ShareTable>(ctx: any, table: T, token: string): Promise<Doc<T> | null> {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(token)) return null;
  return await ctx.db
    .query(table)
    .withIndex("by_share_token", (q: any) => q.eq("share_token", token))
    .first();
}

// ── Public views ─────────────────────────────────────────────────────────
// What a stranger holding the link reads: the object's own words, names for
// the people in it, never ids, routing facts or links into private surfaces.

export const getSharedTask = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const task = await byShareToken(ctx, "tasks", args.share_token);
    if (!task) return null;
    const [author, names, comments] = await Promise.all([
      ctx.db.get(task.user_id),
      assigneeNamesFor(ctx, [task.assignee]),
      ctx.db
        .query("task_comments")
        .withIndex("by_task_created", (q) => q.eq("task_id", task._id))
        .collect(),
    ]);
    return {
      short_id: task.short_id,
      title: task.title,
      description: task.description ?? null,
      status: task.status,
      priority: task.priority,
      task_type: task.task_type,
      labels: task.labels ?? [],
      acceptance_criteria: task.acceptance_criteria ?? [],
      assignee: task.assignee ? (names[task.assignee] ?? null) : null,
      created_at: task.created_at,
      updated_at: task.updated_at,
      closed_at: task.closed_at ?? null,
      user: author ? { name: author.name ?? null, image: author.image ?? null } : null,
      comments: comments.map((c) => ({
        author: c.author,
        text: c.text,
        comment_type: c.comment_type,
        created_at: c.created_at,
      })),
    };
  },
});

export const getSharedCall = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const t = await byShareToken(ctx, "transcripts", args.share_token);
    if (!t) return null;
    const segs = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q) => q.eq("transcript_id", t._id))
      .collect();
    // Speakers are told apart by position, never by their user ids.
    const speakerKey = new Map<string, string>();
    const keyOf = (id: string) => {
      if (!speakerKey.has(id)) speakerKey.set(id, `s${speakerKey.size}`);
      return speakerKey.get(id)!;
    };
    return {
      title: t.title ?? null,
      recording: isRecRoomKey(t.room_key),
      status: t.status,
      started_at: t.started_at,
      ended_at: t.ended_at ?? null,
      participants: (t.participants ?? []).map((p) => ({ id: keyOf(p.id), name: p.name })),
      summary: t.summary ?? null,
      action_items: t.action_items ?? [],
      recording_url: t.recording_storage_id ? await ctx.storage.getUrl(t.recording_storage_id) : null,
      segments: segs.map((s) => ({
        seq: s.seq,
        speaker_id: keyOf(s.speaker_id),
        speaker_name: s.speaker_name,
        text: s.text,
        t0: s.t0,
        t1: s.t1,
      })),
    };
  },
});
