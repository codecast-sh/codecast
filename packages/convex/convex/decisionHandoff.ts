// Handing an open decision to someone else, and taking it back.
//
// Pass: a person gives the decision to a teammate (it leaves the current
// people's queues and enters theirs) or to a role (the role is woken on it and
// may answer it; its people keep the card, held by the role). A note rides on
// `passed_to` and reaches the teammate as a notification.
//
// Escalate: a person sends the decision up, to the owner's manager
// (team_memberships.reports_to_user_id), else the workspace's admins, with a
// note they must write. The row is flagged `escalated` (who, why, when, to
// whom), so it sorts first in the queues of the people it went to. A later
// pass clears the flag: the decision has a deliberately chosen owner again.
//
// Both leave an entry in the decision's thread (decisionThread.ts): who
// handed it to whom, with the note.
//
// Unassign: a pass or an escalation taken back; the decision returns to the
// people it was asked of before the first hand-off.
//
// Refusals are returned, not thrown: the web sends these through the outbox
// (dispatch passDecision / escalateDecision / unassignDecision).
import { mutation } from "./functions";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { isTeamMember } from "./privacy";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { escalationTargetIds } from "@codecast/shared/contracts/decisionEscalation";
import type { Doc, Id } from "./_generated/dataModel";
import { emitNotification } from "./notificationRouter";
import { userCanAccessRole } from "./lib/orgAccess";
import { findDecision, userMayRead } from "./lib/decisionAccess";
import { resolveAskedPeople } from "./lib/decisionAudience";
import { recordHandoffEntry } from "./decisionThread";
import { HOSTED_ANSWER_REFUSED, refreshHolder, rerouteRow, syncDecisionInbox, tellHearingRole } from "./sessionDecisions";

type Ctx = { db: any; scheduler?: any };
type DecisionRow = Doc<"session_decisions">;
export type PassTarget = { kind: "user" | "role"; id: string };

const NOTE_MAX = 2000;
export const ESCALATE_NOTE_REQUIRED = "Say why it goes up: escalating needs a note";

function cleanNote(note: string | undefined): string | undefined {
  const t = note?.trim();
  return t ? t.slice(0, NOTE_MAX) : undefined;
}

// The checks every hand-off shares: the row is open, the caller may read it,
// and a hosted assistant's question stays with its owner. Returns the row and
// the team it belongs to (a line decision's is its problem's when the asking
// session is nobody's team's, a station run on a host).
async function openForHandoff(ctx: Ctx, userId: Id<"users">, decisionId: string): Promise<{ row: DecisionRow; teamId: Id<"teams"> | undefined } | { error: string }> {
  const row: DecisionRow | null = await findDecision(ctx, decisionId);
  if (!row) return { error: "Decision not found" };
  if (row.status !== "pending") return { error: `Decision is already ${row.status}` };
  if (!(await userMayRead(ctx, userId, row))) return { error: "Unauthorized: not your decision" };
  const conversation = await ctx.db.get(row.conversation_id);
  if (conversation && isHostedAgentType(conversation.agent_type)) return { error: HOSTED_ANSWER_REFUSED };
  const task = !conversation?.team_id && row.task_id ? await ctx.db.get(row.task_id) : null;
  return { row, teamId: conversation?.team_id ?? task?.team_id };
}

// The people it was asked of before anyone handed it on: taking the hand-off back returns it to them.
function handoffFrom(row: DecisionRow): Id<"users">[] | undefined {
  return row.passed_to ? row.passed_to.from : row.asked_user_ids;
}

async function noticeHandoff(ctx: Ctx, row: DecisionRow, type: "decision_passed" | "decision_escalated", by: Id<"users">, to: Id<"users">[], note: string | undefined) {
  const question = row.question.length > 120 ? `${row.question.slice(0, 117)}...` : row.question;
  const verb = type === "decision_escalated" ? "escalated" : "passed you";
  await emitNotification(ctx as any, {
    event_type: type,
    actor_user_id: by,
    entity_type: "conversation",
    entity_id: String(row.conversation_id),
    conversation_id: row.conversation_id,
    message: note ? `${verb} "${question}": ${note}` : `${verb} "${question}"`,
    ...(row.short_id ? { link: `/decisions/${row.short_id}` } : {}),
    recipient_ids: to,
  });
}

