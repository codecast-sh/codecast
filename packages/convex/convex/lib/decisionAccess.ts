// Who may read a session decision, and the pages filed on it. A leaf, so a
// module sessionDecisions.ts itself imports (artifacts.ts) can ask the same
// question without an import cycle.
import type { Doc, Id } from "../_generated/dataModel";
import { canAccessConversation, canAccessTask } from "./access";
import { roleGrants } from "./orgAccess";

type DecisionRow = Doc<"session_decisions">;
type Ctx = { db: any };

/** A decision by short id ("sd-N") or Convex id. */
export async function findDecision(ctx: Ctx, ref: string): Promise<DecisionRow | null> {
  if (/^sd-\d+$/.test(ref)) {
    return (
      (await ctx.db
        .query("session_decisions")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", ref))
        .first()) ?? null
    );
  }
  const id = ctx.db.normalizeId("session_decisions", ref);
  return id ? await ctx.db.get(id) : null;
}

// Who may read a decision: its people, anyone who can read the asking
// conversation, and the HOST (or personal owner) of a role on its ladder,
// reading what their seat was asked. Not the role's whole team: a private
// conversation reporting to a team role must not open its decisions to every
// member; team visible conversations are covered by the conversation clause.
// A line decision (a run asks it about a problem) is the problem's: whoever can
// read the problem reads it, answers it and assigns it, so a team's line
// decisions are the whole team's, whichever session asked.
export async function userMayRead(ctx: Ctx, userId: Id<"users">, row: DecisionRow): Promise<boolean> {
  const people = (row.asked_user_ids ?? [row.user_id]).map(String);
  if (people.includes(String(userId))) return true;
  const conversation = await ctx.db.get(row.conversation_id);
  if (conversation && (await canAccessConversation(ctx as any, userId, conversation))) return true;
  for (const hop of row.hops ?? []) {
    const role = await ctx.db.get(hop.role_id);
    if (role && (await roleGrants(ctx as any, userId, role, () => false))) return true;
  }
  if (row.workflow_run_id && row.task_id) {
    const task = await ctx.db.get(row.task_id);
    if (task && (await canAccessTask(ctx as any, userId, task))) return true;
  }
  return false;
}

/** The published pages the asking session filed on the decision: its report and any option's page. */
export function decisionPageSlugs(row: Pick<DecisionRow, "report_slug" | "options">): string[] {
  return [row.report_slug, ...(row.options ?? []).map((o: { page_slug?: string }) => o.page_slug)].filter((s): s is string => !!s);
}
