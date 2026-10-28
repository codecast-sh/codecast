// A decision's team thread (ct-74449): comments on a session decision are
// review_comments rows anchored by `decision_id`, with parent_id replies.
//
// Who writes: people (web, phone, `cast decide comment`), the sessions they
// ask, and the hand-offs (a pass or an escalation leaves an entry naming who
// it went to, with its note).
//
// Comments are for people. A session hears the thread only when someone asks
// it: the thread's Ask button (the decision's own session, decisionOwner: the
// asker, else the run's starter, the project's lead, the workspace agent), or
// an @mention of a session or a role. Asking writes an agent placeholder
// ("thinking") and sends the session the thread since it last answered as a
// <decision-discussion> message; what it says back fills the placeholder,
// growing with its turn (relayDecisionReply, called as each assistant
// message lands), until someone else speaks to it.
//
// The rows stay out of every other reader of review_comments: never
// conversation_id, never source_comment_id, never origin "quote" or
// pending_review. The workspace key is written at create time.
//
// Notified: the decision's owner, the thread's people and anyone @mentioned
// who may read the decision, never the author. A person whose thread is
// already unread is not notified again: one notice per batch of news.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { findDecision, userMayRead } from "./lib/decisionAccess";
import { canAccessConversation, computeWorkspaceKey } from "./lib/access";
import { verifyApiToken } from "./apiTokens";
import { decisionOwner, ownerName, DISCUSSION_MAX_CHARS } from "./decisionDiscussion";
import { canSendProductMessage, enqueuePendingMessage, reachableRole } from "./pendingMessages";
import { emitNotification } from "./notificationRouter";
import { resolveChatMentions, resolveSessionMentions } from "./lib/mentionResolve";
import { touchThread } from "./threadReads";
import { UNREAD_CAP } from "./chatText";
import { resolveActor } from "./lib/actor";
import { lineFenceHint } from "@codecast/shared/contracts/lineChat";
import { formatDecisionDiscussion, isToolResultCarrier, parseDecisionDiscussion } from "@codecast/shared/contracts";

type Ctx = { db: any; scheduler?: any };
type DecisionRow = Doc<"session_decisions">;
type CommentRow = Doc<"review_comments">;

/** The most rows one thread reads: a conversation about one question. */
export const DECISION_THREAD_MAX_ROWS = 500;
/** A session asked and silent this long stops being waited on. */
const REPLY_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
/** How many comments one ask carries to the session. */
const ASK_CONTEXT_ROWS = 20;

/** The thread_reads root key: distinct from the comment kind's `${conversation_id}:...`. */
export const decisionRootKey = (decisionId: Id<"session_decisions"> | string) => `decision:${decisionId}`;

export async function decisionThreadRows(ctx: Ctx, decisionId: Id<"session_decisions">): Promise<CommentRow[]> {
  return await ctx.db
    .query("review_comments")
    .withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId))
    .order("asc")
    .take(DECISION_THREAD_MAX_ROWS);
}

/** The team a decision routes to: its asking session's, else its problem's. */
async function decisionTeam(ctx: Ctx, row: DecisionRow): Promise<Id<"teams"> | undefined> {
  const conversation = await ctx.db.get(row.conversation_id);
  if (conversation?.team_id) return conversation.team_id;
  const task = row.task_id ? await ctx.db.get(row.task_id) : null;
  return task?.team_id;
}

/** The people expected to answer it: the person holding it, else the people it was asked of. */
export function decisionOwnerPeople(row: Pick<DecisionRow, "holder" | "asked_user_ids" | "user_id">): Id<"users">[] {
  if (row.holder?.kind === "user") return [row.holder.id as Id<"users">];
  return row.asked_user_ids?.length ? row.asked_user_ids : [row.user_id];
}

/** Every row of a decision's thread shares the decision's workspace, computed the way the decision's own is. */
async function workspaceFor(ctx: Ctx, row: DecisionRow): Promise<string> {
  const conversation = await ctx.db.get(row.conversation_id);
  return computeWorkspaceKey({ user_id: conversation?.user_id ?? row.user_id, team_id: await decisionTeam(ctx, row) }, conversation);
}

