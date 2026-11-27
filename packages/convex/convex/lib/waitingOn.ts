// conversations.waiting_on: what a dormant pin waits on (`cast state --status
// dormant --on <ref>`), and the wake behind it. Each kind wakes through what
// already exists, or the smallest thing beside it:
//   task    — the task closing (taskWaits.releaseDependents, every close) tells
//             each session waiting on it, found by the by_waiting_on index.
//   session — the target settling (managedSessions' settle hook, one idle grace
//             later like a worker's report: waitingOn.tellSessionWaiters).
//             Keyed on the conversation id: a short id collides across
//             workspaces. A target already settled is refused.
//   pr      — two event triggers into the session, pr_merged and pr_closed,
//             armed by waitingOn.armPrWake and cancelled when the wait clears;
//             an arm that fails clears the wait and tells the session.
//   person  — a decide card addressed to them, whose answer is the wake;
//             a day unanswered asks the session's own person (lib/personWait.ts).
// A task or session wait counts as a server-seen "wait" (lib/parkedWake.ts),
// and is cleared when it wakes the session; a PR wait parks through its
// armed triggers (armed_trigger_kind).

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../functions";
import { internal } from "../_generated/api";
import { enqueuePendingMessage } from "../pendingMessages";
import { ExecutionAuthorityError } from "../executionBindings";
import { resolveConversationRefRanked } from "../conversationSessionLookup";
import { canAccessConversation, canAccessPullRequest, canAccessTask } from "./access";
import { taskByRef } from "./taskGraph";
import { patchTask, tasksOriginatedBy } from "./agentTaskRows";
import { taskName } from "./waitSetters";
import { sessionSettledWhy } from "./sessionSettle";
import { WORKER_SETTLE_WORDS } from "@codecast/shared/contracts";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { parseWaitingOnRef, personWaitNeedsAsk, prOfWaitingRef, prWaitingRef, type WaitingOnKind } from "@codecast/shared/contracts/waitingOn";
import { armEscalation, askPerson, withdrawPersonCards, type PersonAsk } from "./personWait";

type Ctx = MutationCtx;
type Conv = Doc<"conversations">;
export type WaitingOnTarget = { kind: WaitingOnKind; ref: string; label?: string; decision_id?: Id<"session_decisions"> };

/** The stored form of `raw`, checked: a session or task that exists, the
 *  caller can read and is not done yet (a task open, a session working or
 *  dormant on a wake of its own), a PR with its repository, a person with the
 *  question to ask them, which goes to them as a card now. Throws the refusal
 *  the CLI prints. */
