// Team suggestions: the teammate's side of moderated steering (the owner's
// side is guestSuggestions.ts, shared with guests). While an owner of a
// session is in it, a teammate's message from the dashboard does not land in
// the transcript; it waits as a card above the owner's composer, and the
// owner sends it, edits then sends it, or dismisses it. A session nobody is
// attending keeps direct send, so work never waits on an absent owner.
//
// An admin of the session's team never suggests or proposes there: their
// messages go straight in (adminOfSessionTeam), and they answer its open
// questions, plan approvals and permission prompts directly, as the runner
// does (adminAnswers, adminAnswersPrompts). Only those: "Allow all", resume,
// kill and the other daemon commands stay with the runner and the primary
// owner (commandsSession), and so does Needs You.
//
// "In it" is the roster's own fact (teams.getTeamMembers): the owner's window
// reports this session as its view (pushRouter.reportPresence, cleared after
// a long blur or a closed tab) and their presence derives to "active". The
// web composer reads the same two fields off the roster to say "Suggest"
// before the press; this module decides at send time.
//
// A teammate who is not an admin can also propose an answer to the agent's
// open question (kind "answer", submitted by the owner as their own reply) or
// an approve/deny on a pending permission (kind "permission", settled when the
// owner answers that permission). Decided rows keep their disposition, so the
// author sees what happened to each one.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { checkConversationAccess, getOwnerMembership, isTeamAdmin, resolveVisibilityMode } from "./privacy";
import { effectiveMembershipVisibility } from "./teamVisibility";
import { derivePresenceState, PRESENCE_FRESH_MS } from "./presenceState";
import { performSessionSend } from "./pendingMessages";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { parseJointMessage } from "@codecast/shared/contracts/jointMessage";

type Ctx = { db: any };

export const TEAM_PENDING_MAX = 5;
// Answer and permission proposals waiting per author per session: one per
// open question or prompt in practice; the cap only bounds a misbehaving client.
export const TEAM_PROPOSALS_MAX = 10;
export const TEAM_SUGGESTION_MAX_CHARS = 8000;
// A prose answer is typed at the agent's prompt as the owner's own words, so
// the owner must be able to read all of it on the card before pressing Send.
export const PROSE_ANSWER_MAX_CHARS = 1000;
// A proposal on a question or prompt is moot after this: permissions.ts hides
// pending prompts older than two hours, and an answer the transcript has not
// shown by then was given elsewhere.
export const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;
const MINE_HISTORY = 20;

/** Waiting, and not a proposal on a question or prompt that has gone stale. */
export function liveSuggestion(row: any, now: number): boolean {
  return row.status === "pending" && (!row.kind || now - row.created_at < PROPOSAL_TTL_MS);
}

/** A menu answer already queued for this session and not yet delivered: the
 *  owner answered on the card a moment ago and the transcript has not caught
 *  up, so another answer now would press keys into whatever comes next. */
export async function answerOnItsWay(ctx: Ctx, conversationId: Id<"conversations">, since: number): Promise<boolean> {
  for (const status of ["pending", "injected", "delivered"]) {
    const rows = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", status))
      .order("desc")
      .take(50);
    // Any message queued after the question answers it: the daemon types a
    // plain reply into an open menu too (cli typedPollAnswer).
    if (rows.some((r: any) => r._creationTime >= since)) return true;
  }
  return false;
}

/** Open in the transcript, and no answer to it already queued. */
export async function askStillOpen(ctx: Ctx, conversationId: Id<"conversations">, toolUseId: string): Promise<boolean> {
  const ask = await openAsk(ctx, conversationId, toolUseId);
  return !!ask && !(await answerOnItsWay(ctx, conversationId, ask.askedAt));
}

/** Whether a waiting proposal's question or prompt is still open, whichever
 *  writer closed it (the owner's own press, the terminal, a cron). */
async function proposalOpen(ctx: Ctx, r: any, open: Map<string, boolean>): Promise<boolean> {
  if (r.status !== "pending" || !r.kind) return true;
  const key = `${r.kind}:${r.kind === "permission" ? r.permission_id : r.tool_use_id}`;
  if (!open.has(key)) {
    open.set(key, r.kind === "permission"
      ? (await ctx.db.get(r.permission_id))?.status === "pending"
      : await askStillOpen(ctx, r.conversation_id, r.tool_use_id));
  }
  return open.get(key)!;
}