type EntryFields = Partial<Omit<CommentRow, "_id" | "_creationTime">> & { content: string; client_id: string; created_at: number };

async function insertEntry(ctx: Ctx, row: DecisionRow, fields: EntryFields): Promise<CommentRow> {
  const id = await ctx.db.insert("review_comments", {
    decision_id: row._id,
    resolved: false,
    workspace: await workspaceFor(ctx, row),
    ...fields,
  });
  return (await ctx.db.get(id))!;
}

/**
 * A comment landed: file the thread for everyone it concerns and notify them
 * once. `actorId` is the person who wrote it; an agent's comment has none, so
 * nobody is excluded as its author. `mentioned` are people named in it.
 */
async function fanOut(ctx: Ctx, row: DecisionRow, comment: CommentRow, actorId: Id<"users"> | undefined, actorName: string, mentioned: Id<"users">[] = []): Promise<void> {
  const teamId = await decisionTeam(ctx, row);
  const thread = await decisionThreadRows(ctx, row._id);
  const people = thread.filter((c) => c.author_kind !== "agent" && c.author_user_id).map((c) => c.author_user_id!);
  const mentionSet = new Set(mentioned.map(String));
  const candidates = [...decisionOwnerPeople(row), ...people, ...mentioned];
  const readers: Id<"users">[] = [];
  const seen = new Set<string>(actorId ? [String(actorId)] : []);
  for (const id of candidates) {
    if (seen.has(String(id))) continue;
    seen.add(String(id));
    const user = await ctx.db.get(id);
    if (!user || user.is_bot || !(await userMayRead(ctx, id, row))) continue;
    readers.push(id);
  }
  const rootKey = decisionRootKey(row._id);
  // Unread before this comment: they already have a notice waiting for this thread.
  const alreadyUnread = new Set<string>();
  for (const id of readers) {
    const read = await ctx.db
      .query("thread_reads")
      .withIndex("by_user_kind_root", (q: any) => q.eq("user_id", id).eq("kind", "decision").eq("root_key", rootKey))
      .first();
    if (read && read.last_activity_at > read.last_read_at) alreadyUnread.add(String(id));
  }
  await touchThread(ctx as MutationCtx, {
    kind: "decision",
    rootKey,
    teamId,
    refs: { decision_id: row._id },
    participants: readers,
    actorId,
    activityAt: comment.created_at,
  });
  const question = row.question.length > 100 ? `${row.question.slice(0, 97)}...` : row.question;
  const words = comment.content.length > 140 ? `${comment.content.slice(0, 137)}...` : comment.content;
  for (const id of readers) {
    const mention = mentionSet.has(String(id));
    if (!mention && alreadyUnread.has(String(id))) continue;
    await emitNotification(ctx as any, {
      event_type: mention ? "mention" : "decision_comment",
      ...(actorId ? { actor_user_id: actorId } : { actor_name: actorName }),
      entity_type: "conversation",
      entity_id: String(row.conversation_id),
      conversation_id: row.conversation_id,
      message: `on "${question}": ${words}`,
      ...(row.short_id ? { link: `/decisions/${row.short_id}` } : {}),
      recipient_ids: [id],
    });
  }
}

/** A decision a line run asked on a project's cause: the reply can draw the line's widgets. */
async function lineWidgetsNote(ctx: Ctx, row: DecisionRow): Promise<string | null> {
  if (!row.workflow_run_id) return null;
  const run = await ctx.db.get(row.workflow_run_id);
  const taskId = row.task_id ?? run?.task_id;
  const task = taskId ? await ctx.db.get(taskId) : null;
  const project = task?.project_id ? await ctx.db.get(task.project_id) : null;
  return project ? lineFenceHint(project.short_id ?? String(project._id)) : null;
}

