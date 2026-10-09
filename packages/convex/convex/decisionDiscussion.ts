// Every decision has a session the person can discuss it with (ct-58330).
//
// The owner of a decision is the session that presents it: it can read the
// full record and answer, or send the work back through the decision. That
// is the session that asked, when it is still a live session someone answers
// for. A line run's gate asks through the run's asker (the session that
// started the run, else the run's log), and a run log is nobody to talk to,
// so its gates fall to the session that started the run, then to the lead
// role of the work's project, the way routeFor sends the question itself.
// With none of those, the workspace's own agent owns it. The rule is read
// at every turn, so a decision whose owner died gets the next one in line.
//
// A person's words reach the owner on the ordinary pending message rail as a
// <decision-discussion> frame (shared machineMessages), recorded on the row
// as an ask. The owner's reply is the last thing it says after reading the
// ask, read back from its transcript: no second copy of what it said.

import { query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import { findDecision, peopleFor, userMayRead } from "./sessionDecisions";
import { projectLeadRole } from "./lib/orgAccess";
import { enqueuePendingMessage, reachableRole } from "./pendingMessages";
import { workspaceAnchorFor } from "./anchors";
import { resolveActor } from "./lib/actor";
import { formatDecisionDiscussion, isToolResultCarrier, parseDecisionDiscussion } from "@codecast/shared/contracts";

type Ctx = { db: any };
type DecisionRow = Doc<"session_decisions">;

/** Why the owner is the owner: it asked, it started the run, it leads the
 *  work's project, or it is the workspace's own agent. */
export type DecisionOwnerVia = "asker" | "run" | "lead" | "workspace";

export type DecisionOwner = { conversation: Doc<"conversations">; via: DecisionOwnerVia };

/** The most asks a row keeps: a conversation about one question, not a log. */
export const DISCUSSION_MAX_ASKS = 50;
export const DISCUSSION_MAX_CHARS = 8000;
/** Messages one read of an owner's transcript looks at before it starts
 *  again from the next unplaced ask. */
const DISCUSSION_READ_BUDGET = 400;
/** Reads per owner session, so the query stays bounded however long the talk. */
const DISCUSSION_READS_PER_SESSION = 8;

// A session that can answer for a decision it asked: it exists, it is not a
// run's log (which no agent reads), it was not killed, and a person answers
// for it (an owner, or a role the org shows). An agent account's session that
// nobody owns has no one who would ever read the conversation.
async function answersForItself(ctx: Ctx, conv: any): Promise<boolean> {
  if (!conv || conv.is_workflow_primary || conv.inbox_killed_at) return false;
  if (conv.standing_role_id) return true;
  return (await peopleFor(ctx, conv)).length > 0;
}

export async function decisionOwner(ctx: Ctx, row: Pick<DecisionRow, "conversation_id" | "workflow_run_id" | "task_id" | "user_id" | "asked_user_ids">): Promise<DecisionOwner | null> {
  const asker = await ctx.db.get(row.conversation_id);
  if (await answersForItself(ctx, asker)) return { conversation: asker, via: "asker" };
  const run = row.workflow_run_id ? await ctx.db.get(row.workflow_run_id) : null;
  const starter = run?.spawner_conversation_id && String(run.spawner_conversation_id) !== String(row.conversation_id)
    ? await ctx.db.get(run.spawner_conversation_id)
    : null;
  if (await answersForItself(ctx, starter)) return { conversation: starter, via: "run" };
  const taskId = row.task_id ?? run?.task_id;
  const task = taskId ? await ctx.db.get(taskId) : null;
  const lead = await projectLeadRole(ctx, task);
  const leadSession = lead ? (await reachableRole(ctx, lead._id))?.standing : null;
  if (leadSession && !leadSession.inbox_killed_at) return { conversation: leadSession, via: "lead" };
  const teamId = asker?.team_id ?? run?.team_id ?? task?.team_id;
  const anchor = await workspaceAnchorFor(ctx, teamId ? { team_id: teamId } : { scope_user_id: row.asked_user_ids?.[0] ?? row.user_id });
  const agent = anchor?.conversation_id && anchor.status !== "decommissioned" ? await ctx.db.get(anchor.conversation_id) : null;
  if (agent && !agent.inbox_killed_at) return { conversation: agent, via: "workspace" };
  return null;
}

/** What a person calls the owner: a role by its name, a session by its title. */
async function ownerName(ctx: Ctx, conv: any): Promise<string> {
  const role = conv.standing_role_id ? await ctx.db.get(conv.standing_role_id) : null;
  return role?.name ?? (conv.title || conv.short_id || "the session");
}

/**
 * A person says something about a decision to the session that owns it. The
 * decision is the authority: whoever may read it may ask its owner about it,
 * the way a person asked a question may ask the asker what it meant, even
 * when they cannot otherwise write into that session. Idempotent on the
 * client id, so the outbox can redeliver.
 */
export async function discussCore(
  ctx: any,
  userId: Id<"users">,
  args: { decision: string; text: string; client_id: string },
): Promise<{ ok: true; conversation_id: Id<"conversations"> } | { error: string }> {
  const row: DecisionRow | null = await findDecision(ctx, args.decision);
  if (!row || !(await userMayRead(ctx, userId, row))) return { error: "Decision not found" };
  const text = (args.text ?? "").trim();
  if (!text) return { error: "The message is empty" };
  if (text.length > DISCUSSION_MAX_CHARS) return { error: `A message about a decision can be at most ${DISCUSSION_MAX_CHARS.toLocaleString("en-US")} characters` };
  const already = row.discussion?.find((a) => a.client_id === args.client_id);
  if (already) return { ok: true, conversation_id: already.conversation_id };
  const owner = await decisionOwner(ctx, row);
  if (!owner) return { error: `${row.short_id ?? "This decision"} has no session to discuss it with` };
  const from = (await resolveActor(ctx, userId, null)).name ?? "A person";
  const now = Date.now();
  await enqueuePendingMessage(ctx, owner.conversation, userId, {
    content: formatDecisionDiscussion({ decision: row.short_id ?? String(row._id), question: row.question, from, body: text }),
    client_id: args.client_id,
    human: true,
  });
  const ask = { conversation_id: owner.conversation._id, user_id: userId, text, client_id: args.client_id, at: now };
  await ctx.db.patch(row._id, { discussion: [...(row.discussion ?? []), ask].slice(-DISCUSSION_MAX_ASKS) });
  return { ok: true, conversation_id: owner.conversation._id };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The text of an assistant row worth showing as a reply, or null. */
function replyText(m: any): string | null {
  if (m.role !== "assistant" || m.subtype) return null;
  const text = typeof m.content === "string" ? m.content.trim() : "";
  return text || null;
}

export type DiscussionTurn = {
  client_id: string;
  text: string;
  at: number;
  user_id: Id<"users">;
  conversation_id: Id<"conversations">;
  /** True once the ask is in the owner's transcript. */
  delivered: boolean;
  reply: { text: string; at: number } | null;
};

/**
 * Each ask with the owner's answer: the last thing the owner said after it
 * read the ask and before the next person's words reached it. Reads forward
 * from the oldest ask in each session, in bounded reads that each start at
 * the oldest ask still unplaced, and stops once every ask is placed.
 */
export async function discussionTurns(ctx: Ctx, row: Pick<DecisionRow, "short_id" | "_id" | "discussion">): Promise<DiscussionTurn[]> {
  const asks = row.discussion ?? [];
  const ref = row.short_id ?? String(row._id);
  const turns: DiscussionTurn[] = asks.map((a) => ({ ...a, delivered: false, reply: null }));
  const byConversation = new Map<string, DiscussionTurn[]>();
  for (const t of turns) {
    const key = String(t.conversation_id);
    byConversation.set(key, [...(byConversation.get(key) ?? []), t]);
  }
  for (const list of byConversation.values()) {
    // A busy standing session can say hundreds of things between two asks,
    // so each read starts at the oldest ask still unplaced: a read that runs
    // out of budget leaves the next one to start from the ask it missed.
    const byTime = [...list].sort((a, b) => a.at - b.at);
    let from = 0;
    for (let reads = 0; reads < DISCUSSION_READS_PER_SESSION && from < byTime.length; reads++) {
      const exhausted = await placeAsks(ctx, list, ref, byTime[from].at - 60_000);
      if (!exhausted) break;
      const next = byTime.findIndex((t, i) => i > from && !t.delivered);
      if (next < 0) break;
      from = next;
    }
  }
  return turns;
}

/** One bounded read of an owner's transcript from `since`, marking the asks
 *  it meets as delivered with their replies. True when the read ran out of
 *  budget before the transcript ended. */
async function placeAsks(ctx: Ctx, list: DiscussionTurn[], ref: string, since: number): Promise<boolean> {
  let open: DiscussionTurn | null = null;
  let read = 0;
  const q = ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (ix: any) => ix.eq("conversation_id", list[0].conversation_id).gte("timestamp", since))
    .order("asc");
  for await (const m of q) {
    if (++read > DISCUSSION_READ_BUDGET) return true;
    if (m.role === "user" && !isToolResultCarrier(m)) {
      const said = parseDecisionDiscussion(m.content);
      // A tmux injection can collapse the newlines, leaving the header on
      // the body's line, so the ask is matched as the body's ending.
      const match = said?.decision === ref ? list.find((t) => !t.delivered && squash(said.body).endsWith(squash(t.text))) : undefined;
      if (match) match.delivered = true;
      // Anything a person or a machine says next starts a new turn: what
      // the owner says after it answers that, not the ask.
      open = match ?? null;
      if (!match && list.every((t) => t.delivered && t.reply)) return false;
      continue;
    }
    const text = open ? replyText(m) : null;
    if (open && text) open.reply = { text, at: m.timestamp };
  }
  return false;
}

/**
 * The discussion of one decision, for its surfaces: who owns it (resolved
 * now, so the button names who answers before anything was said) and each
 * ask with its reply. Null when the viewer may not read the decision.
 */
export const discussion = query({
  args: { decision_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row: DecisionRow | null = await findDecision(ctx, args.decision_id);
    if (!row || !(await userMayRead(ctx, userId, row))) return null;
    const owner = await decisionOwner(ctx, row);
    const turns = await discussionTurns(ctx, row);
    const people = new Map<string, string>();
    for (const t of turns) {
      const key = String(t.user_id);
      if (people.has(key)) continue;
      const u: any = await ctx.db.get(t.user_id);
      people.set(key, u?.name || u?.email?.split("@")[0] || "Someone");
    }
    return {
      _id: row._id,
      decision_short_id: row.short_id,
      owner: owner
        ? {
            conversation_id: owner.conversation._id,
            short_id: owner.conversation.short_id,
            name: await ownerName(ctx, owner.conversation),
            via: owner.via,
          }
        : null,
      turns: turns.map((t) => ({ ...t, by: people.get(String(t.user_id)) ?? "Someone" })),
    };
  },
});