/** The owner's list: waiting proposals only while what they answer is open. */
export async function withoutEndedPrompts(ctx: Ctx, rows: any[]): Promise<any[]> {
  const open = new Map<string, boolean>();
  const out = [];
  for (const r of rows) if (await proposalOpen(ctx, r, open)) out.push(r);
  return out;
}

/** Whether this viewer reads the session's detail, so may see its prompts
 *  and propose answers: an owner, or a teammate at the full or detailed
 *  level. A session shared with the team at summary keeps its commands to
 *  itself. */
export async function viewerSeesDetail(ctx: Ctx, userId: Id<"users">, conversation: Doc<"conversations">): Promise<boolean> {
  const access = await checkConversationAccess(ctx, userId, conversation);
  if (access === "owner") return true;
  if (access !== "team" || !conversation.team_id) return false;
  const membership = await getOwnerMembership(ctx, conversation.user_id, conversation.team_id);
  const mode = resolveVisibilityMode((conversation as any).team_visibility, effectiveMembershipVisibility(membership, conversation.started_at), true);
  return mode === "full" || mode === "detailed";
}

/** The people whose press answers the session's cards: the runner and the
 *  primary owner (the client's commandsSession). Assigned owners beyond them
 *  steer by message, so they suggest answers like any teammate. An admin of
 *  the session's team answers too (adminAnswers), but is not an owner whose
 *  presence holds anyone's messages. */
export function answerers(conversation: Doc<"conversations">): Set<string> {
  const ids = new Set<string>([String(conversation.user_id)]);
  if ((conversation as any).owner_user_id) ids.add(String((conversation as any).owner_user_id));
  return ids;
}

/** Whether this person is an admin of the team the session belongs to. They
 *  outrank its runner there, so their messages never wait as suggestions
 *  (web lib/steering.ts adminOfTeam is the client's copy). */
export async function adminOfSessionTeam(ctx: Ctx, userId: Id<"users">, conversation: Doc<"conversations">): Promise<boolean> {
  return !!conversation.team_id && await isTeamAdmin(ctx, userId, conversation.team_id);
}

/** An admin who answers the session's questions and plan approvals directly
 *  instead of proposing: an admin of its team who reads its detail, on a
 *  session a person's daemon runs (not a role's standing session or a hosted
 *  agent). Web lib/steering.ts answerRoles is the client's copy. */
export async function adminAnswers(ctx: Ctx, userId: Id<"users">, conversation: Doc<"conversations">): Promise<boolean> {
  if ((conversation as any).standing_role_id || isHostedAgentType((conversation as any).agent_type)) return false;
  return await adminOfSessionTeam(ctx, userId, conversation) && await viewerSeesDetail(ctx, userId, conversation);
}

/** The same admin on the session's permission prompts, except on a bot-run
 *  session, whose prompts only its runner is shown
 *  (permissions.getPendingPermissions, updatePermissionStatus). */
export async function adminAnswersPrompts(ctx: Ctx, userId: Id<"users">, conversation: Doc<"conversations">): Promise<boolean> {
  return await adminAnswers(ctx, userId, conversation) && !(await ctx.db.get(conversation.user_id))?.is_bot;
}

export function personName(user: any): string {
  return user?.name || user?.github_username || user?.email?.split("@")[0] || "a teammate";
}

/** The owner attending this session right now, or null when none is. */
export async function attendingOwner(ctx: Ctx, conversation: Doc<"conversations">, now: number): Promise<Id<"users"> | null> {
  const rows = await ctx.db
    .query("user_presence")
    .withIndex("by_viewing_conversation", (q: any) => q.eq("viewing_conversation_id", conversation._id))
    .take(50);
  if (rows.length === 0) return null;
  const owners = answerers(conversation);
  for (const row of rows) {
    if (!owners.has(String(row.user_id))) continue;
    // A view outlives the window that named it (a hidden or closed tab stops
    // reporting without clearing it): trust it only off a live row, the rule
    // the roster uses (teams.getTeamMembers), so both sides agree.
    if (now - row.last_seen >= PRESENCE_FRESH_MS) continue;
    const user = await ctx.db.get(row.user_id);
    if (!user || user.is_bot) continue;
    const machineWide = user.machine_wide_presence ?? true;
    const devices = machineWide
      ? await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", row.user_id)).collect()
      : [];
    const state = derivePresenceState({ presence: row, devices, machineWide, daemonLastSeen: user.daemon_last_seen }, now);
    if (state === "active") return row.user_id;
  }
  return null;
}