async function personName(ctx: Ctx, cache: Map<string, string>, id: string): Promise<string> {
  if (!cache.has(id)) {
    const u = ctx.db.normalizeId("users", id) ? await ctx.db.get(id) : null;
    cache.set(id, u?.name || u?.email?.split("@")[0] || "Someone");
  }
  return cache.get(id)!;
}

/**
 * Ask one session about the thread: an agent placeholder it will fill, and
 * the comments since it last answered, as one message. Idempotent on the
 * client id. The placeholder says so when the session cannot be reached.
 */
async function askSession(ctx: Ctx, row: DecisionRow, userId: Id<"users">, session: Doc<"conversations"> | null, clientId: string): Promise<CommentRow> {
  const thread = await decisionThreadRows(ctx, row._id);
  const again = thread.find((c) => c.client_id === clientId);
  if (again) return again;
  const now = Date.now();
  if (!session) {
    return insertEntry(ctx, row, { content: `${row.short_id ?? "This decision"} has no session to ask`, client_id: clientId, author_kind: "agent", agent_status: "error", created_at: now });
  }
  const lastAnswer = thread.filter((c) => c.author_kind === "agent" && String(c.decision_session_id) === String(session._id) && c.content).reduce((n, c) => Math.max(n, c.created_at), 0);
  const names = new Map<string, string>();
  const lines: string[] = [];
  for (const c of thread.filter((c) => c.author_kind !== "agent" && !c.decision_event && c.created_at > lastAnswer).slice(-ASK_CONTEXT_ROWS)) {
    lines.push(`${await personName(ctx, names, String(c.author_user_id ?? ""))}: ${c.content}`);
  }
  const from = (await resolveActor(ctx as any, userId, null)).name ?? "A person";
  const placeholder = await insertEntry(ctx, row, {
    content: "",
    client_id: clientId,
    author_kind: "agent",
    agent_status: "thinking",
    decision_session_id: session._id,
    decision_waiting: true,
    created_at: now,
  });
  try {
    await enqueuePendingMessage(ctx, session, userId, {
      content: formatDecisionDiscussion({ decision: row.short_id ?? String(row._id), question: row.question, from, body: lines.join("\n\n") || `${from} asks you about this decision.`, note: await lineWidgetsNote(ctx, row) }),
      client_id: clientId,
      human: true,
    });
  } catch (error) {
    await ctx.db.patch(placeholder._id, { agent_status: "error", decision_waiting: undefined, content: `Could not reach the session: ${error instanceof Error ? error.message : String(error)}` });
  }
  return (await ctx.db.get(placeholder._id))!;
}

/** The session the thread's Ask button reaches, and the people a comment's @mentions name. */
async function mentionsIn(ctx: Ctx, row: DecisionRow, userId: Id<"users">, content: string): Promise<{ users: Id<"users">[]; sessions: Doc<"conversations">[] }> {
  const teamId = await decisionTeam(ctx, row);
  const named = teamId ? await resolveChatMentions(ctx as any, teamId, content, userId) : { users: [], roles: [], sessions: [] };
  const sessions = new Map<string, Doc<"conversations">>();
  for (const c of named.sessions) sessions.set(String(c._id), c);
  for (const c of await resolveSessionMentions(ctx as any, content, (conv) => canSendProductMessage(ctx, userId, conv))) sessions.set(String(c._id), c);
  // A role is asked through its standing session.
  for (const role of named.roles) {
    const standing = (await reachableRole(ctx, role._id))?.standing;
    if (standing && !standing.inbox_killed_at) sessions.set(String(standing._id), standing);
  }
  return { users: named.users, sessions: [...sessions.values()] };
}

export type CommentArgs = {
  decision: string;
  text: string;
  client_id: string;
  /** The comment this one answers; replies hang under the thread's root. */
  parent_id?: string;
  /** The session writing it (`cast decide comment` inside a session): when it
   *  was asked here, or is the decision's own, the comment is the session's. */
  session_id?: string;
};

type CommentResult = { ok: true; comment_id: Id<"review_comments">; short_id?: string; asked: string[] } | { error: string };

