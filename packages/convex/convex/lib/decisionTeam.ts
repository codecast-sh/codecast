// The team a decision routes to, stamped as session_decisions.team_id so a
// team's Decisions page and its Flows' decisions read one team's rows by index
// (by_team_status_created) instead of the deployment's newest. ROUTING only:
// every read still answers to userMayRead. A decision about a problem goes to
// the problem's team, else to the asking conversation's; unset is personal.
import type { Doc, Id } from "../_generated/dataModel";

type Ctx = { db: any };

export function decisionTeamOf(
  conversation: Pick<Doc<"conversations">, "team_id"> | null,
  task: Pick<Doc<"tasks">, "team_id"> | null | undefined,
): Id<"teams"> | undefined {
  return task?.team_id ?? conversation?.team_id ?? undefined;
}

/** The stamp a stored row should carry now, read from its conversation and task. */
export async function decisionTeamFor(ctx: Ctx, row: Pick<Doc<"session_decisions">, "conversation_id" | "task_id">): Promise<Id<"teams"> | undefined> {
  const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
  if (task?.team_id) return task.team_id;
  const conversation: Doc<"conversations"> | null = await ctx.db.get(row.conversation_id);
  return decisionTeamOf(conversation, task);
}

/** After a conversation moves team (patchConversationVisibility), its decisions move with it. */
export async function restampDecisionTeams(ctx: Ctx, conversationId: Id<"conversations">): Promise<number> {
  const rows: Doc<"session_decisions">[] = await ctx.db.query("session_decisions").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId)).take(500);
  let moved = 0;
  for (const r of rows) {
    const team = await decisionTeamFor(ctx, r);
    if (String(team ?? "") === String(r.team_id ?? "")) continue;
    await ctx.db.patch(r._id, { team_id: team });
    moved++;
  }
  return moved;
}