/** Whom a teammate's words go to as a suggestion, or null to send them straight in. */
export async function steeringOwnerFor(ctx: Ctx, conversation: Doc<"conversations">, senderId: Id<"users">, now: number): Promise<Id<"users"> | null> {
  if ((conversation as any).standing_role_id || isHostedAgentType((conversation as any).agent_type)) return null;
  // Teammates only: an owner's words are their own, and a share link's
  // grantee sees no roster to tell them the owner is here.
  if ((await checkConversationAccess(ctx, senderId, conversation)) !== "team") return null;
  // An admin of the session's team outranks its owner there.
  if (await adminOfSessionTeam(ctx, senderId, conversation)) return null;
  // The composer reads the active team's roster to say "Suggest"; from any
  // other team it cannot see the owner, so it sends directly, as the server does.
  const sender = await ctx.db.get(senderId);
  if (!conversation.team_id || String(sender?.active_team_id ?? "") !== String(conversation.team_id)) return null;
  return await attendingOwner(ctx, conversation, now);
}

async function pendingByAuthor(ctx: Ctx, authorId: Id<"users">, conversationId: Id<"conversations">): Promise<any[]> {
  const rows = await ctx.db
    .query("guest_suggestions")
    .withIndex("by_author_conversation", (q: any) => q.eq("author_user_id", authorId).eq("conversation_id", conversationId))
    .order("desc")
    .take(200);
  const now = Date.now();
  return rows.filter((r: any) => liveSuggestion(r, now));
}

/** Park a teammate's message for the attending owner. */
export async function suggestFromTeammate(
  ctx: Ctx,
  conversation: Doc<"conversations">,
  author: Doc<"users">,
  ownerId: Id<"users">,
  body: string,
  queued = false,
): Promise<Id<"guest_suggestions">> {
  const text = body.trim();
  if (!text) throw new Error("Write a message first");
  if (text.length > TEAM_SUGGESTION_MAX_CHARS) throw new Error(`Keep it under ${TEAM_SUGGESTION_MAX_CHARS} characters`);
  // A joint turn names other people's words, vouched against their live
  // drafts at send time; parked for later it could no longer be.
  if (parseJointMessage(text)) throw new Error("Send together isn't available while the owner is in the session");
  const waiting = (await pendingByAuthor(ctx, author._id, conversation._id)).filter((r) => !r.kind);
  if (waiting.length >= TEAM_PENDING_MAX) {
    throw new Error(`You have ${TEAM_PENDING_MAX} suggestions waiting here. Wait for the owner to get to them.`);
  }
  return await ctx.db.insert("guest_suggestions", {
    conversation_id: conversation._id,
    author_user_id: author._id,
    guest_name: personName(author),
    owner_user_id: ownerId,
    body: text,
    status: "pending",
    created_at: Date.now(),
    ...(queued ? { queued: true } : {}),
  });
}

// `answers`: who presses the real card, refused as a proposer. Questions are
// answered by the runner and the primary owner (their answer is a message);
// permission prompts by the runner alone (permissions.updatePermissionStatus).
// `adminAnswersIt`: whether an admin of the session's team answers this kind
// directly (adminAnswers for questions, adminAnswersPrompts for prompts), so
// is refused as a proposer too.
async function proposerContext(
  ctx: Ctx,
  userId: Id<"users">,
  conversationId: string,
  answers: Set<string>,
  adminAnswersIt: (ctx: Ctx, userId: Id<"users">, conversation: Doc<"conversations">) => Promise<boolean>,
) {
  const id = ctx.db.normalizeId("conversations", conversationId);
  const conversation: Doc<"conversations"> | null = id ? await ctx.db.get(id) : null;
  if (!conversation) throw new Error("That session is gone");
  if (answers.has(String(userId))) throw new Error("You own this session: answer it directly");
  // Owners and teammates who read the session's detail; a share link's send
  // grant, or a summary-level share, does not reach its prompts.
  if (!(await viewerSeesDetail(ctx, userId, conversation))) throw new Error("You can't propose answers in this session");
  if (await adminAnswersIt(ctx, userId, conversation)) throw new Error("You're an admin of this team: answer it directly");
  const author = await ctx.db.get(userId);
  if (!author || author.is_bot) throw new Error("Only a person can propose an answer");
  // Proposals on questions or prompts that closed some other way still read
  // as pending in storage; they neither count toward the cap nor block.
  const live = await withoutEndedPrompts(ctx, await pendingByAuthor(ctx, userId, conversation._id));
  return { conversation, author, live };
}

