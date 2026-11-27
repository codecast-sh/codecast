// Under the owners model (team feature session_owners) an agent owner answers
// the session's waits: its role, or the session it works for (shared
// agentOwnerOfRow). A role hears through its route up (agentTasks
// routeUpWaitingSession); a parent session is told directly, as a frame queued
// as its next turn. A wait the agent cannot hear, or passes up, escalates to
// the session's people by the shared rule (sessionOwners waitAudience): the
// row is stamped with when, the message count it covers and the person it
// reached that no owner row names (wait_up_at, wait_up_count, wait_up_person),
// and the inbox and the needs-input push both read that one audience.
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { formatScheduledTask, isClosedSession, waitReachedPeople, agentOwnerOfRow, type InboxAgentOwner } from "@codecast/shared/contracts";
import { routeUpHears, routeUpWaitingSession } from "../agentTasks";
import { enqueuePendingMessage } from "../pendingMessages";
import { inboxOwnersOf, ownersModelOnMemo, unseatedChild } from "./inboxOwners";
export { escalateWait } from "./inboxOwners";
import { isSpawnedWorker } from "./workerSettleTrigger";
import { roleMachineAway } from "./orgRoutine";
import { runnerDeviceOf } from "./runnerDevice";
import { notPriorityCard } from "./priorityCardAccess";

export type AgentOwnerRoute = "told" | "already" | "nobody" | "unreachable";

/** The agent that answers the conversation's waits under the model, and
 *  whether the current wait already reached its people. Null off the model.
 *  `orphaned`: no agent answers it and no window seats it (unseatedChild),
 *  so its wait must escalate to seat its person. */
export async function agentOwnerFor(ctx: { db: any }, conv: any): Promise<{ agent: InboxAgentOwner | null; reachedPeople: boolean; orphaned: boolean } | null> {
  const owners = await inboxOwnersOf(ctx, conv);
  if (!owners) return null;
  const row = { ...conv, ...owners };
  const agent = agentOwnerOfRow(row);
  return { agent, reachedPeople: waitReachedPeople(row), orphaned: !agent && await unseatedChild(ctx, conv) };
}

/** The parent session can take a wait now: it exists, nobody retired or
 *  closed it, and its machine is not away (the role path's roleMachineAway).
 *  A closed or away parent still owns the session; it just cannot answer. */
async function reachableParent(ctx: { db: any }, parentId: string): Promise<any | null> {
  const parent = await ctx.db.get(parentId as Id<"conversations">).catch(() => null);
  if (!parent || parent.inbox_killed_at || isClosedSession(parent)) return null;
  if (roleMachineAway(await runnerDeviceOf(ctx, parent), Date.now())) return null;
  return parent;
}

/** Can the agent owner hear a wait at all (for a plain settled turn, whose
 *  verdict the settle classifier gives later)? */
export async function agentOwnerHears(ctx: any, conv: any, agent: InboxAgentOwner): Promise<"hears" | "nobody" | "unreachable"> {
  if (agent.kind === "role") return routeUpHears(ctx, conv);
  return (await reachableParent(ctx, agent.id)) ? "hears" : "unreachable";
}

/** Deliver the wait to the agent owner, once per ask (the route up's own
 *  hand_wake_notified_key episode). A session waiting on its own open
 *  decision tells nobody: a decision goes to people (sessionDecisions
 *  routeFor), as the role path stands down on it too. */
export async function routeWaitToAgentOwner(
  ctx: any,
  conv: any,
  agent: InboxAgentOwner,
  wait: { why: string; since: number; stuck?: boolean },
): Promise<AgentOwnerRoute> {
  if (agent.kind === "role") return routeUpWaitingSession(ctx, conv, wait);
  if (conv.inbox_killed_at || isClosedSession(conv)) return "nobody";
  const openDecision = await ctx.db
    .query("session_decisions")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conv._id).eq("status", "pending"))
    // A priority card sitting in the session is not its question (lib/priorityCardAccess).
    .filter(notPriorityCard)
    .first();
  if (openDecision) return "already";
  const parent = await reachableParent(ctx, agent.id);
  if (!parent) return "unreachable";
  // A spawned worker already reports its settle to the session it nests under
  // (workerSettle.tellParent), stalls and blocks included.
  if (isSpawnedWorker(conv) && String(parent._id) === String(conv.parent_conversation_id) && String(parent.user_id) === String(conv.user_id)) return "told";
  const state = String(conv.thread_state ?? "").split("\n")[0].slice(0, 200);
  const episode = `${conv.message_count ?? 0}:${state}`;
  if (conv.hand_wake_notified_key === episode) return "already";
  const shortId = conv.short_id ?? String(conv._id).slice(0, 7);
  await enqueuePendingMessage(ctx, parent, parent.user_id, {
    content: formatScheduledTask({
      title: `Session ${shortId} waits on you`,
      waiting: { short_id: shortId, title: (conv.title ?? "").slice(0, 80), why: wait.why, since: wait.since, state },
      body: `You own it, so its waits are yours to answer: read it with cast read ${shortId} and answer with cast send ${shortId}. If a person must decide, pass it up with cast own ${shortId} --pass-up.`,
    }),
    origin: "scheduler",
    client_id: `owner-waits:${conv._id}:${episode}`,
  });
  await ctx.db.patch(conv._id, { hand_wake_notified_key: episode });
  return "told";
}

// A dead parent's children are released once its kill cascade has run (it
// takes most of them down, and the job skips a killed child), and the waits
// it was answering reach a person (notifications.releaseDeadParentChildren).
// Under the owners model only.
const DEAD_PARENT_RELEASE_MS = 60_000;
export async function releaseDeadParentChildrenLater(
  ctx: { db: any; scheduler?: any },
  parent: { _id: any; team_id?: any; user_id?: any; inbox_killed_at?: number },
  opts: { onlyWithChildren?: boolean } = {},
): Promise<void> {
  if (!ctx.scheduler || !(await ownersModelOnMemo(ctx, parent))) return;
  if (opts.onlyWithChildren) {
    const sub = await ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", parent._id)).first();
    if (!sub) return;
  }
  await ctx.scheduler.runAfter(DEAD_PARENT_RELEASE_MS, internal.notifications.releaseDeadParentChildren, { parent_id: String(parent._id), released_at: parent.inbox_killed_at ?? Date.now() });
}
