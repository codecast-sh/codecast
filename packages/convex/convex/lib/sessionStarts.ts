// session_starts: one small row per conversation (who, which agent, when it
// started, which team can see it), so counting sessions over a window reads
// these instead of conversation rows that carry an embedding, a diff and a
// heartbeat each. Kept in step by makeSessionStartsDb, which every wrapped
// mutation's db passes through (functions.ts): any insert, replace, delete,
// or patch of a field the row derives from re-derives it. The row's team is
// the visibility rule's answer (teamVisibleConvTeam), so a session made
// private leaves its team's count at once.

import type { Doc, Id } from "../_generated/dataModel";
import { teamVisibleConvTeam } from "../privacy";

/** The conversation fields a session_starts row derives from. */
const DERIVED_FROM = ["user_id", "team_id", "is_private", "auto_shared", "team_visibility", "agent_type", "started_at", "is_subagent", "parent_conversation_id"];

export function sessionStartFields(conv: Doc<"conversations">) {
  const visible = teamVisibleConvTeam(conv);
  return {
    conversation_id: conv._id,
    user_id: conv.user_id,
    ...(visible ? { visible_team_id: visible } : {}),
    agent_type: String(conv.agent_type),
    started_at: conv.started_at,
    subagent: !!(conv.is_subagent || conv.parent_conversation_id),
  };
}

const same = (row: any, next: ReturnType<typeof sessionStartFields>) =>
  String(row.user_id) === String(next.user_id) &&
  String(row.visible_team_id ?? "") === String(next.visible_team_id ?? "") &&
  row.agent_type === next.agent_type &&
  row.started_at === next.started_at &&
  row.subagent === next.subagent;

/** Re-derive one conversation's row from what it is now: write it, rewrite it, or drop it with the conversation. */
export async function syncSessionStart(db: any, conversationId: Id<"conversations">): Promise<void> {
  const conv = await db.get(conversationId);
  const row = await db.query("session_starts").withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId)).first();
  if (!conv) {
    if (row) await db.delete(row._id);
    return;
  }
  const next = sessionStartFields(conv);
  if (!row) await db.insert("session_starts", next);
  else if (!same(row, next)) await db.replace(row._id, next);
}

/**
 * The db a mutation sees, with session_starts following conversation writes.
 * Rows are written through the raw db: they are a derived index, not news
 * for the sync log.
 */
export function makeSessionStartsDb(db: any, rawDb: any): any {
  if (typeof rawDb?.normalizeId !== "function") return db;
  const isConversation = (id: any) => !!rawDb.normalizeId("conversations", String(id));
  return {
    ...db,
    get: (...args: any[]) => db.get(...args),
    query: (...args: any[]) => db.query(...args),
    normalizeId: (...args: any[]) => db.normalizeId(...args),
    system: db.system,
    async insert(table: string, doc: any) {
      const id = await db.insert(table, doc);
      if (table === "conversations") await syncSessionStart(rawDb, id);
      return id;
    },
    async patch(id: any, fields: any) {
      const res = await db.patch(id, fields);
      if (fields && DERIVED_FROM.some((f) => f in fields) && isConversation(id)) await syncSessionStart(rawDb, id);
      return res;
    },
    async replace(id: any, doc: any) {
      const res = await db.replace(id, doc);
      if (isConversation(id)) await syncSessionStart(rawDb, id);
      return res;
    },
    async delete(id: any) {
      const res = await db.delete(id);
      if (isConversation(id)) await syncSessionStart(rawDb, id);
      return res;
    },
  };
}
