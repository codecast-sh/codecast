/**
 * Project memory: corrections and decisions consolidated per project from
 * session insights, in plain code. No model call runs here; the only
 * inference is the insight call that already runs after every settle.
 *
 * Access is the stored `workspace` key (computeWorkspaceKey of the source
 * conversation, as decisions do); `team_id` is routing only. Reads are one
 * equality on by_workspace_project against a key the caller holds.
 */
import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { ProjectMemoryItem, ProjectMemoryKind, ProjectMemoryResponse } from "@codecast/shared/contracts/projectMemory";
import { computeWorkspaceKey, heldKeysFor } from "./lib/accessKeys";
import { activeTeamMembershipFor } from "./lib/access";
import { teamVisibleConvTeam } from "./privacy";
import { getAuthenticatedUserId } from "./pendingMessages";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { DEDUP_SIMILARITY_THRESHOLD, titleSimilarity } from "./taskMining";
import { insertDecision } from "./decisions";

export const PROJECT_MEMORY_MAX_ROWS = 20;
export const PROJECT_MEMORY_MAX_SOURCES = 5;
export const PROJECT_MEMORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

type MemoryRow = Pick<
  Doc<"project_memory">,
  "kind" | "text" | "detail" | "count" | "first_seen" | "last_seen" | "conversation_ids" | "promoted"
>;

export function isPromoted(row: Pick<MemoryRow, "count" | "conversation_ids">): boolean {
  return row.conversation_ids.length >= 2 || row.count >= 3;
}

/** The one place memory rows are folded: dedupe by token overlap against the
 *  project's rows (titleSimilarity, the taskMining rule), bump or insert, then
 *  age out rows not seen in 90 days and keep the top 20 by count then recency.
 *  Pure, so a test needs no database. */
export function foldProjectMemory<T extends MemoryRow>(
  rows: T[],
  incoming: Array<{ kind: ProjectMemoryKind; text: string; detail?: string }>,
  conversationId: Id<"conversations">,
  now: number,
): { rows: Array<T | MemoryRow>; added: MemoryRow[] } {
  const next: Array<T | MemoryRow> = [...rows];
  const added: MemoryRow[] = [];
  for (const item of incoming) {
    const match = next.find((r) => r.kind === item.kind && titleSimilarity(r.text, item.text) >= DEDUP_SIMILARITY_THRESHOLD);
    if (match) {
      match.count += 1;
      match.last_seen = Math.max(match.last_seen, now);
      if (!match.conversation_ids.some((id) => String(id) === String(conversationId)) && match.conversation_ids.length < PROJECT_MEMORY_MAX_SOURCES) {
        match.conversation_ids = [...match.conversation_ids, conversationId];
      }
      if (item.detail && !match.detail) match.detail = item.detail;
      match.promoted = isPromoted(match);
      continue;
    }
    const row: MemoryRow = {
      kind: item.kind,
      text: item.text,
      detail: item.detail,
      count: 1,
      first_seen: now,
      last_seen: now,
      conversation_ids: [conversationId],
      promoted: false,
    };
    next.push(row);
    added.push(row);
  }
  const kept = next
    .filter((r) => now - r.last_seen <= PROJECT_MEMORY_MAX_AGE_MS)
    .sort((a, b) => b.count - a.count || b.last_seen - a.last_seen)
    .slice(0, PROJECT_MEMORY_MAX_ROWS);
  return { rows: kept, added: added.filter((r) => kept.includes(r)) };
}

/** Runs inside upsertSessionInsight. Reads the project's rows for the
 *  conversation's workspace, folds the insight's items in, writes the diff,
 *  and records each new decision through insertDecision as automatic so it
 *  appears in `cast decisions`. */