export async function passCore(ctx: Ctx, userId: Id<"users">, decisionId: string, to: PassTarget, rawNote?: string): Promise<{ passed: true } | { error: string }> {
  const open = await openForHandoff(ctx, userId, decisionId);
  if ("error" in open) return open;
  const { row, teamId } = open;
  // A trial's question may be given to a teammate (the team's decision inbox assigns it); it never climbs a role's line.
  if (row.trial && to.kind === "role") return { error: "A trial run's question stays with its trial" };
  if (row.holder?.kind === to.kind && row.holder.id === to.id && (to.kind === "role" || row.asked_user_ids?.length === 1)) {
    return { error: "It is already theirs" };
  }
  const now = Date.now();
  const note = cleanNote(rawNote);
  const from = handoffFrom(row);
  const passed_to = { ...to, by: userId, at: now, ...(from ? { from } : {}), ...(note ? { note } : {}) };
  if (to.kind === "user") {
    const target = await ctx.db.get(to.id as Id<"users">);
    if (!target || target.is_bot) return { error: "Pass it to a person or a role" };
    if (String(target._id) !== String(userId) && !(teamId && (await isTeamMember(ctx, target._id, teamId)))) {
      return { error: `${target.name ?? "They"} is not on this session's team` };
    }
    await ctx.db.patch(row._id, { passed_to, escalated: undefined, holder: { kind: "user", id: to.id }, holder_key: `user:${to.id}`, asked_user_ids: [target._id], updated_at: now });
    await syncDecisionInbox(ctx, row._id, [target._id], now);
    await noticeHandoff(ctx, row, "decision_passed", userId, [target._id], note);
    await recordHandoffEntry(ctx, row, { event: "passed", by: userId, to: { kind: "user", ids: [String(target._id)] }, note, at: now });
    return { passed: true };
  }
  const role = await ctx.db.get(to.id as Id<"org_roles">);
  if (!role || role.status === "retired") return { error: "No such role" };
  if (!(await userCanAccessRole(ctx, userId, role))) return { error: "Unauthorized: not your role" };
  if (role.team_id && teamId && String(role.team_id) !== String(teamId)) return { error: `${role.name} is on another team` };
  const woken = await tellHearingRole(ctx, role, row, now);
  if (woken.length === 0) return { error: `${role.name} has no running session to hear it` };
  const hops = (row.hops ?? []).some((h) => String(h.role_id) === String(role._id))
    ? row.hops
    : [...(row.hops ?? []), { role_id: role._id, at: now }];
  await ctx.db.patch(row._id, { passed_to, escalated: undefined, holder: { kind: "role", id: to.id }, holder_key: `role:${to.id}`, hops, updated_at: now });
  await recordHandoffEntry(ctx, row, { event: "passed", by: userId, to: { kind: "role", ids: [String(role._id)] }, note, at: now });
  return { passed: true };
}

// Who an escalation reaches (escalationTargetIds): the owner's manager, else
// the workspace's admins, read from this workspace's memberships. The owner is
// the person holding it now, else the caller.
export async function escalationTargets(ctx: Ctx, teamId: Id<"teams">, ownerId: Id<"users">): Promise<Id<"users">[]> {
  const memberships = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const members = [];
  for (const m of memberships) {
    const u = await ctx.db.get(m.user_id);
    if (u) members.push({ user_id: String(m.user_id), role: m.role, is_bot: !!u.is_bot });
  }
  const managerId = memberships.find((m: any) => String(m.user_id) === String(ownerId))?.reports_to_user_id;
  return escalationTargetIds(String(ownerId), managerId ? String(managerId) : null, members) as Id<"users">[];
}