async function openThread(ctx: Ctx, userId: Id<"users">, decision: string): Promise<DecisionRow | null> {
  const row: DecisionRow | null = await findDecision(ctx, decision);
  return row && (await userMayRead(ctx, userId, row)) ? row : null;
}

/**
 * A comment on a decision. Whoever may read the decision may comment on it.
 * Sessions and roles it @mentions are asked. Idempotent on (author, client
 * id), so the outbox can redeliver.
 */
export async function commentCore(ctx: Ctx, userId: Id<"users">, args: CommentArgs): Promise<CommentResult> {
  const row = await openThread(ctx, userId, args.decision);
  if (!row) return { error: "Decision not found" };
  const text = (args.text ?? "").trim();
  if (!text) return { error: "The comment is empty" };
  if (text.length > DISCUSSION_MAX_CHARS) return { error: `A comment on a decision can be at most ${DISCUSSION_MAX_CHARS.toLocaleString("en-US")} characters` };
  const again = await ctx.db
    .query("review_comments")
    .withIndex("by_author_client_id", (q: any) => q.eq("author_user_id", userId).eq("client_id", args.client_id))
    .first();
  if (again && String(again.decision_id) === String(row._id)) return { ok: true, comment_id: again._id, short_id: row.short_id, asked: [] };

  let parentId: Id<"review_comments"> | undefined;
  if (args.parent_id) {
    const parent = ctx.db.normalizeId("review_comments", args.parent_id) ? await ctx.db.get(args.parent_id as Id<"review_comments">) : null;
    if (!parent || String(parent.decision_id) !== String(row._id)) return { error: "That comment is not on this decision" };
    parentId = parent.parent_id ?? parent._id;
  }
  const now = Date.now();

  // The session writing through the CLI: its words fill what it was asked, else stand as its own comment.
  const sessionId = args.session_id ? ctx.db.normalizeId("conversations", args.session_id) : null;
  const sessionRow = sessionId ? await ctx.db.get(sessionId) : null;
  if (sessionRow && (await canAccessConversation(ctx as any, userId, sessionRow))) {
    const thread = await decisionThreadRows(ctx, row._id);
    const asked = thread.find((c) => c.decision_waiting && String(c.decision_session_id) === String(sessionRow._id));
    const owner = await decisionOwner(ctx, row);
    if (asked || String(sessionRow._id) === String(owner?.conversation._id) || String(sessionRow._id) === String(row.conversation_id)) {
      let comment: CommentRow;
      if (asked) {
        await ctx.db.patch(asked._id, { content: text, agent_status: "done", decision_waiting: undefined, updated_at: now });
        comment = (await ctx.db.get(asked._id))!;
      } else {
        comment = await insertEntry(ctx, row, { content: text, client_id: args.client_id, author_kind: "agent", author_user_id: userId, decision_session_id: sessionRow._id, created_at: now, ...(parentId ? { parent_id: parentId } : {}) });
      }
      await fanOut(ctx, row, comment, undefined, await ownerName(ctx, sessionRow));
      return { ok: true, comment_id: comment._id, short_id: row.short_id, asked: [] };
    }
  }

  const comment = await insertEntry(ctx, row, {
    content: text,
    client_id: args.client_id,
    author_kind: "user",
    author_user_id: userId,
    created_at: now,
    ...(parentId ? { parent_id: parentId } : {}),
  });
  const named = await mentionsIn(ctx, row, userId, text);
  const from = (await resolveActor(ctx as any, userId, null)).name ?? "A person";
  await fanOut(ctx, row, comment, userId, from, named.users);
  for (const session of named.sessions) await askSession(ctx, row, userId, session, `${args.client_id}:ask:${session._id}`);
  return { ok: true, comment_id: comment._id, short_id: row.short_id, asked: named.sessions.map((s) => String(s._id)) };
}

