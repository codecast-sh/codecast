// A task has one owning session: the conversation whose active_task_id points
// at it. `cast task start`, the board's "assign to agent", a task-linked
// session create and a handoff all bind through claimTaskOwnership, so the
// binding moves instead of piling up.
//
// The one fact lives on the conversation (active_task_id). Ownership is read
// from it (the by_active_task index), so a task never stores a second copy that
// could disagree with the binding.

import type { Id } from "../_generated/dataModel";
import { HEARTBEAT_ALIVE_MS } from "../inboxFilters";
import { isHandoffComment } from "./runAgentSessions";

// A session that touched the conversation this recently is treated as working
// even without a daemon heartbeat (a cloud agent, a session between turns).
const RECENT_ACTIVITY_MS = 15 * 60 * 1000;

export interface TaskOwnerRef {
  conversation_id: Id<"conversations">;
  short_id: string;
  title: string | null;
  live: boolean;
  updated_at: number;
}

/** Sessions bound to `task` (active_task_id), newest first. A session started
 *  to review the task judges the work and never owns it. */
export async function boundSessionsOf(ctx: { db: any }, task: any): Promise<any[]> {
  const bound = await ctx.db.query("conversations").withIndex("by_active_task", (q: any) => q.eq("active_task_id", task._id)).collect();
  return bound
    .filter((conv: any) => String(conv.review_of_task_id ?? "") !== String(task._id))
    .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

type TaskComment = { conversation_id?: Id<"conversations">; comment_type: string; text: string; created_at: number };

/** Sessions that handed `task` off (a HANDOFF_COMMENT review comment among `comments`), newest handoff first, each
 *  once. A session reviewing the task is none of them. */
export async function handoffSessionsOf(ctx: { db: any }, task: any, comments: TaskComment[]): Promise<any[]> {
  const handoffs = comments
    .filter(isHandoffComment)
    .sort((a, b) => b.created_at - a.created_at);
  const out: any[] = [];
  const seen = new Set<string>();
  for (const h of handoffs) {
    if (seen.has(String(h.conversation_id))) continue;
    seen.add(String(h.conversation_id));
    const conv = await ctx.db.get(h.conversation_id);
    if (conv && String(conv.review_of_task_id ?? "") !== String(task._id)) out.push(conv);
  }
  return out;
}

/** The session a change on `task` came from: the live session bound to it, else the newest live session that
 *  handed it off, since an implementer often moves to other work once it does. */
export async function changeSessionOf(ctx: { db: any }, task: any, comments: TaskComment[]): Promise<any | null> {
  const live = (c: any) => !c.inbox_killed_at;
  return (await boundSessionsOf(ctx, task)).find(live) ?? (await handoffSessionsOf(ctx, task, comments)).find(live) ?? null;
}

/** Is the session still doing work: a fresh daemon heartbeat, or recent
 *  activity on a row that is neither completed nor killed. */
export async function isSessionWorking(ctx: { db: any }, conv: any, now: number): Promise<boolean> {
  if (conv.status === "completed" || conv.inbox_killed_at) return false;
  const managed = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .first();
  if (managed && managed.agent_status !== "hibernated" && managed.agent_status !== "stopped"
    && now - (managed.last_heartbeat ?? 0) < HEARTBEAT_ALIVE_MS) return true;
  return now - (conv.updated_at ?? 0) < RECENT_ACTIVITY_MS;
}

async function ownerRef(ctx: { db: any }, conv: any, now: number): Promise<TaskOwnerRef> {
  return {
    conversation_id: conv._id,
    short_id: conv.short_id ?? String(conv._id).slice(0, 7),
    title: conv.title ?? null,
    live: await isSessionWorking(ctx, conv, now),
    updated_at: conv.updated_at ?? 0,
  };
}

function ago(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export function ownedElsewhereMessage(task: any, owner: TaskOwnerRef, now: number): string {
  const ref = task.short_id ?? String(task._id);
  const title = owner.title ? ` ("${owner.title.slice(0, 60)}")` : "";
  return [
    `${ref} is owned by session ${owner.short_id}${title}, which is still working (active ${ago(now - owner.updated_at)} ago).`,
    `A task has one owning session. Starting it here moves the binding, and ${owner.short_id} loses its task context.`,
    `Coordinate first: \`cast read ${owner.short_id}\` shows where it is, \`cast send ${owner.short_id} "..."\` agrees who continues.`,
    `To take it anyway: cast task start ${ref} --take`,
  ].join("\n");
}

/**
 * Make `conv` the task's one owning session. Other bound sessions are
 * released. A released session that is still working is refused unless
 * `take` is set, so a session never loses its task without the taker
 * deciding to. Callers acting for a person (the board, a spawn, a handoff)
 * pass take: the person chose the new session.
 */
export async function claimTaskOwnership(
  ctx: { db: any },
  conv: any,
  task: any,
  opts: { take: boolean; now?: number },
): Promise<{ released: TaskOwnerRef[] }> {
  const now = opts.now ?? Date.now();
  const others = (await boundSessionsOf(ctx, task)).filter((c) => String(c._id) !== String(conv._id));
  const refs = await Promise.all(others.map((c) => ownerRef(ctx, c, now)));
  const liveOwner = refs.find((r) => r.live);
  if (liveOwner && !opts.take) throw new Error(ownedElsewhereMessage(task, liveOwner, now));
  for (const other of others) await ctx.db.patch(other._id, { active_task_id: undefined });
  if (String(conv.active_task_id ?? "") !== String(task._id)) {
    await ctx.db.patch(conv._id, { active_task_id: task._id });
  }
  return { released: refs };
}
