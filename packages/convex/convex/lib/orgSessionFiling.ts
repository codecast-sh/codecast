import { Id } from "../_generated/dataModel";
import { labelsOf, noteOrgChange, recordSubject, rememberOrgRecord, sessionSubject, whereOfRecord, whereOfSession } from "./orgChangeLog";
import { workspaceForResource, workspaceKey } from "./access";
import { checkConversationAccess } from "../privacy";
import { addConversationToWorkItem } from "../conversationLinks";
import { claimTaskOwnership } from "./taskOwner";
import { findConversationByAnyRefWhere } from "../conversationSessionLookup";
import { performReparentSession } from "../sessionOwnership";
import { resolveScopeRef, rolesInBoundary } from "../orgRoles";
import { sessionDestination, type OrgFileChange, type OrgFileSessionChange } from "@codecast/shared/contracts/orgProposal";
import type { OrgScan } from "../org";
import type { ApplyOpts, ApplyResult, Boundary } from "../orgInit";

// Filing: a plan under a project, and the person's sessions where they belong.
// The apply cores orgInit dispatches to, and the inputs' list of loose sessions.

type Ctx = { db: any };
const LOOSE_SESSIONS_CAP = 40;

export async function applyFile(ctx: Ctx, _userId: Id<"users">, boundary: Boundary, p: OrgFileChange, _opts: ApplyOpts): Promise<ApplyResult> {
  const planRef = await resolveScopeRef(ctx, boundary, `plan:${p.plan}`);
  const projectRef = await resolveScopeRef(ctx, boundary, `project:${p.project}`);
  const plan = planRef.kind === "plan" ? await ctx.db.get(planRef.id) : null;
  const project = projectRef.kind === "project" ? await ctx.db.get(projectRef.id) : null;
  if (!plan || !project) throw new Error(`No ${!plan ? `plan "${p.plan}"` : `project "${p.project}"`} in this workspace`);
  if (String(plan.project_id ?? "") === String(project._id)) return { status: "applied", note: `${plan.short_id} is already under "${project.title}"` };
  const now = Date.now();
  await ctx.db.patch(plan._id, { project_id: project._id, updated_at: now });
  if (plan.doc_id) { const doc = await ctx.db.get(plan.doc_id); if (doc) await ctx.db.patch(doc._id, { project_id: project._id, updated_at: now }); }
  await noteOrgChange(ctx, _userId, whereOfRecord(plan), { kind: "file", subject: recordSubject("plan", plan), before: { project_id: plan.project_id ?? null }, after: { project_id: String(project._id) }, labels: await labelsOf(ctx, [plan.project_id, project._id]) });
  return { status: "applied", note: `filed ${plan.short_id} "${plan.title}" under "${project.title}"` };
}

// ── The person's sessions, filed where they belong (org-staffing.md S43) ────
// A loose session of the person's goes under the role that owns its area,
// onto the task it works, or out of the inbox as done. Each goes through the
// door a person uses for the same act: the reparent core, the task binding,
// the inbox's done. Only a session the deciding person owns is filed.