/** The thread's Ask button: the decision's own session answers the thread in it. */
export async function askCore(ctx: Ctx, userId: Id<"users">, args: { decision: string; client_id: string }): Promise<{ ok: true; comment_id: Id<"review_comments"> } | { error: string }> {
  const row = await openThread(ctx, userId, args.decision);
  if (!row) return { error: "Decision not found" };
  const owner = await decisionOwner(ctx, row);
  const placeholder = await askSession(ctx, row, userId, owner?.conversation ?? null, args.client_id);
  return { ok: true, comment_id: placeholder._id };
}

/** A person's own comment, by its id: never someone else's, an agent's or a hand-off entry. */
async function ownComment(ctx: Ctx, userId: Id<"users">, commentId: string): Promise<CommentRow | { error: string }> {
  const id = ctx.db.normalizeId("review_comments", commentId);
  const c: CommentRow | null = id ? await ctx.db.get(id) : null;
  if (!c?.decision_id) return { error: "Comment not found" };
  if (c.author_kind === "agent" || c.decision_event || String(c.author_user_id) !== String(userId)) return { error: "Only its author can change a comment" };
  return c;
}

export async function editCore(ctx: Ctx, userId: Id<"users">, args: { comment_id: string; text: string }): Promise<{ ok: true } | { error: string }> {
  const c = await ownComment(ctx, userId, args.comment_id);
  if ("error" in c) return c;
  const text = (args.text ?? "").trim();
  if (!text) return { error: "The comment is empty" };
  if (text.length > DISCUSSION_MAX_CHARS) return { error: `A comment on a decision can be at most ${DISCUSSION_MAX_CHARS.toLocaleString("en-US")} characters` };
  await ctx.db.patch(c._id, { content: text, updated_at: Date.now() });
  return { ok: true };
}

export async function deleteCore(ctx: Ctx, userId: Id<"users">, args: { comment_id: string }): Promise<{ ok: true } | { error: string }> {
  const c = await ownComment(ctx, userId, args.comment_id);
  if ("error" in c) return c;
  await ctx.db.delete(c._id);
  return { ok: true };
}

/** Resolve or reopen the thread: every row carries the stamp, so a comment after it reopens the thread. */
export async function resolveCore(ctx: Ctx, userId: Id<"users">, args: { decision: string; resolved: boolean }): Promise<{ ok: true } | { error: string }> {
  const row = await openThread(ctx, userId, args.decision);
  if (!row) return { error: "Decision not found" };
  const now = Date.now();
  for (const c of await decisionThreadRows(ctx, row._id)) {
    await ctx.db.patch(c._id, args.resolved ? { resolved: true, resolved_at: now, resolved_by: userId } : { resolved: false, resolved_at: undefined, resolved_by: undefined });
  }
  return { ok: true };
}

// ── The asked sessions' replies ──────────────────────────────────────────────

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The newest thing a person or a machine said to the session before `before`: tool results are the agent's own turn. */
async function lastAsk(ctx: Ctx, conversationId: Id<"conversations">, before: number): Promise<any | null> {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) => q.eq("conversation_id", conversationId).eq("role", "user").lt("timestamp", before))
    .order("desc")
    .take(25);
  return rows.find((m: any) => !isToolResultCarrier(m)) ?? null;
}

/** The delivered message is this ask: it keeps the pending message's client id, or (a tmux injection) carries the decision's frame. */
function isTheAsk(message: any, ask: CommentRow, decisionRef: string): boolean {
  if (ask.client_id && message.client_id === ask.client_id) return true;
  const said = typeof message.content === "string" ? parseDecisionDiscussion(message.content) : null;
  return !!said && said.decision === decisionRef && message.timestamp >= ask.created_at;
}

/**
 * Called as an assistant message lands: when the session is answering what
 * it was asked on a decision, its words fill (or grow) the placeholder.
 * One index read when nothing waits on the session, which is nearly always.
 */
