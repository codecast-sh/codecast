// The morning agenda (docs/architecture/org-staffing.md S33). A role with
// people reporting to it sets the day's agenda with each of them: one
// recurring trigger on its standing session, armed when the first person
// reports to the role and paused when the last one leaves, controllable on
// the role's page like its check (S25: a trigger the person cancelled stays
// cancelled; one they paused by hand stays paused). The run reaches each
// person as one card they answer in a line (`cast decide --to … --line`).

import { applyPause, applyResume, applyTaskUpdate, insertTask } from "./agentTasks";
import type { Id } from "./_generated/dataModel";
import { ROLE_AGENDA_EVERY_MS, ROLE_AGENDA_PROMPT, ROLE_AGENDA_TITLE, isLiveTrigger, nextMorningAt } from "./lib/orgRoutine";

type Ctx = { db: any; scheduler?: any };

/** The role's agenda trigger in whatever status, a live one first, by the
 *  rule its routine uses: found by title and this role's id, so an earlier
 *  role's dead trigger in the same session is not this role's. */
export async function findRoleAgenda(ctx: Ctx, role: { _id: any }, standing: { _id: any }): Promise<any | null> {
  const rows: any[] = await ctx.db.query("agent_tasks").withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", standing._id)).collect();
  const mine = rows.filter((t) => t.title === ROLE_AGENDA_TITLE && (isLiveTrigger(t) || String(t.role_id ?? "") === String(role._id)));
  return mine.find((t) => t.status === "scheduled" || t.status === "running") ?? mine.find((t) => t.status === "paused") ?? mine[0] ?? null;
}

/** The morning the agenda first fires: the host's own, read from their
 *  timezone; UTC when they have none. */
async function firstMorning(ctx: Ctx, role: { host_user_id: Id<"users"> }, now: number): Promise<number> {
  const host = await ctx.db.get(role.host_user_id);
  return nextMorningAt(now, host?.timezone ?? null);
}

/** Bring the role's agenda trigger in line with who reports to it. Returns
 *  what was done, for the caller's own words. */
export async function syncRoleAgenda(ctx: Ctx, role: any, standing: { _id: any; user_id: Id<"users">; project_path?: string | null } | null, now = Date.now()): Promise<"armed" | "resumed" | "paused" | "kept" | "none"> {
  if (!standing) return "none";
  const wanted = (role.reports_user_ids ?? []).length > 0 && role.status === "active";
  const found = await findRoleAgenda(ctx, role, standing);
  if (!found) {
    if (!wanted) return "none";
    await insertTask(ctx as any, standing.user_id, {
      title: ROLE_AGENDA_TITLE,
      prompt: ROLE_AGENDA_PROMPT,
      originating_conversation_id: String(standing._id),
      project_path: standing.project_path ?? undefined,
      schedule_type: "recurring",
      interval_ms: ROLE_AGENDA_EVERY_MS,
      run_at: await firstMorning(ctx, role, now),
      mode: "apply",
      role_id: role._id,
    });
    return "armed";
  }
  // A cancelled or completed one is the person's word (S25): left alone.
  if (!isLiveTrigger(found)) return "kept";
  if (found.prompt !== ROLE_AGENDA_PROMPT) await applyTaskUpdate(ctx as any, found, { prompt: ROLE_AGENDA_PROMPT }, { userId: standing.user_id, source: "cli" });
  if (wanted && found.status === "paused" && String(found.paused_by_role_id ?? "") === String(role._id)) {
    await applyResume(ctx as any, found);
    await ctx.db.patch(found._id, { paused_by_role_id: undefined });
    return "resumed";
  }
  if (!wanted && found.status !== "paused") {
    if (await applyPause(ctx as any, found)) await ctx.db.patch(found._id, { paused_by_role_id: role._id });
    return "paused";
  }
  return "kept";
}
