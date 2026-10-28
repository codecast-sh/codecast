// One-off: bring each decision's older talk into its team thread
// (decisionThread.ts). A dry run by default: it counts what it would write.
//
// - Every ask in session_decisions.discussion[] becomes a person's comment,
//   and the reply the session gave it (placed from its transcript, as the old
//   surface read it) an agent comment under it.
// - A decision passed or escalated before the thread existed gets its
//   hand-off entry.
//
// Idempotent: every row it writes carries a client id made from the source
// (the ask's client id, the hand-off's stamp), and a row whose client id the
// thread already holds is skipped. A hand-off's id is the one the live write
// uses, so a hand-off made after the thread shipped is never written twice.
// Nothing is relayed and nobody is notified: this is history.
//
//   npx convex run decisionThreadBackfill:backfill '{}'                  # dry run, first page
//   npx convex run decisionThreadBackfill:backfill '{"dry_run": false}'  # write it
//   ... '{"dry_run": false, "cursor": "<next_cursor>"}'                    # next page

import { internalMutation } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { computeWorkspaceKey } from "./lib/access";
import { discussionTurns } from "./decisionDiscussion";
import { decisionThreadRows } from "./decisionThread";

type DecisionRow = Doc<"session_decisions">;

/** The rows the backfill would write for one decision, minus those the thread already holds. */
export async function backfillRowsFor(ctx: { db: any }, row: DecisionRow): Promise<Array<Record<string, any>>> {
  const asks = row.discussion ?? [];
  const handoff = row.escalated ?? (row.passed_to ? { ...row.passed_to } : null);
  if (asks.length === 0 && !handoff) return [];
  const existing = new Set((await decisionThreadRows(ctx, row._id)).map((c) => c.client_id));
  const conversation = await ctx.db.get(row.conversation_id);
  const task = !conversation?.team_id && row.task_id ? await ctx.db.get(row.task_id) : null;
  const workspace = computeWorkspaceKey({ user_id: conversation?.user_id ?? row.user_id, team_id: conversation?.team_id ?? task?.team_id }, conversation);
  const base = { decision_id: row._id, resolved: false, workspace };
  const out: Array<Record<string, any>> = [];
  const turns = asks.length ? await discussionTurns(ctx, row) : [];
  for (const t of turns) {
    const askId = `decision-backfill:${t.client_id}`;
    if (!existing.has(askId)) {
      out.push({ ...base, content: t.text, client_id: askId, author_kind: "user", author_user_id: t.user_id, decision_session_id: t.conversation_id, created_at: t.at });
    }
    const replyId = `decision-backfill-reply:${t.client_id}`;
    if (t.reply && !existing.has(replyId)) {
      out.push({ ...base, content: t.reply.text, client_id: replyId, author_kind: "agent", agent_status: "done", decision_session_id: t.conversation_id, created_at: t.reply.at, reply_to: askId });
    }
  }
  if (row.escalated) {
    const id = `decision-escalated:${row._id}:${row.escalated.at}`;
    if (!existing.has(id)) {
      out.push({ ...base, content: row.escalated.note ?? "", client_id: id, author_kind: "user", author_user_id: row.escalated.by, decision_event: "escalated", decision_event_to: { kind: "user", ids: row.escalated.to.map(String) }, created_at: row.escalated.at });
    }
  } else if (row.passed_to?.by && row.passed_to.at) {
    const id = `decision-passed:${row._id}:${row.passed_to.at}`;
    if (!existing.has(id)) {
      out.push({ ...base, content: row.passed_to.note ?? "", client_id: id, author_kind: "user", author_user_id: row.passed_to.by, decision_event: "passed", decision_event_to: { kind: row.passed_to.kind, ids: [String(row.passed_to.id)] }, created_at: row.passed_to.at });
    }
  }
  return out;
}

/** Write one decision's rows: a reply hangs under the ask it answers, which may be written in the same pass. */
async function writeRows(ctx: { db: any }, row: DecisionRow, rows: Array<Record<string, any>>): Promise<void> {
  const ids = new Map<string, Id<"review_comments">>();
  for (const c of await decisionThreadRows(ctx, row._id)) if (c.client_id) ids.set(c.client_id, c._id);
  for (const { reply_to, ...fields } of rows) {
    const parent = reply_to ? ids.get(reply_to) : undefined;
    const id = await ctx.db.insert("review_comments", { ...fields, ...(parent ? { parent_id: parent } : {}) });
    ids.set(fields.client_id, id);
  }
}

export const backfill = internalMutation({
  args: { dry_run: v.optional(v.boolean()), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const dryRun = args.dry_run !== false;
    const page = await ctx.db.query("session_decisions").paginate({ cursor: args.cursor ?? null, numItems: Math.min(Math.max(args.limit ?? 100, 1), 200) });
    let decisions = 0;
    let comments = 0;
    let replies = 0;
    let handoffs = 0;
    for (const row of page.page) {
      const rows = await backfillRowsFor(ctx, row);
      if (rows.length === 0) continue;
      decisions++;
      for (const r of rows) {
        if (r.decision_event) handoffs++;
        else if (r.author_kind === "agent") replies++;
        else comments++;
      }
      if (!dryRun) await writeRows(ctx, row, rows);
    }
    return { dry_run: dryRun, decisions, comments, replies, handoffs, next_cursor: page.isDone ? null : page.continueCursor };
  },
});