export async function relayDecisionReply(
  ctx: Ctx,
  conversationId: Id<"conversations">,
  message: { _id: Id<"messages">; content?: string; timestamp: number; subtype?: string },
): Promise<void> {
  const text = message.content?.trim();
  if (!text || message.subtype) return;
  const waiting: CommentRow[] = await ctx.db
    .query("review_comments")
    .withIndex("by_decision_waiting", (q: any) => q.eq("decision_session_id", conversationId).eq("decision_waiting", true))
    .take(20);
  const candidates = waiting.filter((c) => c.created_at <= message.timestamp && c.decision_id);
  if (candidates.length === 0) return;
  const asked = await lastAsk(ctx, conversationId, message.timestamp);
  const now = Date.now();
  for (const ask of candidates) {
    const row: DecisionRow | null = await ctx.db.get(ask.decision_id!);
    if (!row) { await ctx.db.patch(ask._id, { decision_waiting: undefined }); continue; }
    if (!asked || !isTheAsk(asked, ask, row.short_id ?? String(row._id))) {
      // Someone else spoke to it since it answered, or it never did and the wait ran out: the reply is closed.
      if (ask.content || message.timestamp - ask.created_at > REPLY_WAIT_MS) {
        await ctx.db.patch(ask._id, { decision_waiting: undefined, ...(ask.content ? {} : { agent_status: "error", content: "No reply" }) });
      }
      continue;
    }
    if (ask.content === text) continue;
    const first = !ask.content;
    await ctx.db.patch(ask._id, { content: text, agent_status: "done", updated_at: now, ...(first ? { created_at: message.timestamp } : {}) });
    if (first) {
      const session = await ctx.db.get(conversationId);
      await fanOut(ctx, row, (await ctx.db.get(ask._id))!, undefined, session ? await ownerName(ctx, session) : "The session");
    }
  }
}

// ── Hand-offs ────────────────────────────────────────────────────────────────