export async function escalateCore(ctx: Ctx, userId: Id<"users">, decisionId: string, rawNote: string | undefined): Promise<{ escalated: true; to: Id<"users">[] } | { error: string }> {
  const note = cleanNote(rawNote);
  if (!note) return { error: ESCALATE_NOTE_REQUIRED };
  const open = await openForHandoff(ctx, userId, decisionId);
  if ("error" in open) return open;
  const { row, teamId } = open;
  if (!teamId) return { error: "A personal session's decision has no one above it to escalate to" };
  const ownerId = (row.holder?.kind === "user" ? row.holder.id : userId) as Id<"users">;
  const to = await escalationTargets(ctx, teamId, ownerId);
  if (to.length === 0) return { error: "Nobody is above the owner: no manager and no other admin in this workspace" };
  const now = Date.now();
  const from = handoffFrom(row);
  // A pass to the first of them, so ownership moves and re-asks keep it where it was sent; the others share the card.
  const passed_to = { kind: "user" as const, id: String(to[0]), by: userId, at: now, note, ...(from ? { from } : {}) };
  await ctx.db.patch(row._id, {
    passed_to,
    escalated: { by: userId, at: now, note, to },
    holder: { kind: "user", id: String(to[0]) },
    holder_key: `user:${to[0]}`,
    asked_user_ids: to,
    updated_at: now,
  });
  await syncDecisionInbox(ctx, row._id, to, now);
  await noticeHandoff(ctx, row, "decision_escalated", userId, to, note);
  await recordHandoffEntry(ctx, row, { event: "escalated", by: userId, to: { kind: "user", ids: to.map(String) }, note, at: now });
  return { escalated: true, to };
}

// A person takes back a pass or an escalation: the decision returns to the
// people it was asked of, or (a pass from before it recorded them) is routed
// as its asking session would route it now.
export async function unassignCore(ctx: Ctx, userId: Id<"users">, decisionId: string): Promise<{ unassigned: true } | { error: string }> {
  const row: DecisionRow | null = await findDecision(ctx, decisionId);
  if (!row) return { error: "Decision not found" };
  if (row.status !== "pending") return { error: `Decision is already ${row.status}` };
  if (!(await userMayRead(ctx, userId, row))) return { error: "Unauthorized: not your decision" };
  if (!row.passed_to) return { unassigned: true };
  const now = Date.now();
  const from = row.passed_to.from;
  await ctx.db.patch(row._id, { passed_to: undefined, escalated: undefined, updated_at: now });
  if (from) {
    // Back to the people it was asked of; a trial owner's question (no ladder) goes back to nobody's queue.
    await ctx.db.patch(row._id, { asked_user_ids: from });
    await syncDecisionInbox(ctx, row._id, from, now, !(row.trial && !row.hops?.length));
    const fresh = await ctx.db.get(row._id);
    if (fresh) await refreshHolder(ctx, fresh, now);
    return { unassigned: true };
  }
  const conversation = await ctx.db.get(row.conversation_id);
  if (!conversation) return { error: "The session that asked is gone" };
  const fresh = await ctx.db.get(row._id);
  if (fresh) await rerouteRow(ctx, conversation, fresh, now);
  return { unassigned: true };
}

// ── CLI: `cast decide pass <sd-N> --to <person> --note` and `cast decide escalate <sd-N> --note` ──

export const passForCli = mutation({
  args: { api_token: v.string(), decision_id: v.string(), to: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const row = await findDecision(ctx, args.decision_id);
    if (!row) return { error: "Decision not found" };
    const conversation = await ctx.db.get(row.conversation_id);
    if (!conversation) return { error: "The session that asked is gone" };
    const named = await resolveAskedPeople(ctx, conversation, [args.to]);
    if ("error" in named) return { error: named.error.replace(/^--to /, "") };
    const r = await passCore(ctx, auth.userId, args.decision_id, { kind: "user", id: String(named.people[0]) }, args.note);
    if ("error" in r) return r;
    const target = await ctx.db.get(named.people[0]);
    return { ...r, short_id: row.short_id, to: { _id: named.people[0], name: target?.name ?? target?.email ?? null } };
  },
});

export const escalateForCli = mutation({
  args: { api_token: v.string(), decision_id: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const r = await escalateCore(ctx, auth.userId, args.decision_id, args.note);
    if ("error" in r) return r;
    const row = await findDecision(ctx, args.decision_id);
    const names = [];
    for (const id of r.to) { const u = await ctx.db.get(id); names.push(u?.name ?? u?.email ?? "a teammate"); }
    return { escalated: true, short_id: row?.short_id, to: names };
  },
});