export async function consolidateProjectMemory(
  ctx: { db: any },
  args: {
    conversation_id: Id<"conversations">;
    team_id?: Id<"teams">;
    user_id: Id<"users">;
    corrections: Array<{ said: string; instead: string }>;
    decisions: Array<{ title: string; why: string }>;
    now: number;
  },
): Promise<void> {
  if (!args.corrections.length && !args.decisions.length) return;
  const conversation = (await ctx.db.get(args.conversation_id)) as Doc<"conversations"> | null;
  const projectPath = conversation?.project_path;
  if (!conversation || !projectPath) return;
  const workspace = computeWorkspaceKey({ user_id: args.user_id, team_id: args.team_id }, conversation);
  const existing: Doc<"project_memory">[] = await ctx.db
    .query("project_memory")
    .withIndex("by_workspace_project", (q: any) => q.eq("workspace", workspace).eq("project_path", projectPath))
    .collect();
  const incoming = [
    ...args.corrections.map((c) => ({ kind: "correction" as const, text: c.instead, detail: c.said })),
    ...args.decisions.map((d) => ({ kind: "decision" as const, text: d.title, detail: d.why })),
  ];
  const { rows, added } = foldProjectMemory(existing, incoming, args.conversation_id, args.now);
  const keptIds = new Set(rows.filter((r): r is Doc<"project_memory"> => "_id" in r).map((r) => String(r._id)));
  for (const row of existing) {
    if (!keptIds.has(String(row._id))) await ctx.db.delete(row._id);
    else {
      const { _id, _creationTime, ...fields } = row;
      await ctx.db.patch(_id, fields);
    }
  }
  for (const row of rows) {
    if ("_id" in row) continue;
    await ctx.db.insert("project_memory", {
      ...row,
      workspace,
      team_id: args.team_id,
      user_id: args.user_id,
      project_path: projectPath,
    });
  }
  for (const row of added) {
    if (row.kind !== "decision" || !row.detail) continue;
    await insertDecision(
      ctx,
      args.user_id,
      { title: row.text, rationale: row.detail, project_path: projectPath, tags: ["automatic"], source: "automatic" },
      conversation,
    );
  }
}

export function toMemoryItem(row: Doc<"project_memory">): ProjectMemoryItem {
  return {
    id: String(row._id),
    kind: row.kind,
    text: row.text,
    detail: row.detail,
    count: row.count,
    sessions: row.conversation_ids.length,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    promoted: row.promoted,
  };
}

/** The caller's project memory: the workspace of the named session when one
 *  is given, else the caller's active team, else personal. The key must be one
 *  the caller holds, so a foreign session ref reads nothing. */
export const list = query({
  args: {
    api_token: v.optional(v.string()),
    session: v.optional(v.string()),
    project_path: v.optional(v.string()),
    all: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ProjectMemoryResponse | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const held = await heldKeysFor(ctx, userId);
    let conversation: any = null;
    if (args.session) {
      conversation = await findConversationByAnyRefWhere(ctx, args.session, (c: any) => held.has(computeWorkspaceKey({ user_id: c.user_id }, c)));
    }
    const projectPath: string | undefined = args.project_path ?? conversation?.project_path;
    if (!projectPath) return { project_path: null, items: [] };
    const teamId: Id<"teams"> | undefined = conversation
      ? teamVisibleConvTeam(conversation)
      : (await activeTeamMembershipFor(ctx, userId))?.teamId;
    const workspace = computeWorkspaceKey({ user_id: userId, team_id: teamId }, conversation);
    if (!held.has(workspace)) return { project_path: projectPath, items: [] };
    const rows: Doc<"project_memory">[] = await ctx.db
      .query("project_memory")
      .withIndex("by_workspace_project", (q: any) => q.eq("workspace", workspace).eq("project_path", projectPath))
      .collect();
    const items = rows
      .filter((r) => args.all || r.promoted)
      .sort((a, b) => b.count - a.count || b.last_seen - a.last_seen)
      .map(toMemoryItem);
    return { project_path: projectPath, items };
  },
});