/** A pass or an escalation, as an entry in the thread: who handed it to whom, with the note. */
export async function recordHandoffEntry(
  ctx: Ctx,
  row: DecisionRow,
  entry: { event: "passed" | "escalated"; by: Id<"users">; to: { kind: "user" | "role"; ids: string[] }; note?: string; at: number },
): Promise<void> {
  await insertEntry(ctx, row, {
    content: entry.note ?? "",
    client_id: `decision-${entry.event}:${row._id}:${entry.at}`,
    author_kind: "user",
    author_user_id: entry.by,
    decision_event: entry.event,
    decision_event_to: entry.to,
    created_at: entry.at,
  });
  const people = entry.to.kind === "user" ? (entry.to.ids as Id<"users">[]) : [];
  await touchThread(ctx as MutationCtx, {
    kind: "decision",
    rootKey: decisionRootKey(row._id),
    teamId: await decisionTeam(ctx, row),
    refs: { decision_id: row._id },
    participants: people,
    actorId: entry.by,
    activityAt: entry.at,
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One thread row as a surface draws it: the row, who wrote it, and whom a hand-off went to. */
export type DecisionComment = Pick<CommentRow, "_id" | "content" | "client_id" | "created_at" | "parent_id" | "author_kind" | "agent_status" | "decision_event" | "decision_waiting" | "resolved_at"> & {
  decision_id: string;
  decision_session_id?: string;
  author_user_id?: string;
  updated_at?: number;
  author_name: string;
  event_to_names?: string[];
};

export async function decisionCommentViews(ctx: Ctx, rows: CommentRow[]): Promise<DecisionComment[]> {
  const names = new Map<string, string>();
  const sessions = new Map<string, string>();
  const out: DecisionComment[] = [];
  for (const c of rows) {
    let author_name: string;
    if (c.author_kind === "agent") {
      const key = String(c.decision_session_id ?? "");
      if (!sessions.has(key)) {
        const conv = c.decision_session_id ? await ctx.db.get(c.decision_session_id) : null;
        sessions.set(key, conv ? await ownerName(ctx, conv) : "The session");
      }
      author_name = sessions.get(key)!;
    } else {
      author_name = c.author_user_id ? await personName(ctx, names, String(c.author_user_id)) : "Someone";
    }
    let event_to_names: string[] | undefined;
    if (c.decision_event_to) {
      event_to_names = [];
      for (const id of c.decision_event_to.ids) {
        if (c.decision_event_to.kind === "user") event_to_names.push(await personName(ctx, names, id));
        else {
          const role = ctx.db.normalizeId("org_roles", id) ? await ctx.db.get(id) : null;
          event_to_names.push(role?.name ?? "a role");
        }
      }
    }
    out.push({
      _id: c._id,
      decision_id: String(c.decision_id),
      content: c.content,
      client_id: c.client_id,
      created_at: c.created_at,
      parent_id: c.parent_id,
      author_kind: c.author_kind,
      ...(c.author_user_id ? { author_user_id: String(c.author_user_id) } : {}),
      ...(c.updated_at ? { updated_at: c.updated_at } : {}),
      ...(c.decision_event ? { decision_event: c.decision_event } : {}),
      ...(c.decision_waiting ? { decision_waiting: true } : {}),
      ...(c.agent_status ? { agent_status: c.agent_status } : {}),
      ...(c.resolved_at ? { resolved_at: c.resolved_at } : {}),
      ...(c.decision_session_id ? { decision_session_id: String(c.decision_session_id) } : {}),
      author_name,
      ...(event_to_names ? { event_to_names } : {}),
    });
  }
  return out;
}

/** Comments past the mark that someone else wrote. */
export function unreadIn(rows: Pick<CommentRow, "created_at" | "author_user_id" | "author_kind">[], userId: Id<"users"> | string, lastReadAt: number): number {
  return rows.filter((c) => c.created_at > lastReadAt && (c.author_kind === "agent" || String(c.author_user_id ?? "") !== String(userId))).length;
}

/** The viewer's thread_reads row as a Threads entry (convex threads.ts ThreadInboxEntry). */
export function decisionInboxEntry(read: Doc<"thread_reads">, unread: number, title: string) {
  return {
    _id: `decision:${read.root_key}`,
    kind: "decision" as const,
    root_key: read.root_key,
    team_id: read.team_id,
    decision_id: read.decision_id,
    title,
    last_activity_at: read.last_activity_at,
    last_read_at: read.last_read_at,
    updated_at: read.updated_at,
    unread,
  };
}

/**
 * One decision's thread, for its surfaces: who the thread talks to (resolved
 * now, so the box names it before anything was said), every entry oldest
 * first, and the viewer's read mark. Null when the viewer may not read it.
 */
export const thread = query({
  args: { decision_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row: DecisionRow | null = await findDecision(ctx, args.decision_id);
    if (!row || !(await userMayRead(ctx, userId, row))) return null;
    const owner = await decisionOwner(ctx, row);
    const rows = await decisionThreadRows(ctx, row._id);
    const read = await ctx.db
      .query("thread_reads")
      .withIndex("by_user_kind_root", (q: any) => q.eq("user_id", userId).eq("kind", "decision").eq("root_key", decisionRootKey(row._id)))
      .first();
    return {
      _id: row._id,
      decision_short_id: row.short_id,
      owner: owner
        ? { conversation_id: owner.conversation._id, short_id: owner.conversation.short_id, name: await ownerName(ctx, owner.conversation), via: owner.via }
        : null,
      comments: await decisionCommentViews(ctx, rows),
      read: read ? decisionInboxEntry(read, unreadIn(rows, userId, read.last_read_at), row.question) : null,
    };
  },
});

/** How many of the viewer's decision threads one read covers: the newest by activity. */
const MY_THREADS = 60;

/**
 * The viewer's decision threads, newest activity first, each with its unread
 * count: what a decision's row reads to show it has news. App-wide.
 */
export const myThreads = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const reads = await ctx.db
      .query("thread_reads")
      .withIndex("by_user_kind_root", (q: any) => q.eq("user_id", userId).eq("kind", "decision"))
      .take(400);
    reads.sort((a, b) => b.last_activity_at - a.last_activity_at);
    const out = [];
    for (const read of reads.slice(0, MY_THREADS)) {
      const row: DecisionRow | null = read.decision_id ? await ctx.db.get(read.decision_id) : null;
      if (!row || !(await userMayRead(ctx, userId, row))) continue;
      const unread = read.last_activity_at > read.last_read_at ? unreadIn(await decisionThreadRows(ctx, row._id), userId, read.last_read_at) : 0;
      out.push(decisionInboxEntry(read, unread, row.question));
    }
    return out;
  },
});