type AskQuestion = { question?: string; options?: Array<{ label?: string }>; multiSelect?: boolean; multi_select?: boolean; isConfirmation?: boolean };

/** The questions of an AskUserQuestion call still waiting in this session's
 *  transcript, or null when there is no such call or it has its result. */
export async function openAskQuestion(ctx: Ctx, conversationId: Id<"conversations">, toolUseId: string): Promise<AskQuestion[] | null> {
  return (await openAsk(ctx, conversationId, toolUseId))?.questions ?? null;
}

/** The open question and when it was asked (the message's timestamp). */
export async function openAsk(ctx: Ctx, conversationId: Id<"conversations">, toolUseId: string): Promise<{ questions: AskQuestion[]; askedAt: number } | null> {
  if (!toolUseId) return null;
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conversationId))
    .order("desc")
    .take(40);
  // The question closes with its own result, or with any later turn of the
  // person's (an Escape, a typed message): the agent reads nothing else while
  // it waits. Blocks the agent wrote around the question in the same turn
  // (parallel calls, text) do not close it.
  for (const m of recent) {
    if ((m.tool_results ?? []).some((r: any) => r.tool_use_id === toolUseId)) return null;
    const call = (m.tool_calls ?? []).find((c: any) => c.id === toolUseId);
    if (!call) {
      if (m.role === "user" && !(m.tool_results ?? []).length && (m.content ?? "").trim()) return null;
      continue;
    }
    if (!ASK_TOOLS.has(call.name)) return null;
    try {
      const input = JSON.parse(call.input);
      if (typeof input?.deniesAt === "number" && input.deniesAt <= Date.now()) return null;
      const questions = input?.questions;
      // Server time on both sides of the comparison in answerOnItsWay.
      return Array.isArray(questions) && questions.length > 0 ? { questions, askedAt: m._creationTime ?? 0 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

// shared/render toolKinds ASK_TOOL_IDS: the question tool in every harness.
const ASK_TOOLS = new Set(["AskUserQuestion", "ask_user_question"]);

const optionLabel = (label: string | undefined) => (label ?? "").replace(" (Recommended)", "").trim();

/** The answer a card would send for these questions, rebuilt from the keys
 *  it presses (or the prose it types) so what the owner sees is what goes
 *  in: the display is derived here, never taken from the proposer. Null for
 *  anything a question card does not send. */
export function canonicalAnswer(body: string, questions: AskQuestion[]): { body: string; display: string } | null {
  let p: any;
  try { p = JSON.parse(body); } catch { return null; }
  if (!p || p.__cc_poll !== true || p.steps !== undefined) return null;
  if (typeof p.text === "string" && p.keys === undefined) {
    const text = p.text.trim();
    // Typed at the agent's prompt, a leading ! or / is a shell or slash command.
    if (!text || text.length > PROSE_ANSWER_MAX_CHARS || /^[!/]/.test(text)) return null;
    return { body: JSON.stringify({ __cc_poll: true, text, display: text }), display: text };
  }
  if (!Array.isArray(p.keys) || p.keys.length === 0 || p.keys.length > 40) return null;
  const picked: string[][] = questions.map(() => []);
  let qi = 0;
  for (const key of p.keys) {
    if (typeof key !== "string") return null;
    const q = questions[qi];
    const multi = !!(q?.multiSelect ?? q?.multi_select);
    if (key === "Right") { if (!multi) return null; qi++; continue; }
    if (key === "Enter" && !q?.isConfirmation) { if (qi < questions.length) return null; continue; }
    if (!q) return null;
    let label: string | undefined;
    if (q.isConfirmation) label = key === "Enter" ? q.options?.[0]?.label : key === "Escape" ? q.options?.[1]?.label : undefined;
    else if (/^[1-9]$/.test(key)) label = q.options?.[Number(key) - 1]?.label;
    if (label === undefined) return null;
    // A second press of the same digit unticks it; a card never sends that.
    if (picked[qi].includes(optionLabel(label))) return null;
    picked[qi].push(optionLabel(label));
    if (!multi) qi++;
  }
  if (picked.some((labels) => labels.length === 0)) return null;
  const display = picked.map((labels) => labels.join(", ")).join(", ");
  const anyMulti = questions.some((q) => q.multiSelect ?? q.multi_select);
  return { body: JSON.stringify({ __cc_poll: true, keys: p.keys, display, ...(anyMulti ? { multi: true } : {}) }), display };
}

/** A teammate's answer to the agent's open question, for the owner to submit.
 *  One live proposal per author per question: a new pick replaces the old. */
export async function proposeAnswerFor(ctx: Ctx, userId: Id<"users">, conversationId: string, toolUseId: string, body: string, clientKey?: string) {
  const cid = ctx.db.normalizeId("conversations", conversationId);
  const target = cid ? await ctx.db.get(cid) : null;
  const { conversation, author, live } = await proposerContext(ctx, userId, conversationId, target ? answerers(target) : new Set(), adminAnswers);
  const ask = await openAsk(ctx, conversation._id, toolUseId);
  if (!ask || (await answerOnItsWay(ctx, conversation._id, ask.askedAt))) throw new Error("That question was already answered");
  const questions = ask.questions;
  const answer = canonicalAnswer(body, questions);
  if (!answer) {
    const prose = (() => { try { return JSON.parse(body)?.text; } catch { return undefined; } })();
    if (typeof prose === "string" && prose.trim().length > PROSE_ANSWER_MAX_CHARS) throw new Error(`Keep a proposed answer under ${PROSE_ANSWER_MAX_CHARS} characters`);
    if (typeof prose === "string" && /^[!/]/.test(prose.trim())) throw new Error("A proposed answer can't start with ! or /, which the agent's prompt runs as a command");
    throw new Error("That isn't an answer to this question");
  }
  const rest = [];
  for (const row of live) {
    if (row.kind === "answer" && row.tool_use_id === toolUseId) await ctx.db.patch(row._id, { status: "withdrawn", decided_at: Date.now() });
    else if (row.kind) rest.push(row);
  }
  if (rest.length >= TEAM_PROPOSALS_MAX) throw new Error("You have too many proposals waiting here");
  const id = await ctx.db.insert("guest_suggestions", {
    conversation_id: conversation._id,
    author_user_id: author._id,
    guest_name: personName(author),
    owner_user_id: (conversation.owner_user_id ?? conversation.user_id) as Id<"users">,
    kind: "answer",
    tool_use_id: toolUseId,
    body: answer.body,
    status: "pending",
    created_at: Date.now(),
    ...(typeof clientKey === "string" && clientKey.length <= 64 ? { client_key: clientKey } : {}),
  });
  return { suggestion_id: id };
}

/** A teammate's approve or deny on a pending permission, for the owner to press. */
export async function proposePermissionFor(ctx: Ctx, userId: Id<"users">, permissionId: string, decision: "approved" | "denied", clientKey?: string) {
  const pid = ctx.db.normalizeId("pending_permissions", permissionId);
  const permission = pid ? await ctx.db.get(pid) : null;
  if (!permission || permission.status !== "pending") throw new Error("That request was already answered");
  if (decision !== "approved" && decision !== "denied") throw new Error("Unknown answer");
  const owner = await ctx.db.get(permission.conversation_id);
  const { conversation, author, live } = await proposerContext(ctx, userId, String(permission.conversation_id), new Set(owner ? [String(owner.user_id)] : []), adminAnswersPrompts);
  const rest = [];
  for (const row of live) {
    if (row.kind === "permission" && String(row.permission_id) === String(permission._id)) {
      await ctx.db.patch(row._id, { status: "withdrawn", decided_at: Date.now() });
    } else if (row.kind) rest.push(row);
  }
  if (rest.length >= TEAM_PROPOSALS_MAX) throw new Error("You have too many proposals waiting here");
  const id = await ctx.db.insert("guest_suggestions", {
    conversation_id: conversation._id,
    author_user_id: author._id,
    guest_name: personName(author),
    owner_user_id: (conversation.owner_user_id ?? conversation.user_id) as Id<"users">,
    kind: "permission",
    permission_id: permission._id,
    decision,
    body: `${decision === "approved" ? "Allow" : "Deny"} ${permission.tool_name}`,
    status: "pending",
    created_at: Date.now(),
    ...(typeof clientKey === "string" && clientKey.length <= 64 ? { client_key: clientKey } : {}),
  });
  return { suggestion_id: id };
}

/** The owner answered (or the agent dropped) a permission: settle the
 *  proposals on it. A matching proposal reads as sent, a contrary one as
 *  dismissed; a request that went away takes its proposals with it. */
export async function settlePermissionProposals(
  ctx: Ctx,
  permission: Doc<"pending_permissions">,
  outcome: "approved" | "denied" | "cancelled",
) {
  const rows = await ctx.db
    .query("guest_suggestions")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", permission.conversation_id).eq("status", "pending"))
    .take(100);
  const now = Date.now();
  for (const row of rows) {
    if (row.kind !== "permission" || String(row.permission_id) !== String(permission._id)) continue;
    const status = outcome === "cancelled" ? "closed" : row.decision === outcome ? "sent" : "dismissed";
    await ctx.db.patch(row._id, { status, decided_at: now });
  }
}

/** The author's own row by its id, or by the client key of the copy their
 *  store painted before the server answered (a withdraw can beat the echo). */
async function authoredRow(ctx: Ctx, userId: Id<"users">, suggestionId: string, conversationId?: string): Promise<any | null> {
  const id = ctx.db.normalizeId("guest_suggestions", suggestionId);
  if (id) return await ctx.db.get(id);
  const conv = conversationId ? ctx.db.normalizeId("conversations", conversationId) : null;
  if (!conv) return null;
  const rows = await ctx.db
    .query("guest_suggestions")
    .withIndex("by_author_conversation", (q: any) => q.eq("author_user_id", userId).eq("conversation_id", conv))
    .order("desc")
    .take(200);
  return rows.find((r: any) => r.client_key === suggestionId) ?? null;
}

/** The author takes back a suggestion the owner has not decided yet. */
export async function withdrawTeamSuggestionFor(ctx: Ctx, userId: Id<"users">, suggestionId: string, conversationId?: string) {
  const row = await authoredRow(ctx, userId, suggestionId, conversationId);
  if (!row || String(row.author_user_id) !== String(userId)) return { status: "gone" };
  if (row.status !== "pending") return { status: row.status };
  await ctx.db.patch(row._id, { status: "withdrawn", decided_at: Date.now() });
  return { status: "withdrawn" };
}

/** The viewer's own recent suggestions in one session, oldest first, with
 *  what became of each. */
export const listMine = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const id = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!id) return [];
    // Withdrawn rows (every re-pick makes one) never crowd a waiting one out.
    const rows = (await ctx.db
      .query("guest_suggestions")
      .withIndex("by_author_conversation", (q: any) => q.eq("author_user_id", userId).eq("conversation_id", id))
      .order("desc")
      .take(500))
      .filter((r: any) => r.status !== "withdrawn")
      .filter((r: any, i: number) => i < MINE_HISTORY || r.status === "pending");
    const now = Date.now();
    const open = new Map<string, boolean>();
    const shown = [];
    for (const r of rows) {
      if (r.status === "withdrawn" || (r.status === "pending" && !liveSuggestion(r, now))) continue;
      // Answered some other way: the author sees that it closed, not a row
      // that vanished or one that waits forever.
      shown.push(await proposalOpen(ctx, r, open) ? r : { ...r, status: "closed" });
    }
    return shown
      .reverse()
      .map((r: any) => ({
        _id: r._id,
        conversation_id: r.conversation_id,
        author_user_id: r.author_user_id,
        guest_name: r.guest_name,
        kind: r.kind ?? null,
        tool_use_id: r.tool_use_id ?? null,
        permission_id: r.permission_id ?? null,
        decision: r.decision ?? null,
        body: r.sent_body ?? r.body,
        edited: !!r.sent_body,
        status: r.status,
        created_at: r.created_at,
        decided_at: r.decided_at ?? null,
        ...(r.client_key ? { client_key: r.client_key } : {}),
      }));
  },
});

/** The owner left with my message still waiting: take it back and send it
 *  the ordinary way, in one step, so it can never go in twice. If an owner
 *  is back in the session by now it waits again as a new suggestion. */
export async function sendMineNowFor(ctx: Ctx, userId: Id<"users">, suggestionId: string, conversationId?: string) {
  const row = await authoredRow(ctx, userId, suggestionId, conversationId);
  if (!row || String(row.author_user_id) !== String(userId) || row.kind) return { status: "gone", suggested: false };
  if (row.status !== "pending") return { status: row.status, suggested: false };
  await ctx.db.patch(row._id, { status: "withdrawn", decided_at: Date.now() });
  const res = await performSessionSend(ctx, userId, { to: String(row.conversation_id), body: row.body, direct: true, ...(row.queued ? { queue: true } : {}) });
  return { status: "withdrawn", suggested: !!res.suggestion_id };
}
