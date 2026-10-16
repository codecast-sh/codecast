// The person's inbox as the Head of People looks at it (org-staffing.md S43):
// its daily look, armed beside the role's routine, and the loose sessions the
// look and its precheck read (`cast org loose`).

import { v } from "convex/values";
import { query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { insertTask, applyTaskUpdate } from "./agentTasks";
import { collectOrgSessions, requireWorkspaceCaller } from "./org";
import { looseSessionsOf } from "./lib/orgSessionFiling";
import { HEAD_INBOX_EVERY_MS, HEAD_INBOX_PROMPT, HEAD_INBOX_TITLE, headInboxPrecheck, isLiveTrigger } from "./lib/orgRoutine";
import { isHeadOfPeopleRole } from "./lib/orgAccess";

type Ctx = { db: any; scheduler?: any };

/** The role's inbox look in whatever status, a live one first, found by title
 *  and this role's id like its agenda (orgAgenda.findRoleAgenda). */
export async function findInboxLook(ctx: Ctx, role: { _id: any }, standing: { _id: any }): Promise<any | null> {
  const rows: any[] = await ctx.db.query("agent_tasks").withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", standing._id)).collect();
  const mine = rows.filter((t) => t.title === HEAD_INBOX_TITLE && (isLiveTrigger(t) || String(t.role_id ?? "") === String(role._id)));
  return mine.find((t) => t.status === "scheduled" || t.status === "running") ?? mine.find((t) => t.status === "paused") ?? mine[0] ?? null;
}

/** Arm the Head of People's daily inbox look, once; a live one is brought up
 *  to the current prompt, and one the person cancelled stays cancelled (S25). */
export async function syncInboxLook(ctx: Ctx, role: any, standing: { _id: any; user_id: Id<"users">; project_path?: string | null } | null, now = Date.now()): Promise<"armed" | "kept" | "none"> {
  if (!standing || !isHeadOfPeopleRole(role)) return "none";
  const found = await findInboxLook(ctx, role, standing);
  const precheck = headInboxPrecheck(role);
  if (found) {
    if (isLiveTrigger(found) && (found.prompt !== HEAD_INBOX_PROMPT || !found.precheck)) await applyTaskUpdate(ctx as any, found, { prompt: HEAD_INBOX_PROMPT, ...(found.precheck ? {} : { precheck }) }, { userId: standing.user_id, source: "cli" });
    return "kept";
  }
  await insertTask(ctx as any, standing.user_id, {
    title: HEAD_INBOX_TITLE,
    prompt: HEAD_INBOX_PROMPT,
    originating_conversation_id: String(standing._id),
    project_path: standing.project_path ?? undefined,
    schedule_type: "recurring",
    interval_ms: HEAD_INBOX_EVERY_MS,
    run_at: now + HEAD_INBOX_EVERY_MS,
    precheck,
    mode: "apply",
    role_id: role._id,
  });
  return "armed";
}

/** When the Head of People last looked: its inbox look's last run, or null.
 *  The scan already holds the workspace's roles and their anchors. */
async function lastLookAt(ctx: Ctx, scan: { roles: any[]; anchors: any[] }): Promise<number | null> {
  const head = scan.roles.find((r) => r.status === "active" && isHeadOfPeopleRole(r));
  const anchor = head ? scan.anchors.find((a) => String(a._id) === String(head.anchor_id)) : null;
  if (!anchor?.conversation_id) return null;
  return (await findInboxLook(ctx, head, { _id: anchor.conversation_id }))?.last_run_at ?? null;
}

/** The loose sessions, and which of them started since the last look. */
export function newSinceLook<T extends { started_at: number | null; last_active_at: number }>(rows: readonly T[], lastLook: number | null): T[] {
  return rows.filter((r) => (r.started_at ?? r.last_active_at) > (lastLook ?? 0));
}

export const loose = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    const scan = await collectOrgSessions(ctx as any, userId, args.team_id, Date.now());
    const found = await looseSessionsOf(ctx, scan, userId);
    const last = await lastLookAt(ctx, scan);
    return { ...found, last_look_at: last, new: newSinceLook(found.rows, last).map((r) => r.short_id) };
  },
});