// ── CLI: `cast decide comment <sd-N> "..."` ──────────────────────────────────

export const commentForCli = mutation({
  args: { api_token: v.string(), decision_id: v.string(), text: v.string(), client_id: v.optional(v.string()), parent_id: v.optional(v.string()), session_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    // The CLI names its session by the agent's session id.
    const session = args.session_id
      ? ctx.db.normalizeId("conversations", args.session_id) ?? (await ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id)).first())?._id
      : undefined;
    return commentCore(ctx, auth.userId, {
      decision: args.decision_id,
      text: args.text,
      client_id: args.client_id ?? `decision-thread:cli:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      ...(args.parent_id ? { parent_id: args.parent_id } : {}),
      ...(session ? { session_id: String(session) } : {}),
    });
  },
});

// ── The Threads page (threads.ts THREAD_KINDS) ───────────────────────────────

type ThreadReadRow = Doc<"thread_reads">;
/** Per page memo, keyed by the page's own cache object. */
const pageRows = new WeakMap<object, Map<string, { row: DecisionRow | null; comments: CommentRow[] }>>();

async function threadOf(ctx: Ctx, read: ThreadReadRow, cache: object) {
  let memo = pageRows.get(cache);
  if (!memo) pageRows.set(cache, (memo = new Map()));
  const key = String(read.decision_id ?? read.root_key);
  if (!memo.has(key)) {
    const row: DecisionRow | null = read.decision_id ? await ctx.db.get(read.decision_id) : null;
    memo.set(key, { row, comments: row ? await decisionThreadRows(ctx, row._id) : [] });
  }
  return memo.get(key)!;
}

export const decisionThreadKind = {
  async access(ctx: Ctx, userId: Id<"users">, read: ThreadReadRow, cache: object) {
    const { row } = await threadOf(ctx, read, cache);
    return !!row && (await userMayRead(ctx, userId, row));
  },
  async unread(ctx: Ctx, userId: Id<"users">, read: ThreadReadRow, cache: object) {
    const counted = unreadIn((await threadOf(ctx, read, cache)).comments, userId, read.last_read_at);
    return { unread: Math.min(counted, UNREAD_CAP), unread_capped: counted > UNREAD_CAP };
  },
  async newestAt(ctx: Ctx, read: ThreadReadRow, cache: object) {
    const { comments } = await threadOf(ctx, read, cache);
    return comments.reduce((n, c) => Math.max(n, c.created_at), 0);
  },
  async load() {},
  async preview(ctx: Ctx, _userId: Id<"users">, read: ThreadReadRow, cache: object) {
    const { comments } = await threadOf(ctx, read, cache);
    const newest = comments[comments.length - 1];
    if (!newest) return null;
    const [view] = await decisionCommentViews(ctx, [newest]);
    return {
      _id: String(newest._id),
      user_id: newest.author_user_id ? String(newest.author_user_id) : undefined,
      author_kind: newest.author_kind === "agent" ? ("agent" as const) : ("user" as const),
      author_name: view.author_name,
      created_at: newest.created_at,
      preview: (newest.decision_event ? `${newest.decision_event === "escalated" ? "Escalated" : "Passed"} to ${(view.event_to_names ?? []).join(", ")}${newest.content ? `: ${newest.content}` : ""}` : newest.content).slice(0, 160),
    };
  },
  async title(ctx: Ctx, read: ThreadReadRow, cache: object) {
    return (await threadOf(ctx, read, cache)).row?.question;
  },
};