export async function applyFileSession(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgFileSessionChange, _opts: ApplyOpts): Promise<ApplyResult> {
  const to = sessionDestination(p.to);
  if (!to) throw new Error(`"${p.to}" names no role, task or done`);
  const conv: any = await findConversationByAnyRefWhere(ctx as any, p.session, async (c: any) => (await checkConversationAccess(ctx as any, userId, c)) === "owner");
  if (!conv) throw new Error(`No session ${p.session} of yours`);
  const short = conv.short_id ?? String(conv._id).slice(0, 7);
  const named = conv.title ? `${short} "${conv.title}"` : short;
  if (to.kind === "role") {
    const role = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === to.handle);
    if (!role) throw new Error(`No live role @${to.handle} in this workspace`);
    if (String(conv.org_role_id ?? "") === String(role._id)) return { status: "applied", note: `${named} already reports to @${role.handle}` };
    await performReparentSession(ctx as any, userId, { session_id: String(conv._id), target: { kind: "role", role_id: role._id } as any });
    return { status: "applied", note: `${named} now reports to @${role.handle}` };
  }
  rememberOrgRecord(ctx, conv);
  if (to.kind === "done") {
    if (conv.inbox_dismissed_at) return { status: "applied", note: `${named} is already done` };
    await ctx.db.patch(conv._id, { inbox_dismissed_at: Date.now() });
    await noteOrgChange(ctx, userId, whereOfSession(conv), { kind: "file_session", subject: sessionSubject(conv), before: { done: null }, after: { done: true } });
    return { status: "applied", note: `${named} closed as done` };
  }
  const key = workspaceKey(boundary.team_id ? { type: "team", teamId: boundary.team_id } : { type: "personal", userId });
  const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", to.task)).first();
  if (!task || workspaceKey(workspaceForResource(task)) !== key) throw new Error(`No task "${to.task}" in this workspace`);
  if (String(conv.active_task_id ?? "") === String(task._id)) return { status: "applied", note: `${named} already works ${task.short_id}` };
  await addConversationToWorkItem(ctx, userId, "task", task, conv._id);
  // A task another live session owns keeps its owner: the filing links the session to it and binds nothing.
  const bound = await claimTaskOwnership(ctx, conv, task, { take: false }).then(() => true, () => false);
  if (bound) await noteOrgChange(ctx, userId, whereOfSession(conv), { kind: "file_session", subject: sessionSubject(conv), before: { task_id: conv.active_task_id ? String(conv.active_task_id) : null }, after: { task_id: String(task._id) }, labels: { [String(task._id)]: task.short_id } });
  return { status: "applied", note: bound ? `${named} now works ${task.short_id} "${task.title}"` : `${named} is linked to ${task.short_id} "${task.title}", which another live session owns` };
}

/** A proposal that only files sessions, every one the caller's own: theirs
 *  to decide on the card without being an admin, since each filing moves
 *  nothing but where their own session sits. */
export async function filesOnlyOwnSessions(ctx: Ctx, userId: Id<"users">, rows: ReadonlyArray<{ status: string; change: { kind: string; session?: string } }>): Promise<boolean> {
  const live = rows.filter((r) => r.status !== "removed");
  if (!live.length || live.some((r) => r.change.kind !== "file_session")) return false;
  for (const r of live) {
    const own = await findConversationByAnyRefWhere(ctx as any, String(r.change.session), async (c: any) => (await checkConversationAccess(ctx as any, userId, c)) === "owner");
    if (!own) return false;
  }
  return true;
}

// ── The person's loose sessions (org-staffing.md S43) ─────────────────────
// The sessions in the caller's own inbox that nothing places: no role holds
// them, no task binds them, and they are no seat. A workflow's station and a
// trigger's run already belong to what started them, and a stashed session is
// out of the inbox. Newest first, with the facts a filing needs; `cast read`
// says the rest.
export async function looseSessionsOf(_ctx: Ctx, scan: OrgScan, userId: Id<"users">) {
  const rows = (scan.byParent.get(`user:${String(userId)}`) ?? [])
    .map((s: any) => ({ s, raw: scan.sessions.get(String(s._id))?.raw }))
    .filter(({ s, raw }) => raw && !s.is_anchor && !raw.standing_role_id && !raw.org_role_id && !raw.active_task_id && !raw.workflow_run_id && !raw.agent_task_id && !raw.inbox_stashed_at)
    .sort((a, b) => b.s.updated_at - a.s.updated_at);
  return {
    count: rows.length,
    rows: rows.slice(0, LOOSE_SESSIONS_CAP).map(({ s, raw }) => ({
      short_id: s.short_id ?? String(s._id).slice(0, 7),
      title: s.title,
      state: s.state,
      last_active_at: s.updated_at,
      started_at: raw.started_at ?? null,
      messages: raw.message_count ?? 0,
      project_path: raw.project_path ?? null,
    })),
  };
}