export async function resolveWaitingOn(ctx: Ctx, userId: Id<"users">, conv: Conv, raw: string, ask?: PersonAsk): Promise<WaitingOnTarget> {
  const parsed = parseWaitingOnRef(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  if (ask && parsed.kind !== "person") throw new Error("--ask goes with a wait on a person: --on @handle --ask \"<question>\"");
  // The wake text lands in the session, so its runner must be able to read
  // the target as well as the caller who pinned it (a co-owner's --for).
  const readers = [...new Set([String(userId), String(conv.user_id)])] as Id<"users">[];
  if (parsed.kind === "pr") {
    if (!parsed.repository) throw new Error(`#${parsed.pr_number} names no repository: write owner/repo#${parsed.pr_number}`);
    const ref = prWaitingRef(parsed.repository, parsed.pr_number);
    const ended = await endedPullRequest(ctx, readers, parsed.repository, parsed.pr_number);
    if (ended) throw new Error(`${ref} is already ${ended}: nothing will wake you`);
    return { kind: "pr", ref };
  }
  if (parsed.kind === "session") {
    const canRead = async (c: any) => (await Promise.all(readers.map((r) => canAccessConversation(ctx, r, c)))).every(Boolean);
    const target = await resolveConversationRefRanked(ctx, parsed.ref, userId, canRead);
    if (!target || !(await canRead(target))) throw new Error(`No session you can see matches "${parsed.ref}"`);
    if (String(target._id) === String(conv._id)) throw new Error("A session cannot wait on itself");
    const label = target.short_id ?? parsed.ref;
    const why = await sessionSettledWhy(ctx, target as Conv, Date.now());
    if (why) throw new Error(`${label} has already settled (${WORKER_SETTLE_WORDS[why]}): nothing will wake you. Read its result with cast read ${label}`);
    return { kind: "session", ref: String(target._id), label };
  }
  if (parsed.kind === "task") {
    const task = await taskByRef(ctx, parsed.ref);
    if (!task || !(await Promise.all(readers.map((r) => canAccessTask(ctx, r, task)))).every(Boolean)) throw new Error(`No task you can see matches "${parsed.ref}"`);
    if (isTerminalTaskStatus(task.status)) throw new Error(`${task.short_id} is already ${task.status}: nothing to wait on`);
    return { kind: "task", ref: task.short_id };
  }
  if (!ask?.question.trim()) throw new Error(personWaitNeedsAsk(parsed.ref));
  // The same person and question again keeps the open card and its day.
  const prev = conv.waiting_on;
  const held = prev?.kind === "person" && prev.ref === parsed.ref && prev.decision_id ? ((await ctx.db.get(prev.decision_id)) as Doc<"session_decisions"> | null) : null;
  if (held?.status === "pending" && held.question.trim() === ask.question.trim()) return { kind: "person", ref: parsed.ref, decision_id: held._id };
  return { kind: "person", ref: parsed.ref, decision_id: await askPerson(ctx, conv, parsed.ref, ask) };
}

/** A pull request the server has seen merged or closed, in a team one of
 *  `readers` belongs to: "merged" or "closed", else null (open, or not known
 *  here yet, which is waited on as before). */
async function endedPullRequest(ctx: Ctx, readers: Id<"users">[], repository: string, number: number): Promise<"merged" | "closed" | null> {
  const rows: Doc<"pull_requests">[] = [];
  for (const repo of new Set([repository, repository.toLowerCase()])) {
    rows.push(...(await ctx.db.query("pull_requests").withIndex("by_repository_number", (q: any) => q.eq("repository", repo).eq("number", number)).take(10)));
  }
  for (const pr of rows) {
    if (pr.state === "open") continue;
    if ((await Promise.all(readers.map((r) => canAccessPullRequest(ctx, r, pr)))).some(Boolean)) return pr.state;
  }
  return null;
}

/** Replace the session's wait with `next` (null clears it): the one writer
 *  every pin, clear and goal outcome goes through. The same target again
 *  keeps its time, its armed wake and a person's card with its day. A wait
 *  that ends takes its wake with it: a PR's triggers, a person's open card and
 *  the card that went to the session's person about it. A new person's card
 *  starts its day now. */
export async function writeWaitingOn(ctx: Ctx, conv: Conv, next: WaitingOnTarget | null): Promise<void> {
  const prev = conv.waiting_on;
  if (!prev && !next) return;
  if (prev && next && prev.kind === next.kind && prev.ref === next.ref && String(prev.decision_id ?? "") === String(next.decision_id ?? "")) return;
  const now = Date.now();
  if (prev?.kind === "pr") await cancelPrWake(ctx, conv._id, prev.ref);
  // Written first, so the old card's withdrawal finds no wait of its own to settle.
  await ctx.db.patch(conv._id, { waiting_on: next ? { ...next, at: now } : undefined });
  if (prev?.kind === "person") await withdrawPersonCards(ctx, prev, now);
  if (next?.kind === "pr") await ctx.scheduler.runAfter(0, internal.waitingOn.armPrWake, { conversation_id: conv._id });
  if (next?.kind === "person" && next.decision_id) await armEscalation(ctx, conv._id, next.decision_id);
}

// ── PR waits: event triggers into the session ───────────────────────────────

export const PR_WAKE_EVENTS = ["pr_merged", "pr_closed"] as const;

/** The title that marks a trigger as a PR wait's, so only those are cancelled. */
export const prWakeTitle = (ref: string) => `Waiting on ${ref}`;

const LIVE_TRIGGER = new Set(["scheduled", "running", "paused"]);

export async function prWakeTriggers(ctx: { db: any }, convId: Id<"conversations">, ref: string): Promise<Doc<"agent_tasks">[]> {
  return (await tasksOriginatedBy(ctx, convId)).filter((t) =>
    t.schedule_type === "event" && LIVE_TRIGGER.has(t.status) && t.title === prWakeTitle(ref) &&
    (PR_WAKE_EVENTS as readonly string[]).includes(t.event_filter?.event_type ?? ""));
}

async function cancelPrWake(ctx: Ctx, convId: Id<"conversations">, ref: string): Promise<void> {
  for (const t of await prWakeTriggers(ctx, convId, ref)) await patchTask(ctx, t, { status: "completed" });
}

/** The PR wait's triggers could not be armed: take back what was armed and
 *  the wait, and tell the session, which pinned a wake that will not come. */
export async function prWakeFailed(ctx: Ctx, conv: Conv, ref: string, reason: string): Promise<void> {
  await cancelPrWake(ctx, conv._id, ref);
  await ctx.db.patch(conv._id, { waiting_on: undefined });
  const pr = prOfWaitingRef(ref);
  const arm = pr ? `cast trigger add "<next step>" --on pr_merged --pr ${pr.pr_number} --repo ${pr.repository}` : "cast trigger add --on pr_merged";
  await enqueuePendingMessage(ctx, conv, conv.user_id, {
    content: `The wake for ${ref} could not be armed (${reason}), so nothing will wake you when it merges. Arm one with ${arm}, or pin blocked.`,
    origin: "scheduler",
    client_id: `waiting-on:pr:${ref}:arm-failed:${conv.waiting_on?.at ?? 0}`,
  });
}

export function prWakePrompt(ref: string, event: (typeof PR_WAKE_EVENTS)[number]): string {
  return event === "pr_merged"
    ? `${ref} merged, which this session waited on (cast state --on ${ref}). Continue the work that waited on it, and pin your state again.`
    : `${ref} was closed without merging, which this session waited on (cast state --on ${ref}). Replan the work that waited on it, and pin your state again.`;
}

// ── Task and session waits: told when the target is done ───────────────────

const WAITERS_CAP = 50;

export function waitersOn(ctx: { db: any }, kind: "session" | "task", ref: string): Promise<Conv[]> {
  return ctx.db.query("conversations")
    .withIndex("by_waiting_on", (q: any) => q.eq("waiting_on.kind", kind).eq("waiting_on.ref", ref))
    .take(WAITERS_CAP);
}

/** Tell each session waiting on `kind`/`ref` what `say` makes of it (null:
 *  it hears another way), and clear its wait: what it waited for happened.
 *  A wake the session refuses now leaves its wait standing, so the inbox does
 *  not lose it. `key` names the event, so a repeat delivers once. */
export async function wakeWaiters(
  ctx: Ctx,
  kind: "session" | "task",
  ref: string,
  key: string,
  say: (waiter: Conv) => string | null,
): Promise<number> {
  let told = 0;
  for (const w of await waitersOn(ctx, kind, ref)) {
    const content = w.inbox_killed_at ? null : say(w);
    if (content) {
      try {
        await enqueuePendingMessage(ctx, w, w.user_id, { content, origin: "scheduler", client_id: `waiting-on:${kind}:${ref}:${key}` });
        told++;
      } catch (e) {
        if (!(e instanceof ExecutionAuthorityError)) throw e;
        console.warn(`[waitingOn] ${ref}: could not wake ${w._id}: ${e.message}`);
        continue;
      }
    }
    await ctx.db.patch(w._id, { waiting_on: undefined });
  }
  return told;
}

/** `task` closed as `status`: each session waiting on it continues or replans. */
export async function tellTaskWaiters(ctx: Ctx, task: Doc<"tasks">, status: string): Promise<void> {
  const name = taskName(task);
  await wakeWaiters(ctx, "task", task.short_id, `closed:${status}:${task.updated_at ?? 0}`, () =>
    status === "done"
      ? `${name} was closed as done, which you waited on (cast state --on ${task.short_id}). Continue the work that waited on it.`
      : `${name} was closed (${status}), which you waited on (cast state --on ${task.short_id}). Replan the work that waited on it.`,
  );
}
