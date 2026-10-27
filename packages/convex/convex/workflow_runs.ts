import { mutation, query, internalMutation } from "./functions";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { resolveCreationPrivacy } from "./privacy";
import { findConversationByAnyRef, findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { killConversation } from "./conversations";
import { askCore, finalizeAnswer, joinStack, normalizeVerdict, personMayResolve, userMayRead, withdrawCore, type AnsweredBy } from "./sessionDecisions";
import { createStackCore } from "./decisionStacks";
import { projectLeadRole } from "./lib/orgAccess";
import { CARD_GATE_NODE_ID, costParts, endedFailing, lineRunOutcome, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { canAccessTask, canAccessPlan, computeWorkspaceKey, resolveWorkspaceKey, workspaceGrantsAccess } from "./lib/access";
import { patchTask } from "./lib/taskWrite";
import { repairedClosedAt, repairedLineStatus, statusHistory } from "./lib/lineCauseRepair";
import { moveTaskStatus } from "./tasks";
import { noticeCardWaiting, noticeChangeShipped } from "./lineNotices";
import { createDataContext } from "./data";
import { askTrialGate, trialProjectOf } from "./lineTrial";
import { alignGateChoices, gateResponseOf, standingCard } from "./lib/gateChoices";
import { runSuperseded } from "./lib/superseded";
import { resolveOwnerDevice } from "./devices";
import { openRunPrice } from "./lib/trialRunPrices";
import { isLineRunSlug, lineRouteFor } from "./workflows";
import { recordRoutineRunGraph, recordScriptRunGraph } from "./flowLibrary";
import { libraryOfRun, repinRunForResume, runFlowVersions } from "./flowVersions";
import { ingestSnapshotArgs } from "./lib/workflowGraphValidators";
import { admitRoleRun, requeueForSweep } from "./orgLine";

type Ctx = { db: any };

// ── the-line.md L8: runs belong to the workspace ─────────────────────────────
//
// `workspace` is ACCESS (one equality per read), `team_id` is ROUTING. A run
// bound to a task or plan lives where that work item lives, so a teammate
// who can read the task can read its run. An unbound run follows the privacy
// its primary session was created with (the directory rule), which is what
// computeWorkspaceKey reads for a linked conversation.
export async function runScope(
  ctx: Ctx,
  userId: Id<"users">,
  opts: { task?: any; plan?: any; conversation?: { team_id?: Id<"teams">; is_private?: boolean; auto_shared?: boolean; team_visibility?: string } | null },
): Promise<{ workspace: string; team_id: Id<"teams"> | undefined }> {
  const item = opts.task ?? opts.plan;
  if (item) return { workspace: await resolveWorkspaceKey(ctx, item), team_id: item.team_id };
  const conv = opts.conversation ?? null;
  return {
    workspace: computeWorkspaceKey({ user_id: userId, team_id: conv?.team_id }, conv),
    team_id: conv?.team_id,
  };
}

// Owner always; otherwise the run's ACCESS key must grant the viewer. The
// stored key when present, the write-time compute for rows minted before
// the backfill (they resolve personal to their owner).
export async function canReadRun(ctx: Ctx, userId: Id<"users">, run: any): Promise<boolean> {
  if (String(run.user_id) === String(userId)) return true;
  return workspaceGrantsAccess(ctx, userId, await resolveWorkspaceKey(ctx, run));
}

// ── LE16: status follows the line ────────────────────────────────────────────

/**
 * The status a run's end leaves its task in (the-line-end-to-end.md LE16).
 * A status the line already decided stands: done and dropped are never
 * overwritten. A line run that shipped makes the cause done (the watch is the
 * window after done); one that parked returns it to open, to wait for
 * admission. Any other completed run hands work it was still doing to a
 * person (in_progress becomes in_review) and leaves every other status, such
 * as a review reject's open, where its station put it. Null leaves it.
 */
export function runEndStatus(
  taskStatus: string,
  runStatus: "completed" | "failed" | "running",
  run: Parameters<typeof lineRunOutcome>[0],
): "done" | "open" | "in_review" | null {
  if (runStatus !== "completed" || isTerminalTaskStatus(taskStatus)) return null;
  const end = lineRunOutcome(run)?.kind;
  if (end === "shipped") return "done";
  if (end === "parked") return taskStatus === "in_progress" ? "open" : null;
  return taskStatus === "in_progress" ? "in_review" : null;
}

/** A run ended: its task's status through the one status path, and the ship notice. */
async function settleRunTask(ctx: Ctx & { runMutation?: any }, run: any, runStatus: "completed" | "failed" | "running", failReason: string | undefined, now: number) {
  const task = await ctx.db.get(run.task_id);
  if (!task) return;
  if (runStatus === "failed") {
    // A closed problem is not blocked: its run was ended by the close (a person's drop, a merge), which stands.
    if (isTerminalTaskStatus(task.status)) return;
    await patchTask(ctx, task, { execution_status: "blocked", ...(failReason ? { execution_concerns: failReason } : {}), updated_at: now });
    return;
  }
  const next = runEndStatus(task.status, runStatus, run);
  if (!next) return;
  const end = lineRunOutcome(run);
  await moveTaskStatus(ctx, task, next, { actorUserId: run.user_id, now, ...(next === "done" && end ? { closedAt: end.at } : {}) });
  if (next === "done" && end?.kind === "shipped") await noticeChangeShipped(ctx, task, task.watch_until);
}

// ── the-line.md L4: a gate is a decision ─────────────────────────────────────

// "[A] Approve" → "Approve": the decision numbers its options itself; the
// gate key lives on the run's gate_choices mirror and maps back by index.
function stripGateKey(label: string): string {
  return label.replace(/^\[[^\]]*\]\s*/, "").trim() || label;
}

// The run panel's free text picks an option when it starts with a gate key
// (exact, "A:", "A ", "[A]"), the same rule the runner applies to the text.
export function gateChoiceIndex(choices: Array<{ key: string }> | undefined, response: string): number {
  const r = response.trim().toUpperCase();
  return (choices ?? []).findIndex((ch) => {
    const k = ch.key.toUpperCase();
    return r === k || r.startsWith(k + ":") || r.startsWith(k + " ") || r.startsWith(`[${k}]`);
  });
}

export type GateChoice = { key: string; label: string; description?: string; target: string };

// The graph's `stack="Launch checklist"` attribute (the-line.md L4): one
// stack per run, created on the first gate and appended to by every later
// gate. The run's previous gate decision still sits on gate_decision_id when
// the next gate pauses, and its stack_id names the run's stack. A `ds-N`
// reference is passed through as an existing stack.
async function gateStackRef(ctx: Ctx, userId: Id<"users">, run: any, stack: string | undefined): Promise<string | undefined> {
  if (!stack) return undefined;
  if (/^ds-\d+$/.test(stack)) return stack;
  const previous = run.gate_decision_id ? await ctx.db.get(run.gate_decision_id) : null;
  if (previous?.stack_id) {
    const existing = await ctx.db.get(previous.stack_id);
    if (existing) {
      // The gates come one at a time, so answering the last one closed the
      // stack; the next gate reopens it, the way a reopened answer does.
      if (existing.status === "done") await ctx.db.patch(existing._id, { status: "open", updated_at: Date.now() });
      return existing.short_id;
    }
  }
  const created = await createStackCore(ctx, userId, { title: stack, team_id: run.team_id ?? undefined, client_key: `run:${run._id}` });
  return created.error ? undefined : created.short_id;
}

/** A session's newest decision still waiting and bound to no run: the one it posted for the gate to adopt. */
/** The session of the station a gate names (`asker=`), by any ref the runner sends (its hand's short id, or a full
 *  session id): the run's own session wins a short-id collision. */
export async function stationSession(ctx: Ctx, ref: string | undefined, runId: Id<"workflow_runs">): Promise<Doc<"conversations"> | null> {
  if (!ref) return null;
  return ((await findConversationByAnyRefWhere(ctx as any, ref, (c: any) => String(c.workflow_run_id ?? "") === String(runId)))
    ?? (await findConversationByAnyRefWhere(ctx as any, ref, () => true))) as Doc<"conversations"> | null;
}

export async function openDecisionOf(ctx: Ctx, conversationId: Id<"conversations">) {
  const rows = await ctx.db.query("session_decisions").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", "pending")).collect();
  return rows.filter((d: any) => !d.workflow_run_id).sort((a: any, b: any) => b.created_at - a.created_at)[0] ?? null;
}

// Pause the run at a gate and ask the person through the one rail every
// human question uses (the-line.md L4). The asker is the session that
// started the run (so the ladder and grants apply), else the run's primary
// conversation. gate_prompt / gate_choices stay on the run as a mirror for
// old readers and for the key map the answer rides back on.
export async function pauseAtGateCore(
  ctx: Ctx,
  auth: { userId: Id<"users"> },
  args: { run_id: Id<"workflow_runs">; node_id: string; prompt: string; choices: GateChoice[]; doc_md?: string; category?: string; stack?: string; card?: ChangeCard; proposal?: unknown; judge_fix?: unknown; asker_session_id?: string; asker?: string },
) {
  const run = await ctx.db.get(args.run_id);
  if (!run || String(run.user_id) !== String(auth.userId)) return { error: "Not found" };

  const now = Date.now();
  // A trial project's run asks nobody (lineTrial.ts): the gate becomes a
  // trial card, before any stack or decision exists for it.
  const trialTask = run.task_id ? await ctx.db.get(run.task_id) : null;
  const trialProject = await trialProjectOf(ctx, trialTask);
  if (trialProject && trialTask) {
    await ctx.db.patch(args.run_id, {
      status: "paused",
      current_node_id: args.node_id,
      gate_node_id: args.node_id,
      gate_prompt: args.prompt,
      gate_choices: args.choices.map((c) => ({ key: c.key, label: c.label, target: c.target })),
      gate_response: undefined,
      gate_decision_id: undefined,
      updated_at: now,
    });
    if (trialTask.status !== "dropped") await moveTaskStatus(ctx, trialTask, "in_review", { actorUserId: run.user_id, now });
    return askTrialGate(ctx, run, trialTask, trialProject, args, now);
  }
  // Resolved before the patch below clears the previous gate's decision id.
  const stackRef = await gateStackRef(ctx, auth.userId, run, args.stack);
  // The mirror carries only key, label and target (the stored shape).
  const mirror = args.choices.map((c) => ({ key: c.key, label: c.label, target: c.target }));
  await ctx.db.patch(args.run_id, {
    status: "paused",
    current_node_id: args.node_id,
    gate_node_id: args.node_id,
    gate_prompt: args.prompt,
    gate_choices: mirror,
    gate_response: undefined,
    gate_decision_id: undefined,
    updated_at: now,
  });

  // The station the task waits at is the one the gate parks it in: the
  // decision is bound there so a blocking gate holds the task (L5). A dropped
  // task stays dropped: the line decided it (LE16).
  if (run.task_id) {
    const held = await ctx.db.get(run.task_id);
    if (held && held.status !== "dropped") await moveTaskStatus(ctx, held, "in_review", { actorUserId: run.user_id, now });
  }
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;

  let decision: { id: Id<"session_decisions">; short_id?: string } | null = null;
  // The station the gate names (`asker=`) presents the decision from its own session, so it lives in the thread that
  // wrote it and a person can talk to that session before answering. The gate takes the card that session posted and
  // asks nothing of its own: an answered card is the gate's answer at once, and with no card standing nobody is asked
  // and the run goes back to the station to present one.
  const station = await stationSession(ctx, args.asker_session_id, run._id);
  const own = station ? await standingCard(ctx, run, station._id, args.node_id, args.asker_session_id) : null;
  if (!own && (station || args.asker)) return { error: `${args.asker ?? "the presenting station"} posted no card for this gate`, present_again: true };
  if (own) {
    // A card still waiting joins the gate's stack (a trial's runs gather in one the person opens when they review).
    const stackRow = stackRef && own.status === "pending" ? await ctx.db.query("decision_stacks").withIndex("by_short_id", (q: any) => q.eq("short_id", stackRef)).first() : null;
    await ctx.db.patch(own._id, {
      workflow_run_id: args.run_id,
      gate_node_id: args.node_id,
      blocking: true,
      ...(task ? { task_id: task._id, station: task.status_id ?? task.status } : {}),
      ...(stackRow ? await joinStack(ctx, stackRow, own, now) : {}),
      updated_at: now,
    });
    // The session's options in its own order, each keyed to the edge it names (an answer routes by option index).
    const choices = alignGateChoices(own.options, args.choices).map((c, i) => (c ? { key: c.key, label: c.label, target: c.target } : { key: "", label: own.options[i].label, target: "" }));
    const answered = own.status === "answered" ? { gate_response: gateResponseOf(choices[own.answer_index ?? -1]?.key, own.answer_text, own.options[own.answer_index ?? -1]?.label), status: "running" as const } : {};
    await ctx.db.patch(args.run_id, { gate_decision_id: own._id, gate_choices: choices, ...answered });
    decision = { id: own._id, short_id: own.short_id };
  }
  const askerId = station?._id ?? run.spawner_conversation_id ?? run.primary_conversation_id;
  const asker = decision ? null : askerId ? await ctx.db.get(askerId) : null;
  if (!decision && !asker) return { error: "the gate could not ask anyone: the run has no session to ask from" };
  if (asker) {
    const [first, ...rest] = args.prompt.split("\n");
    const question = first.trim() || args.node_id;
    const body = rest.join("\n").trim();
    // The run asks through its asker, which may be a session another account
    // owns (the project lead's, chosen at create for a run started outside a
    // session): ask as that session's owner, or askCore refuses it as not ours.
    const askAs = { userId: asker.user_id as Id<"users"> };
    const ask = (card?: ChangeCard) => askCore(ctx, askAs, {
      session_id: asker.session_id,
      question,
      context_md: body || undefined,
      options: args.choices.map((c) => ({ label: stripGateKey(c.label), ...(c.description ? { description: c.description } : {}) })),
      doc_md: args.doc_md,
      // LE11: the change card the gate decides on, drawn natively by the web.
      card,
      category: args.category,
      stack: stackRef,
      blocking: true,
      task: task?.short_id,
      station: task ? task.status_id ?? task.status : undefined,
      workflow_run_id: args.run_id,
      gate_node_id: args.node_id,
    });
    // A card that fails its contract must not cost the run its gate: the
    // question is asked without it and the card's page stays on the task.
    let asked = await ask(args.card);
    if (asked?.error && args.card) asked = await ask(undefined);
    if (asked && !asked.error) {
      decision = { id: asked.id, short_id: asked.short_id };
      await ctx.db.patch(args.run_id, { gate_decision_id: asked.id });
      // A card waits on a person (LE16): the person holding the decision hears.
      const holder = (asked as { holder?: { kind: string; id: string } }).holder;
      if (task && holder?.kind === "user" && (args.card || args.node_id === CARD_GATE_NODE_ID)) {
        await noticeCardWaiting(ctx, task, holder.id as Id<"users">, asked.short_id, args.card?.headline);
      }
    } else {
      // A gate nobody was asked must not wait forever in silence.
      return { error: `the gate could not ask anyone: ${asked?.error ?? "no answer from the decision rail"}` };
    }
  }

  // Post gate message to primary conversation
  if (run.primary_conversation_id) {
    const primaryConv = await ctx.db.get(run.primary_conversation_id);
    if (primaryConv) {
      await ctx.db.insert("messages", {
        conversation_id: run.primary_conversation_id,
        role: "assistant",
        content: JSON.stringify({
          __wf: "gate",
          prompt: args.prompt,
          choices: mirror,
          run_id: args.run_id,
          ...(decision ? { decision_id: decision.id, decision_short_id: decision.short_id } : {}),
        }),
        subtype: "workflow_event",
        timestamp: now,
      });
      await ctx.db.patch(run.primary_conversation_id, {
        message_count: (primaryConv.message_count || 0) + 1,
        updated_at: now,
        last_message_role: "assistant",
      });
    }
  }

  return { ok: true, decision_id: decision?.id, decision_short_id: decision?.short_id };
}

// Answer the run's open gate with free text (the-line.md L4): text that
// starts with a gate key picks that option; anything else is the typed
// answer and routes the run on its unconditional edge. The answer goes
// through finalizeAnswer (first writer wins; settleGateRun writes
// gate_response and status running). A run paused before gates were
// decisions has no decision row and is patched directly, as before.
export async function answerGateCore(ctx: Ctx, run: any, response: string, by: AnsweredBy): Promise<{ ok: true } | { error: string }> {
  if (run.status !== "paused") return { error: "Not paused" };
  const now = Date.now();
  const trimmed = response.trim();
  const decision = run.gate_decision_id ? await ctx.db.get(run.gate_decision_id) : null;
  if (decision && decision.status === "pending") {
    // The run panel answers under the same rule as the decision card: anyone
    // who may read the gate may answer it, and its people hear about it.
    if (by.user_id && !(await userMayRead(ctx as any, by.user_id, decision))) return { error: "Unauthorized: not your decision" };
    const idx = gateChoiceIndex(run.gate_choices, trimmed);
    const verdict = normalizeVerdict(decision, idx >= 0
      ? { status: "answered", answer_index: idx, answer_text: trimmed }
      : { status: "answered", answer_text: trimmed });
    if ("error" in verdict) return { error: verdict.error };
    await finalizeAnswer(ctx, decision, verdict, by, { deliver: false, now });
    return { ok: true };
  }
  if (decision) return { error: `Gate already ${decision.status}` };
  await ctx.db.patch(run._id, { gate_response: trimmed, status: "running", updated_at: now });
  return { ok: true };
}

// Reading a run is workspace wide (L8); cancelling it is the owner's, or a
// person its open gate was asked of, since cancel withdraws that decision.
async function canCancelRun(ctx: Ctx, userId: Id<"users">, run: any): Promise<boolean> {
  if (String(run.user_id) === String(userId)) return true;
  const decision = run.gate_decision_id ? await ctx.db.get(run.gate_decision_id) : null;
  return !!decision && decision.status === "pending" && personMayResolve(decision, userId);
}

// Cancel a run. Its open gate decision is withdrawn through the shared
// withdraw path (the-line.md L4) so the queue, the stack and the ladder
// learn the question is gone.
export async function cancelCore(ctx: Ctx, run: any, now = Date.now(), reason = "Cancelled by user"): Promise<void> {
  if (run.status === "completed" || run.status === "failed") return;
  await withdrawOpenGate(ctx, { ...run, status: "failed", fail_reason: reason }, now);
  await ctx.db.patch(run._id, { status: "failed", fail_reason: reason, updated_at: now });
  await stopStationHands(ctx, run);
}

// A station's hand is a session process on a machine, holding the run's
// worktree. It ends with its station: when the runner reports the station
// over (settled, failed, timed out), and, for every hand the run still holds,
// when the run ends however it ends (completed, failed, a Ctrl-C on the
// runner, a cancel). The stop keeps the card: the hand reads ended in the
// inbox with its transcript, and a send restarts it. A runner that is
// restarted or dies (SIGTERM, SIGHUP, a crash) reports nothing, so the hand
// it was waiting on keeps working for the runner that resumes the run
// (runResume.ts). The run's worktree outlives the hand: the next station
// works in it, and the line releases it (lineTrialBranch.ts). Hands are the
// node sessions nested under the run's own session (runner spawnHand);
// `nodeIds` limits the stop to those stations.
export async function stopStationHands(ctx: Ctx, run: any, nodeIds?: string[]): Promise<number> {
  if (run.run_kind === "workflow" || !run.primary_conversation_id) return 0;
  let stopped = 0;
  for (const node of run.node_statuses ?? []) {
    if (!node.session_id || (nodeIds && !nodeIds.includes(node.node_id))) continue;
    const conv: any = await findConversationByAnyRef(ctx as any, node.session_id, run.user_id);
    if (!conv || conv.inbox_killed_at || String(conv.parent_conversation_id ?? "") !== String(run.primary_conversation_id)) continue;
    await killConversation(ctx, run.user_id, { conversation_id: conv._id, mark_completed: true }, { cause: "station_ended", keepWorkspace: true });
    stopped++;
  }
  return stopped;
}

// A run that ends, however it ends, takes back the question it was waiting
// on: no card stays in the queue, or its notice unread, for a run that is over.
// So does the question a presenting station (a gate's `asker=`) posted for a
// gate that never took it up (its card refused until the run failed): that
// question exists only for the gate, so an answer would drive nothing
// (sd-1072 on ct-61115). What other stations post (a proposal for an
// expectation) is answered on its own and stays.
async function withdrawOpenGate(ctx: Ctx, run: any, now: number): Promise<void> {
  const decision = run.gate_decision_id ? await ctx.db.get(run.gate_decision_id) : null;
  if (decision && decision.status === "pending") await withdrawCore(ctx, decision, now);
  if (!run.primary_conversation_id) return;
  const wf: any = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
  const askers = new Set<string>(((wf?.nodes ?? []) as Array<{ type?: string; asker?: string }>).filter((n) => n.type === "human" && n.asker).map((n) => n.asker!));
  if (!askers.size) return;
  const why = `The run that asked it ${run.status === "failed" && run.fail_reason ? `stopped (${run.fail_reason})` : "ended"} before its gate took the question up, so an answer would drive nothing.`;
  for (const node of run.node_statuses ?? []) {
    if (!node.session_id || !askers.has(node.node_id)) continue;
    const conv: any = await findConversationByAnyRef(ctx as any, node.session_id, run.user_id);
    if (!conv || String(conv.parent_conversation_id ?? "") !== String(run.primary_conversation_id)) continue;
    const open = await ctx.db.query("session_decisions").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conv._id).eq("status", "pending")).collect();
    for (const d of open) if (!d.workflow_run_id) await withdrawCore(ctx, d as any, now, undefined, why);
  }
}

// A run created for a task logs into a session of its own, and nobody talks
// in it: the person meets the run on the task (its status, its blocker
// comment) and in the decision queue (its gates and its card). So that log is
// born stashed and hidden, never a row in the inbox; an ask still brings it
// back (isStashHidden). A run without a task is someone's own workflow and
// stays in their inbox.
function runLogInboxFields(taskBoundAt: number | undefined) {
  return taskBoundAt ? { inbox_stashed_at: taskBoundAt, inbox_stash_hidden: true } : {};
}

// Once, for runs created before runLogInboxFields: stash and hide the log
// session of every task's run that is still a row in someone's inbox.
export const hideTaskRunLogs = internalMutation({
  args: { cursor: v.optional(v.string()), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("workflow_runs").order("desc").paginate({ cursor: args.cursor ?? null, numItems: 200 });
    let hidden = 0;
    for (const run of page.page) {
      if (!run.task_id || !run.primary_conversation_id) continue;
      const log = await ctx.db.get(run.primary_conversation_id);
      if (!log || !log.is_workflow_primary || log.inbox_stashed_at || log.inbox_dismissed_at) continue;
      hidden++;
      if (!args.dry) await ctx.db.patch(log._id, runLogInboxFields(Date.now()));
    }
    return { hidden, cursor: page.isDone ? null : page.continueCursor };
  },
});

export const create = mutation({
  args: {
    workflow_id: v.id("workflows"),
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    goal_override: v.optional(v.string()),
    project_path: v.optional(v.string()),
    existing_conversation_id: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const workflow = await ctx.db.get(args.workflow_id);
    if (!workflow || workflow.user_id !== userId) throw new Error("Not found");
    const refusal = await liveRunRefusal(ctx, args.task_id ? await ctx.db.get(args.task_id) : null);
    if (refusal) throw new Error(refusal);

    const now = Date.now();
    // the-line.md L8: the run lives where its task or plan lives, else where
    // its primary session will (the existing one, or the directory rule).
    const scope = await runScope(ctx, userId, {
      task: args.task_id ? await ctx.db.get(args.task_id) : null,
      plan: args.plan_id ? await ctx.db.get(args.plan_id) : null,
      conversation: args.existing_conversation_id
        ? await ctx.db.get(args.existing_conversation_id)
        : await resolveCreationPrivacy(ctx, userId, args.project_path),
    });
    const runId = await ctx.db.insert("workflow_runs", {
      user_id: userId,
      workflow_id: args.workflow_id,
      task_id: args.task_id,
      plan_id: args.plan_id,
      ...scope,
      status: "pending",
      node_statuses: [],
      goal_override: args.goal_override,
      project_path: args.project_path,
      created_at: now,
      updated_at: now,
    });

    if (args.task_id) {
      const bound = await ctx.db.get(args.task_id);
      if (bound) await moveTaskStatus(ctx, bound, "in_progress", { actorUserId: userId, now, extra: { workflow_run_id: runId } });
    }

    if (args.plan_id) {
      await ctx.db.patch(args.plan_id, {
        workflow_run_id: runId,
        updated_at: now,
      });
    }

    let primaryConvId: any;

    if (args.existing_conversation_id) {
      // A run launched from a person's own session logs into that session.
      // It gets the run POINTER only, never is_workflow_primary or the
      // workflow's name as its title: the flag means "this session is the
      // run's log" (isRunLog), and a run log leaves every list a person
      // browses. The session stays theirs, under its own title.
      const existing = await ctx.db.get(args.existing_conversation_id);
      if (existing && existing.user_id === userId) {
        await ctx.db.patch(args.existing_conversation_id, {
          workflow_run_id: runId,
          updated_at: now,
        });
        primaryConvId = args.existing_conversation_id;
      }
    }

    if (!primaryConvId) {
      const privacy = await resolveCreationPrivacy(ctx, userId, args.project_path);
      primaryConvId = await ctx.db.insert("conversations", {
        user_id: userId,
        agent_type: "claude_code",
        session_id: `wf-${runId}`,
        title: workflow.name,
        project_path: args.project_path,
        started_at: now,
        updated_at: now,
        message_count: 0,
        ...privacy,
        status: "active",
        workflow_run_id: runId,
        is_workflow_primary: true,
        ...runLogInboxFields(args.task_id ? now : undefined),
      });
    }

    await ctx.db.patch(runId, { primary_conversation_id: primaryConvId });

    const existingCount = primaryConvId === args.existing_conversation_id
      ? (((await ctx.db.get(primaryConvId)) as any)?.message_count || 0)
      : 0;

    await ctx.db.insert("messages", {
      conversation_id: primaryConvId,
      role: "assistant",
      content: JSON.stringify({ __wf: "started", goal: args.goal_override || workflow.goal || "", workflow_name: workflow.name }),
      subtype: "workflow_event",
      timestamp: now,
    });

    await ctx.db.patch(primaryConvId, { message_count: existingCount + 1, last_message_role: "assistant" });

    await queueRunOnDaemon(ctx, userId, runId, { now });

    return runId;
  },
});

// Hand a run to a daemon of its owner, which executes it in tmux with
// `cast workflow run-daemon` (daemon.ts run_workflow). `device` pins it to
// one machine (the one that asked, for `cast workflow run --detach`); without
// it the run goes to the machine that holds its checkout, picked the way a
// session start is (deviceRouting.pickOwnerDevice, the spawner's machine as
// the sticky owner). Left to whichever daemon polled first, a cloud host took
// a role's run on a laptop folder it does not have, and every isolated
// station it spawned was parked on itself and prepared from the laptop's
// shared tree (Union's Prove failures, 2026-10-14). `slug` names a shipped
// template for a run with no workflows row (orgLine.startLineRun).
export async function queueRunOnDaemon(
  ctx: Ctx,
  userId: Id<"users">,
  runId: Id<"workflow_runs">,
  opts: { slug?: string; device?: string; now?: number } = {},
): Promise<void> {
  const device = opts.device ?? (await runCheckoutDevice(ctx, userId, runId));
  await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "run_workflow",
    args: JSON.stringify({ workflow_run_id: runId, ...(opts.slug ? { workflow_slug: opts.slug } : {}) }),
    ...(device ? { target_device_id: device } : {}),
    created_at: opts.now ?? Date.now(),
  });
}

async function runCheckoutDevice(ctx: Ctx, userId: Id<"users">, runId: Id<"workflow_runs">): Promise<string | undefined> {
  const run = await ctx.db.get(runId);
  if (!run?.project_path) return undefined;
  const spawner = run.spawner_conversation_id ? await ctx.db.get(run.spawner_conversation_id) : null;
  return (await resolveOwnerDevice(ctx, userId, {
    projectPath: run.project_path,
    gitRoot: spawner?.project_path === run.project_path ? spawner?.git_root : undefined,
    ownerDeviceId: spawner?.owner_device_id ?? null,
  })) ?? undefined;
}

// The one insert shape for a run: the run row, the bound task or plan patched
// to carry it, the primary conversation the run speaks through, and its
// "started" message. createFromCli calls it for a run the CLI executes
// itself; orgLine.startLineRun calls it for a run the sweep hands to the
// daemon (the-line.md L9). One place, so a field added to runs or to the
// primary conversation lands on both paths.
// LE1.4: a run that has not ended. One cause holds at most one of these.
export const LIVE_RUN_STATUSES = ["pending", "running", "paused"] as const;
export const isLiveRunStatus = (status: string | undefined): boolean =>
  (LIVE_RUN_STATUSES as readonly string[]).includes(status ?? "");

// LE1.4: why a task may not get a new run now, or null when it may. The
// task's bound run is the one that speaks for it; a second attempt waits for
// it to end, unless the caller forces it (`cast workflow run --force`).
export async function liveRunRefusal(ctx: Ctx, task: any, force?: boolean): Promise<string | null> {
  if (force || !task?.workflow_run_id) return null;
  const run: any = await ctx.db.get(task.workflow_run_id);
  if (!run || !isLiveRunStatus(run.status)) return null;
  const at = (run.node_statuses ?? []).find((n: any) => n.status === "running")?.node_id;
  return `${task.short_id ?? "this task"} already has a live run (${run._id}, ${run.status}${at ? ` at ${at}` : ""}); one problem holds one run at a time. Wait for it to end, cancel it from its run page, or pass --force to start a second.`;
}

export async function createRunCore(
  ctx: Ctx,
  userId: Id<"users">,
  opts: {
    workflow_name: string;
    workflow_goal?: string;
    workflow_id?: Id<"workflows">;
    task?: any;
    plan?: any;
    goal_override?: string;
    project_path?: string;
    spawner_conversation_id?: Id<"conversations">;
    // The role whose line starts this run (orgLine.startRoleRun).
    org_role_id?: Id<"org_roles">;
    // The team the primary session routes to when no directory rule names
    // one (a role's team, for a run the sweep starts).
    fallback_team_id?: Id<"teams">;
    // Start a run even though the task's bound run is still live (LE1.4).
    force?: boolean;
    // A new line run on a problem proves against unfixed code: the machine sets
    // the problem's earlier branch aside and starts it again from origin/main
    // (cli lineTrialBranch.ts). Its fix stays on the set-aside branch, prior art.
    fresh_branch?: boolean;
    now?: number;
  },
): Promise<{ run_id: Id<"workflow_runs">; primary_conversation_id: Id<"conversations"> }> {
  const now = opts.now ?? Date.now();
  const refusal = await liveRunRefusal(ctx, opts.task, opts.force);
  if (refusal) throw new Error(refusal);
  // the-line.md L8: stamp the workspace (access) and team (routing) at
  // create, from the bound work item or the primary session's privacy.
  const privacy = await resolveCreationPrivacy(ctx, userId, opts.project_path, opts.fallback_team_id);
  const scope = await runScope(ctx, userId, { task: opts.task, plan: opts.plan, conversation: privacy });
  const runId: Id<"workflow_runs"> = await ctx.db.insert("workflow_runs", {
    user_id: userId,
    workflow_id: opts.workflow_id,
    // The name the run started under. When no workflows row backs the run,
    // `cast workflow run-daemon` resolves a shipped template by it (L9).
    workflow_name: opts.workflow_name,
    task_id: opts.task?._id,
    plan_id: opts.plan?._id,
    ...scope,
    ...(opts.spawner_conversation_id ? { spawner_conversation_id: opts.spawner_conversation_id } : {}),
    ...(opts.org_role_id ? { org_role_id: opts.org_role_id } : {}),
    status: "pending",
    node_statuses: [],
    goal_override: opts.goal_override,
    project_path: opts.project_path,
    ...(opts.fresh_branch && opts.task ? { fresh_branch: true } : {}),
    ...(await runFlowVersions(ctx, opts.workflow_id)),
    created_at: now,
    updated_at: now,
  });

  if (opts.task?.project_id) {
    const project = await ctx.db.get(opts.task.project_id);
    if (project?.line_trial) await openRunPrice(ctx, runId, project._id, now);
  }
  if (opts.task) {
    await moveTaskStatus(ctx, opts.task, "in_progress", { actorUserId: userId, now, extra: { workflow_run_id: runId } });
  }
  if (opts.plan) {
    await ctx.db.patch(opts.plan._id, { workflow_run_id: runId, updated_at: now });
  }

  const primaryConvId: Id<"conversations"> = await ctx.db.insert("conversations", {
    user_id: userId,
    agent_type: "claude_code",
    session_id: `wf-${runId}`,
    title: opts.workflow_name,
    project_path: opts.project_path,
    started_at: now,
    updated_at: now,
    message_count: 0,
    ...privacy,
    status: "active",
    workflow_run_id: runId,
    is_workflow_primary: true,
    ...runLogInboxFields(opts.task ? now : undefined),
  });

  await ctx.db.patch(runId, { primary_conversation_id: primaryConvId });

  await ctx.db.insert("messages", {
    conversation_id: primaryConvId,
    role: "assistant",
    content: JSON.stringify({ __wf: "started", goal: opts.goal_override || opts.workflow_goal || "", workflow_name: opts.workflow_name }),
    subtype: "workflow_event",
    timestamp: now,
  });

  await ctx.db.patch(primaryConvId, { message_count: 1, last_message_role: "assistant" });

  return { run_id: runId, primary_conversation_id: primaryConvId };
}

// A run started from outside any session (a product's own planner calling
// `cast workflow run --detach`) runs as the lead of its cause's project, the
// way the sweep's runs do (orgLine.startLineRun): its gates climb that role's
// ladder to the person who answers for the project (line-profile.md LP6).
// Without it the card asks nobody.
export async function projectLeadSession(ctx: Ctx, task: any): Promise<any | null> {
  const lead = await projectLeadRole(ctx, task);
  const anchor = lead?.anchor_id ? await ctx.db.get(lead.anchor_id) : null;
  return (anchor as any)?.conversation_id ? await ctx.db.get((anchor as any).conversation_id) : null;
}

export const createFromCli = mutation({
  args: {
    api_token: v.string(),
    workflow_name: v.string(),
    workflow_goal: v.optional(v.string()),
    workflow_id: v.optional(v.string()),
    task_id: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    goal_override: v.optional(v.string()),
    project_path: v.optional(v.string()),
    // Any ref to one of the caller's sessions (see findConversationByAnyRef).
    spawner_session: v.optional(v.string()),
    force: v.optional(v.boolean()),
    // Execute on this machine's daemon instead of in the calling process
    // (`cast workflow run --detach`), so a caller that cannot wait (a backend
    // over a remote exec) still starts a full run. `run_on_device` is the
    // caller's own device id, so no other machine of the account takes it.
    detach: v.optional(v.boolean()),
    run_on_device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) throw new Error("Unauthorized");
    const userId = result.userId;

    const now = Date.now();
    const taskRow: any = args.task_id
      ? await ctx.db.query("tasks").withIndex("by_short_id", q => q.eq("short_id", args.task_id!)).first()
      : null;
    const spawner = args.spawner_session
      ? await findConversationByAnyRef(ctx, args.spawner_session, userId)
      : await projectLeadSession(ctx, taskRow);
    const planRow: any = args.plan_id
      ? await ctx.db.query("plans").withIndex("by_short_id", q => q.eq("short_id", args.plan_id!)).first()
      : null;

    // Resolve workflow_id — either passed directly or look up by name
    let workflowDocId: any = args.workflow_id ? (args.workflow_id as any) : undefined;
    let workflowName = args.workflow_name;
    // A line run the daemon executes takes the problem's line version
    // (workflows.lineRouteFor); a run in the calling process runs the graph
    // that process already chose (cast workflow run asks for the version first).
    const route = args.detach && isLineRunSlug(args.workflow_name) ? await lineRouteFor(ctx, userId, taskRow) : null;
    if (route?.waiting) throw new Error(`${taskRow?.short_id ?? "this problem"} waits: ${route.waiting} in its team's live flow`);
    const version = route?.workflow ?? null;
    if (version) { workflowDocId = version._id; workflowName = version.name; }
    if (!workflowDocId) {
      const wf = await ctx.db.query("workflows")
        .withIndex("by_user_id", q => q.eq("user_id", userId))
        .collect();
      const match = wf.find(w => w.name === args.workflow_name);
      if (match) workflowDocId = match._id;
    }
    // A line run: the shipped line or a role's, or a line version (one that serves a scenario).
    const lineRun = isLineRunSlug(args.workflow_name) || !!((workflowDocId ? await ctx.db.get(workflowDocId) : null) as any)?.serves?.length;

    // A detached line run on a problem whose role's runs work on a pool of
    // machines takes the sweep's admission (the-line-end-to-end.md LE6): the
    // pool machine with the most free runs, in its checkout, never the asking
    // machine. With the pool full nothing starts, and the problem goes back to
    // the line's queue for the sweep to start in rank order.
    const lead = args.detach && lineRun && taskRow ? await projectLeadRole(ctx, taskRow) : null;
    const room = lead ? await admitRoleRun(ctx, lead, now) : null;
    const pooled = room?.pooled && room.runner === String(userId) ? room : null;
    if (pooled && "waiting" in pooled) {
      const refusal = await liveRunRefusal(ctx, taskRow, args.force);
      if (refusal) throw new Error(refusal);
      return { run_id: null, queued: await requeueForSweep(ctx, lead, taskRow, userId, now, pooled.waiting), primary_conversation_id: null, spawner_conversation_id: null };
    }
    const place = pooled && "place" in pooled ? pooled.place : undefined;

    const { run_id, primary_conversation_id } = await createRunCore(ctx, userId, {
      workflow_name: workflowName,
      workflow_goal: args.workflow_goal,
      workflow_id: workflowDocId || undefined,
      task: taskRow,
      plan: planRow,
      goal_override: args.goal_override,
      project_path: place?.project_path ?? args.project_path,
      spawner_conversation_id: spawner?._id,
      ...(place ? { org_role_id: lead._id } : {}),
      force: args.force,
      fresh_branch: args.detach && lineRun,
      now,
    });
    // A placed run names its machine from the start, so the pool counts it there before a runner claims it.
    if (place) await ctx.db.patch(run_id, { runner_device: place.device });
    if (args.detach) await queueRunOnDaemon(ctx, userId, run_id, { device: place?.device ?? args.run_on_device, ...(version ? { slug: version.slug } : {}), now });
    // The session the run speaks as, resolved here when the caller had none,
    // so a runner in the foreground asks its failure decisions through it.
    return { run_id, primary_conversation_id, spawner_conversation_id: spawner?._id ?? null, ...(place ? { runner_device: place.device } : {}) };
  },
});

// Attach each agent's synced conversation to its node status so run UIs can render
// a clickable session list. The daemon uploads per-agent transcripts
// (<session>/subagents/workflows/<wf_id>/agent-<id>.jsonl) as conversations keyed
// session_id="agent-<id>", so dynamic-workflow nodes resolve deterministically even on
// runs ingested before session_id stamping; routine/graph nodes carry a real session_id
// already. `budget` caps conversation lookups so list queries stay bounded — runs are
// enriched most-recent-first and older ones degrade to plain (non-clickable) rows.
/** `cast task handoff`'s comment (taskClaim.handoffCommentText): "Handoff: <status>", a blank line, the evidence. */
const HANDOFF_COMMENT = /^Handoff: (\w+)\s*\n?([\s\S]*)$/;

/** Each station session's last handoff on the run's task, by conversation id:
 *  how a builder ended (done, blocked, needs_context) is its handoff, which
 *  lives on the task, not on the session. */
async function handoffsByConversation(ctx: any, run: any, budget: { reads: number }): Promise<Map<string, { status: string; note: string; at: number }>> {
  const out = new Map<string, { status: string; note: string; at: number }>();
  if (!run.task_id || !run.node_statuses.some((n: any) => n.session_id) || budget.reads <= 0) return out;
  budget.reads--;
  const comments = await ctx.db.query("task_comments")
    .withIndex("by_task_created", (q: any) => q.eq("task_id", run.task_id))
    .order("desc")
    .take(200);
  for (const c of comments) {
    const m = c.conversation_id && c.comment_type === "review" ? String(c.text ?? "").match(HANDOFF_COMMENT) : null;
    // The note is what a person reads in place of the station's last line (the evidence, what it tried, what it needs):
    // kept whole up to a page, never cut mid-thought at a preview's length.
    if (m && !out.has(String(c.conversation_id))) out.set(String(c.conversation_id), { status: m[1], note: m[2].trim().slice(0, 4000), at: c.created_at });
  }
  return out;
}

export async function withAgentSessions(ctx: any, run: any, budget = { reads: 200 }) {
  if (!run?.node_statuses?.length) return run;
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const handoffs = await handoffsByConversation(ctx, run, budget);
  const node_statuses = await Promise.all(run.node_statuses.map(async (node: any) => {
    const sessionId = node.session_id
      || (run.run_kind === "workflow" && node.node_id ? `agent-${node.node_id}` : null);
    if (!sessionId || budget.reads <= 0) return node;
    budget.reads--;
    // A line station's node carries its hand's short id (runner spawnHand), a
    // dynamic workflow's agent its session id: any ref resolves, the run's own user's only.
    const conv: any = await findConversationByAnyRef(ctx, sessionId, run.user_id);
    if (!conv) return node;
    const handoff = handoffs.get(String(conv._id));
    return {
      ...node,
      session: {
        _id: conv._id,
        session_id: conv.session_id,
        title: conv.title || conv.subtitle,
        project_path: conv.project_path,
        message_count: conv.message_count || 0,
        is_active: conv.status === "active" && (conv.updated_at || 0) > fiveMinutesAgo,
        started_at: conv.started_at || conv._creationTime,
        updated_at: conv.updated_at,
        agent_type: conv.agent_type,
        parent_conversation_id: conv.parent_conversation_id,
        // What the station reported (`cast state`): the run report words a
        // station by its own report, not by its node id.
        state: conv.thread_state,
        state_status: conv.thread_state_status,
        result: conv.thread_state_result,
        // What happened to it: killed (with no message, it never started) and how it handed off.
        ...(conv.inbox_killed_at ? { killed: true } : {}),
        ...(handoff ? { handoff } : {}),
      },
    };
  }));
  return { ...run, node_statuses };
}

export const listForWorkflow = query({
  args: { workflow_id: v.id("workflows") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    // Gate on the parent workflow's owner — without this, any authenticated
    // user who guessed a workflow id could read another user's run history.
    const workflow = await ctx.db.get(args.workflow_id);
    if (!workflow || workflow.user_id !== userId) return [];
    const runs = await ctx.db
      .query("workflow_runs")
      .withIndex("by_workflow_id", (q) => q.eq("workflow_id", args.workflow_id))
      .order("desc")
      .take(20);
    // Every feed that writes a run row carries its node sessions: the web
    // overlays all feeds on one collection, so a plain row from here would
    // strip the sessions the detail query attached. Newest runs first.
    const budget = { reads: 200 };
    return await Promise.all(runs.map((r) => withAgentSessions(ctx, r, budget)));
  },
});

export const get = query({
  args: { id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const run = await ctx.db.get(args.id);
    // the-line.md L8: a teammate who can read the run's workspace reads the run.
    if (!run || !(await canReadRun(ctx, userId, run))) return null;
    return await enrichRun(ctx, await withAgentSessions(ctx, run));
  },
});

// Web: list the user's dynamic-workflow runs (run_kind=workflow) for the dashboard.
export const listDynamicRuns = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const runs = await ctx.db
      .query("workflow_runs")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(50);
    // Shared budget: newest runs claim lookups first (runs are already desc).
    const budget = { reads: 300 };
    return await Promise.all(
      runs.filter((r) => r.run_kind === "workflow").map((r) => withAgentSessions(ctx, r, budget))
    );
  },
});

// Look up a run by the runtime's external id (wf_<id>). Used to confirm ingest
// and by the dashboard to resolve a run referenced from a conversation event.
export const getByExternalRun = query({
  args: { api_token: v.string(), external_run_id: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return null;
    const run = await ctx.db
      .query("workflow_runs")
      .withIndex("by_external_run", (q) => q.eq("external_run_id", args.external_run_id))
      .first();
    if (!run || run.user_id !== auth.userId) return null;
    return await withAgentSessions(ctx, run);
  },
});

// Web: same lookup with session auth. The inline Workflow tool card only knows the
// runtime's wf_<id> (parsed from the tool result), not the convex document id.
export const getByExternalRunForUser = query({
  args: { external_run_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const run = await ctx.db
      .query("workflow_runs")
      .withIndex("by_external_run", (q) => q.eq("external_run_id", args.external_run_id))
      .first();
    if (!run || run.user_id !== userId) return null;
    return await withAgentSessions(ctx, run);
  },
});

export const respondToGate = mutation({
  args: {
    id: v.id("workflow_runs"),
    response: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const run = await ctx.db.get(args.id);
    if (!run || !(await canReadRun(ctx, userId, run))) throw new Error("Not found");
    if (run.status !== "paused") throw new Error("Not paused");

    const now = Date.now();
    // the-line.md L4: the response answers the gate's decision.
    const answered = await answerGateCore(ctx, run, args.response, { kind: "user", id: String(userId), user_id: userId });
    if ("error" in answered) throw new Error(answered.error);

    // Post the human's response as a user message to the primary conversation
    if (run.primary_conversation_id) {
      const primaryConv = await ctx.db.get(run.primary_conversation_id);
      if (primaryConv) {
        await ctx.db.insert("messages", {
          conversation_id: run.primary_conversation_id,
          role: "user",
          content: args.response,
          timestamp: now,
        });
        await ctx.db.patch(run.primary_conversation_id, {
          message_count: (primaryConv.message_count || 0) + 1,
          updated_at: now,
          last_message_role: "user",
        });
      }
    }
  },
});

export const respondToGateFromCli = mutation({
  args: { api_token: v.string(), run_id: v.id("workflow_runs"), response: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const run = await ctx.db.get(args.run_id);
    if (!run || !(await canReadRun(ctx, auth.userId, run))) return { error: "Not found" };
    // the-line.md L4: the same answer path as the run panel.
    return answerGateCore(ctx, run, args.response, { kind: "user", id: String(auth.userId), user_id: auth.userId });
  },
});

export const getForDaemon = mutation({
  args: { api_token: v.string(), run_id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    const workflow = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;

    let taskShortId: string | undefined;
    if (run.task_id) {
      const task = await ctx.db.get(run.task_id);
      if (task) taskShortId = task.short_id;
    }
    let planShortId: string | undefined;
    if (run.plan_id) {
      const plan = await ctx.db.get(run.plan_id);
      if (plan) planShortId = plan.short_id;
    }

    // A trial run's gate asks nobody: its card waiting at the gate is what a resumed runner waits on (cli runResume.ts), as a decision is elsewhere.
    const gateCard = run.status === "paused" && run.gate_node_id
      ? ((await ctx.db.query("trial_cards").withIndex("by_run", (q: any) => q.eq("run_id", run._id)).collect()) as any[]).find((c) => c.node_id === run.gate_node_id && c.status === "waiting")?.short_id ?? null
      : null;

    const gateAnswer = run.gate_response && run.gate_decision_id ? answeredOptionLabel(await ctx.db.get(run.gate_decision_id)) : undefined;
    return {
      run: { ...run, task_short_id: taskShortId, plan_short_id: planShortId, gate_card: gateCard, ...(gateAnswer ? { gate_answer: gateAnswer } : {}) },
      workflow: workflow ? { ...workflow, ...(await libraryOfRun(ctx, run)) } : { name: "workflow", goal: run.goal_override, nodes: [], edges: [] },
    };
  },
});

export const updateProgress = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
    current_node_id: v.string(),
    node_id: v.string(),
    node_status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    outcome: v.optional(v.string()),
    session_id: v.optional(v.string()),
    run_status: v.optional(v.union(v.literal("running"), v.literal("completed"), v.literal("failed"))),
    fail_reason: v.optional(v.string()),
    // the-line.md L7: a chain step's output head, shown on the run's node.
    result_preview: v.optional(v.string()),

    // LE14: the runner's hash of the graph it executes, sent on its first report.
    graph_hash: v.optional(v.string()),
    // LE14: each station's own hash in that graph (parser.graphNodeHashes).
    graph_nodes: v.optional(v.array(v.object({ id: v.string(), h: v.string() }))),
    // The machine driving the run, sent when a runner takes it (runResume.ts).
    runner_device: v.optional(v.string()),
    // What a call node cost (learning-loop.md LL1, LL10).
    cost_usd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    const now = Date.now();
    if (args.graph_hash) await recordRoutineRunGraph(ctx, run, args.graph_hash, now);
    const nodeStatuses = [...run.node_statuses];
    const existing = nodeStatuses.findIndex((n) => n.node_id === args.node_id);
    const prev = existing >= 0 ? nodeStatuses[existing] : undefined;
    const nodeEntry = {
      node_id: args.node_id,
      status: args.node_status,
      outcome: args.outcome,
      session_id: args.session_id ?? prev?.session_id,
      result_preview: args.result_preview ?? prev?.result_preview,
      ...(args.cost_usd !== undefined || prev?.cost_usd !== undefined ? { cost_usd: (prev?.cost_usd ?? 0) + (args.cost_usd ?? 0) } : {}),
      started_at: args.node_status === "running" ? now : (prev?.started_at ?? now),
      completed_at: args.node_status !== "running" ? now : undefined,
    };

    if (existing >= 0) {
      nodeStatuses[existing] = nodeEntry;
    } else {
      nodeStatuses.push(nodeEntry);
    }

    await ctx.db.patch(args.run_id, {
      current_node_id: args.current_node_id,
      node_statuses: nodeStatuses,
      status: args.run_status ?? run.status,
      // A run a cancel already ended keeps why: its runner, finding the gate gone, reports a failure of its own after it ("no outgoing edge from decide").
      fail_reason: run.status === "failed" && run.fail_reason && args.run_status === "failed" ? run.fail_reason : args.fail_reason,
      ...(args.graph_hash ? { graph_hash: args.graph_hash } : {}),
      ...(args.graph_nodes?.length ? { graph_nodes: args.graph_nodes } : {}),
      ...(args.runner_device ? { runner_device: args.runner_device } : {}),
      updated_at: now,
    });

    // Link the session conversation to this workflow run
    if (args.session_id) {
      const sessionId = args.session_id;
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
        .first();
      if (conv) {
        const isFirst = !run.primary_session_id;
        await ctx.db.patch(conv._id, {
          workflow_run_id: args.run_id,
          is_workflow_sub: !isFirst,
        });
        if (isFirst) {
          await ctx.db.patch(args.run_id, {
            primary_session_id: sessionId,
            updated_at: now,
          });
        }
      }
    }

    // A runner that reports its run over (a signal while it waits at a gate)
    // leaves no open gate behind. The run is already patched past its pause,
    // so the withdraw keeps this report's fail_reason.
    if (args.run_status === "completed" || args.run_status === "failed") await withdrawOpenGate(ctx, { ...run, node_statuses: nodeStatuses, status: args.run_status, fail_reason: args.fail_reason ?? run.fail_reason }, now);
    const runOver = args.run_status === "completed" || args.run_status === "failed";
    if (runOver || args.node_status !== "running") {
      await stopStationHands(ctx, { ...run, node_statuses: nodeStatuses }, runOver ? undefined : [args.node_id]);
    }

    // Sync status to bound task/plan
    if (args.run_status) {
      const taskId = (run as any).task_id;
      const planId = (run as any).plan_id;

      if (taskId) await settleRunTask(ctx, { ...run, node_statuses: nodeStatuses }, args.run_status, args.fail_reason, now);

      if (planId) {
        const planUpdates: Record<string, any> = { updated_at: now };
        if (args.run_status === "completed") {
          const entries = ((await ctx.db.get(planId)) as any)?.entries || [];
          entries.push({ type: "progress", timestamp: now, content: "Workflow run completed" });
          planUpdates.entries = entries;
        }
        await ctx.db.patch(planId, planUpdates);
      }
    }

    // Post progress message to primary conversation
    if (run.primary_conversation_id && args.node_id !== "start") {
      const primaryConv = await ctx.db.get(run.primary_conversation_id);
      if (primaryConv) {
        const workflow = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
        const nodeInfo = workflow?.nodes?.find((n: any) => n.id === args.node_id);
        const nodeLabel = nodeInfo?.label ?? args.node_id;
        const nodeType = nodeInfo?.type ?? "agent";
        const wfType = args.node_status === "running" ? "node_start"
          : args.node_status === "completed" ? "node_done"
          : "node_failed";
        await ctx.db.insert("messages", {
          conversation_id: run.primary_conversation_id,
          role: "assistant",
          content: JSON.stringify({ __wf: wfType, node_id: args.node_id, node_label: nodeLabel, node_type: nodeType, session_id: args.session_id }),
          subtype: "workflow_event",
          timestamp: now,
        });
        const newCount = (primaryConv.message_count || 0) + 1;
        await ctx.db.patch(run.primary_conversation_id, {
          message_count: newCount,
          updated_at: now,
          last_message_role: "assistant",
          // Mark completed when workflow finishes
          ...(args.run_status === "completed" || args.run_status === "failed" ? { status: "completed" as const } : {}),
        });
      }
    }

    return { ok: true };
  },
});

// Ingest a dynamic-workflow (Anthropic) run from the runtime's on-disk snapshot
// (<session>/workflows/wf_<id>.json). Upserts by external_run_id so the daemon can
// re-post on every snapshot change. run_kind="workflow" distinguishes these from our
// routine/DOT-graph runs, which share this table and the existing run UI.
const INGEST_LIVE_STATUSES = new Set<string>(LIVE_RUN_STATUSES);
export function ingestRunStatus(status: string): "pending" | "running" | "paused" | "completed" | "failed" {
  if (INGEST_LIVE_STATUSES.has(status) || status === "completed") return status as "pending" | "running" | "paused" | "completed";
  return "failed";
}

export const ingestSnapshot = mutation({
  args: ingestSnapshotArgs,
  handler: async (ctx, { graph, ...args }) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const now = Date.now();

    // The runtime's own vocabulary is wider than ours: a stopped run (TaskStop,
    // Esc, its host exiting) snapshots as "killed". Anything we don't know is
    // a run that is OVER, never one that is running, or its bar and the host
    // card's "waiting on the fleet" stay up forever. A stop lands the way
    // cancelCore records one: failed, with the reason.
    const runStatus = ingestRunStatus(args.status);
    const failReason = runStatus === "failed" && args.status !== "failed" ? "Stopped" : undefined;
    const agentStatus = (s: string) =>
      s === "done" ? "completed"
      : s === "error" || s === "failed" ? "failed"
      : s === "running" ? "running"
      : "pending";

    const node_statuses = args.agents.map((a) => {
      const st = agentStatus(a.state) as "pending" | "running" | "completed" | "failed";
      return {
        node_id: a.agent_id,
        status: st,
        // The runtime writes each agent's transcript as agent-<agentId>.jsonl, which the
        // daemon syncs as a conversation with that filename as its session_id.
        session_id: `agent-${a.agent_id}`,
        label: a.label,
        phase: a.phase,
        tokens: a.tokens,
        result_preview: a.result_preview,
        activity: a.last_tool_summary || a.last_tool_name,
        started_at: a.started_at,
        completed_at: st === "completed" || st === "failed"
          ? (a.started_at && a.duration_ms ? a.started_at + a.duration_ms : now)
          : undefined,
      };
    });

    const existing = await ctx.db
      .query("workflow_runs")
      .withIndex("by_external_run", (q) => q.eq("external_run_id", args.external_run_id))
      .first();
    if (existing && existing.user_id !== auth.userId) return { error: "Forbidden" };

    // Link the run to the host session's conversation so it shows inline + in the dash
    let primaryConvId = existing?.primary_conversation_id;
    if (!primaryConvId) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
        .first();
      if (conv && conv.user_id === auth.userId) primaryConvId = conv._id;
    }

    const isTerminal = runStatus === "completed" || runStatus === "failed";

    const fields = {
      run_kind: "workflow" as const,
      external_run_id: args.external_run_id,
      workflow_name: args.workflow_name,
      status: runStatus,
      node_statuses,
      phases: args.phases,
      total_tokens: args.total_tokens,
      agent_count: args.agent_count ?? args.agents.length,
      project_path: args.project_path,
      primary_session_id: args.session_id,
      primary_conversation_id: primaryConvId,
      // Undefined unsets it, so a stopped run that is resumed sheds the reason.
      fail_reason: failReason,
      updated_at: now,
    };

    let runId: Id<"workflow_runs">;
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      runId = existing._id;
    } else {
      // the-line.md L8: the run lives where its host session lives.
      const hostConv = primaryConvId ? await ctx.db.get(primaryConvId) : null;
      const scope = await runScope(ctx, auth.userId, { conversation: hostConv });
      runId = await ctx.db.insert("workflow_runs", {
        user_id: auth.userId,
        ...fields,
        ...scope,
        created_at: now,
      });
      // Post one inline anchor message so the run shows in its host conversation.
      // The card reads live run state by run_id, so we post once (on creation), not per update.
      if (primaryConvId) {
        const conv = await ctx.db.get(primaryConvId);
        if (conv) {
          await ctx.db.insert("messages", {
            conversation_id: primaryConvId,
            role: "assistant",
            content: JSON.stringify({ __wf: "workflow_run", run_id: runId, external_run_id: args.external_run_id, name: args.workflow_name }),
            subtype: "workflow_event",
            timestamp: now,
          });
          await ctx.db.patch(primaryConvId, {
            message_count: (conv.message_count || 0) + 1,
            updated_at: now,
            last_message_role: "assistant",
          });
        }
      }
    }
    await recordScriptRunGraph(ctx, runId, existing, graph, now);
    // Stamp the host conversation with its current run, the same link the DOT
    // path writes in updateProgress. This is what feeds the inbox row's
    // workflow_run_status enrichment — without it a session running a workflow
    // has no card-level "workflow running" signal at all. A live run always
    // claims the pointer (a session runs its waves one after another; the
    // newest live run is the current one); a terminal snapshot only claims it
    // when nothing is stamped yet, so a finished wave's final re-post can't
    // steal the pointer back from the wave that's running now.
    //
    // The pointer only, never is_workflow_primary: a dynamic run's host is a
    // person's own session that called the Workflow tool mid-conversation, not
    // a log the line opened for the run (those are born with the flag, in
    // create/createFromCli, with a wf-<runId> session_id). The flag says "this
    // session IS the run's log", and claiming it for a real session took its
    // composer away for a RunLogEndedBar the moment the run ended, hid its card
    // from the inbox with the task run logs, and barred it from hosting a
    // decision discussion.
    if (primaryConvId) {
      const conv = await ctx.db.get(primaryConvId);
      if (conv && conv.workflow_run_id !== runId && (!isTerminal || !conv.workflow_run_id)) {
        await ctx.db.patch(primaryConvId, { workflow_run_id: runId });
      }
    }
    return { ok: true, run_id: runId };
  },
});

export const setPrimarySession = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
    primary_session_id: v.string(),
    tmux_session: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };
    await ctx.db.patch(args.run_id, {
      primary_session_id: args.primary_session_id,
      tmux_session: args.tmux_session,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

// the-line.md L4: a gate is a decision. See pauseAtGateCore.
// Repair: a paused run whose gate asked nobody (its ask failed) is asked
// again from the prompt and choices the run stored. The runner waiting on it
// picks the answer up through poll-gate as usual.
export const reaskGate = internalMutation({
  args: { run_id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const run: any = await ctx.db.get(args.run_id);
    if (!run || run.status !== "paused" || run.gate_decision_id || !run.gate_prompt) return { error: "not a paused run with an unasked gate" };
    return pauseAtGateCore(ctx, { userId: run.user_id }, {
      run_id: args.run_id,
      node_id: run.gate_node_id ?? run.current_node_id,
      prompt: run.gate_prompt,
      choices: run.gate_choices ?? [],
    });
  },
});

export const pauseAtGate = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
    node_id: v.string(),
    prompt: v.string(),
    choices: v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()), target: v.string() })),
    doc_md: v.optional(v.string()),
    category: v.optional(v.string()),
    stack: v.optional(v.string()),
    card: v.optional(v.any()),
    /** The proposal gate's card (shared/contracts/proposalCard): a trial card carries it; the decision rail does not read it yet. */
    proposal: v.optional(v.any()),
    /** The judge route's card (shared/contracts/judgeFix) for the project's reviewer: a trial card carries it; the decision rail does not read it yet. */
    judge_fix: v.optional(v.any()),
    /** The session of the station the gate names (`asker=`): the gate takes the card it posted, and asks nothing of its own. */
    asker_session_id: v.optional(v.string()),
    /** The station the gate names (`asker=`), sent even before it ran: a gate with a presenter never asks a question of its own. */
    asker: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const { api_token: _t, ...rest } = args;
    return pauseAtGateCore(ctx, auth, rest);
  },
});

export const pollGateResponse = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    // A key picked with no note still carries its option's words to the next hand (runResume withOptionWords).
    const answer = run.gate_response && run.gate_decision_id ? answeredOptionLabel(await ctx.db.get(run.gate_decision_id)) : undefined;
    return {
      status: run.status,
      gate_response: run.gate_response ?? null,
      ...(answer ? { gate_answer: answer } : {}),
    };
  },
});

// The live runs a machine drives (runner_device), for its daemon's sweep:
// one whose runner is gone there is resumed where it stands (cli runResume.ts).
export const liveRunsForDevice = mutation({
  args: { api_token: v.string(), device: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const runs = [];
    for (const status of ["running", "paused"] as const) {
      const rows = await ctx.db.query("workflow_runs")
        .withIndex("by_runner_device_status", (q) => q.eq("runner_device", args.device).eq("status", status))
        .take(100);
      runs.push(...rows.filter((r) => r.user_id === auth.userId).map((r) => ({ run_id: r._id, status: r.status, current_node_id: r.current_node_id ?? null, updated_at: r.updated_at })));
    }
    const failed = await failStrandedPendingRuns(ctx, auth.userId, Date.now());
    return { runs, failed };
  },
});

// A pending run is waiting for a machine to start it. Once a daemon has taken
// its run_workflow command, a runner claims it within seconds; one still
// pending ten minutes later has no runner and never will (its pane died before
// the runner claimed it, or a second launch of the same command killed the
// first). Left alone it sat pending for hours: off the Failed list, holding a
// live-run slot. It fails here, named, so it can be rerun. A run whose command
// no machine has taken yet (the machine is offline) stays pending.
export const STRANDED_PENDING_MS = 10 * 60_000;
export async function failStrandedPendingRuns(ctx: Ctx, userId: Id<"users">, now: number): Promise<string[]> {
  const stale = (await ctx.db.query("workflow_runs").withIndex("by_status", (q: any) => q.eq("status", "pending")).take(200))
    .filter((r: any) => r.user_id === userId && now - r.updated_at > STRANDED_PENDING_MS);
  const failed: string[] = [];
  for (const run of stale) {
    // The run's command is queued with the run, so it executed after the run was created.
    const commands = await ctx.db.query("daemon_commands")
      .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).gte("executed_at", run.created_at))
      .take(500);
    const taken = commands.some((c: any) => {
      if (c.command !== "run_workflow" || !c.args) return false;
      try { return String(JSON.parse(c.args).workflow_run_id) === String(run._id); } catch { return false; }
    });
    if (!taken) continue;
    await cancelCore(ctx, run, now, `No runner started it: a machine took the run ${Math.round((now - run.updated_at) / 60_000)} minutes ago and nothing claimed it. Rerun it.`);
    failed.push(String(run._id));
  }
  return failed;
}

// The machine a run is resumed on: the one whose runner drove it, else (a run
// from before runners named their machine) the one its last station ran on,
// since an isolated station's worktree lives there.
async function runMachine(ctx: Ctx, run: any): Promise<string | undefined> {
  if (run.runner_device) return run.runner_device;
  const withSession = [...(run.node_statuses ?? [])].reverse().find((n: any) => n.session_id);
  if (!withSession) return undefined;
  const conv = await findConversationByAnyRef(ctx, withSession.session_id, run.user_id);
  return (conv as any)?.owner_device_id ?? undefined;
}

// A run whose runner died continues where it stands (cli runResume.ts): its
// machine's daemon runs `cast workflow run-daemon`, which resumes a mid-run
// row, keeping every station's work and every gate's answer. The run's owner
// asks, like cancel.
export async function resumeRunCore(ctx: Ctx, userId: Id<"users">, runId: Id<"workflow_runs">): Promise<{ ok: true }> {
  const run = await ctx.db.get(runId);
  if (!run || !(await canReadRun(ctx, userId, run))) throw new ConvexError("Run not found");
  if (!(await canCancelRun(ctx, userId, run))) throw new ConvexError("Only the run's owner can resume it");
  if (run.status !== "running" && run.status !== "paused") throw new ConvexError(`The run is ${run.status}: nothing to resume`);
  const now = Date.now();
  await queueRunOnDaemon(ctx, run.user_id, run._id, { device: await runMachine(ctx, run), now });
  await ctx.db.patch(run._id, { resume_requested_at: now, updated_at: now });
  return { ok: true };
}
/**
 * A run goes back to `node` and its machine's daemon drives it from there, keeping what it made. Nothing it asked
 * stays on the row, a problem its failure blocked is unblocked, and `fresh_branch` has the machine read the line's
 * graph as it is now. A decision the run waited on is the caller's to settle after, once the run no longer waits on it.
 */
export async function resumeRunAt(ctx: Ctx, userId: Id<"users">, run: Doc<"workflow_runs">, node: string, now: number, opts: { newAttempt?: boolean } = {}): Promise<void> {
  await ctx.db.patch(run._id, { status: "running", current_node_id: node, fail_reason: undefined, fresh_branch: true, gate_node_id: undefined, gate_prompt: undefined, gate_choices: undefined, gate_response: undefined, gate_decision_id: undefined, resume_queued: undefined, ...(opts.newAttempt ? { visits_reset_at: now } : {}), updated_at: now });
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  if (task?.execution_status === "blocked") await patchTask(ctx, task, { execution_status: undefined, execution_concerns: undefined });
  await queueRunOnDaemon(ctx, userId, run._id, { device: run.runner_device!, now });
}

/**
 * `cast workflow reask`: the decision a run put to a person is asked again by the stations as they are now. The run
 * waits at a gate, or it failed while standing at one (its question went with it). It picks up at `at`, else at the
 * station that asks the gate (`asker`, read from the graph by the CLI, which also stops the old runner), else at the
 * gate itself; the old decision is withdrawn once the run no longer waits on it, so it reads as replaced and the
 * withdrawal cannot fail the run. A trial run is asked again under its budget (lineTrial.rerunCore). The owner asks.
 */
export async function reaskRunCore(ctx: Ctx, userId: Id<"users">, runId: Id<"workflow_runs">, opts: { at?: string; asker?: string; check?: boolean } = {}, now = Date.now()) {
  const run = await ctx.db.get(runId);
  if (!run || !(await canReadRun(ctx, userId, run))) throw new ConvexError("Run not found");
  if (String(run.user_id) !== String(userId)) throw new ConvexError("Only the run's owner asks its decision again");
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  if (task && isTerminalTaskStatus(task.status)) throw new ConvexError(`${task.short_id} is ${task.status}: a closed problem is not asked again`);
  if (task && (await trialProjectOf(ctx, task))) throw new ConvexError(`${task.short_id} is a trial problem: cast flow trial rerun ${task.short_id} --reask asks it again under the trial's budget`);
  const wf = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
  const isGate = (id?: string) => !!id && ((wf as any)?.nodes ?? []).some((n: { id?: string; type?: string }) => n.id === id && n.type === "human");
  const gate = run.status === "paused" ? run.gate_node_id : run.status === "failed" && isGate(run.current_node_id) ? run.current_node_id : undefined;
  if (!gate) throw new ConvexError(`The run is ${run.status}${run.current_node_id ? ` at ${run.current_node_id}` : ""}: it is not waiting on a decision, and did not end at one`);
  if (!run.runner_device) throw new ConvexError("The run names no machine to pick it up");
  const asked = run.gate_decision_id ? await ctx.db.get(run.gate_decision_id) : null;
  const node = opts.at?.trim() || opts.asker?.trim() || gate;
  // `check`: every refusal above, and nothing written, so the CLI stops the old runner only for a run that will move.
  if (opts.check) return { run_id: run._id, task: task?.short_id ?? null, resumed_at: node, replaced: null as string | null };
  await resumeRunAt(ctx, userId, run, node, now);
  if (asked?.status === "pending") await withdrawCore(ctx, asked as any, now);
  return { run_id: run._id, task: task?.short_id ?? null, resumed_at: node, replaced: asked?.status === "pending" ? asked.short_id ?? null : null };
}

export const reaskFromCli = mutation({
  args: { api_token: v.string(), run_id: v.id("workflow_runs"), at: v.optional(v.string()), asker: v.optional(v.string()), check: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    return reaskRunCore(ctx, auth.userId, args.run_id, { at: args.at, asker: args.asker, check: args.check });
  },
});

/**
 * `cast workflow resume <task> --at <station>`: a failed run tried again from a station of its graph, on its own
 * branch, once its lead has fixed what failed it. The owner resumes it, as with reask. The run keeps what it made, and
 * a resume is a new attempt: the visits the earlier attempt used, the cap that stops a loop within one attempt, count
 * again from now (`visits_reset_at`, which the runner reads). The caller checks the station against the graph the run
 * will read (as it is now, which the stored workflow may predate). A trial problem resumes under its trial's limits
 * (cast line trial rerun <task> --at).
 */
export async function resumeFailedRunCore(ctx: Ctx, userId: Id<"users">, runId: Id<"workflow_runs">, at: string, opts: { check?: boolean; currentFlow?: boolean; queue?: boolean } = {}, now = Date.now()) {
  const run = await ctx.db.get(runId);
  if (!run || !(await canReadRun(ctx, userId, run))) throw new ConvexError("Run not found");
  if (String(run.user_id) !== String(userId)) throw new ConvexError("Only the run's owner resumes it");
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  if (task && isTerminalTaskStatus(task.status)) throw new ConvexError(`${task.short_id} is ${task.status}: a closed problem is not resumed`);
  if (task && (await trialProjectOf(ctx, task))) throw new ConvexError(`${task.short_id} is a trial problem: cast flow trial rerun ${task.short_id} --at <station> resumes it under the trial's budget`);
  if (!endedFailing(run)) throw new ConvexError(`The run is ${run.status}: only a failed run is resumed at a station (a run waiting on a decision is asked again with cast workflow reask)`);
  const node = at.trim();
  if (!node) throw new ConvexError("Name the station to resume at");
  if (!run.runner_device) throw new ConvexError("The run names no machine to pick it up");
  // A run reads the flow versions it started on, resume included; --current-flow moves it onto the current ones first
  // (a queued resume moves when it resumes, onto the versions current then).
  if (opts.currentFlow) await repinRunForResume(ctx, run, node, { check: opts.check || opts.queue });
  if (opts.check) return { run_id: run._id, task: task?.short_id ?? null, resumed_at: node, queued: false };
  // --queue: the line's sweep resumes it once its own machine has a free run slot, ahead of new starts (orgLine.planSweep).
  if (opts.queue) {
    await ctx.db.patch(run._id, { resume_queued: { at: node, ...(opts.currentFlow ? { current_flow: true } : {}), by: userId, since: now }, updated_at: now });
    return { run_id: run._id, task: task?.short_id ?? null, resumed_at: node, queued: true };
  }
  await resumeRunAt(ctx, userId, run, node, now, { newAttempt: true });
  return { run_id: run._id, task: task?.short_id ?? null, resumed_at: node, queued: false };
}

/**
 * A queued resume (resumeFailedRunCore's `queue`), carried out by the line's sweep once the run's machine has a free
 * slot. It no longer applies to a run that moved since (resumed some other way, or its problem closed): the queue is
 * cleared and nothing starts. A current flow that lost the station also clears it, and the run stays failed.
 */
export async function resumeQueuedRun(ctx: Ctx, runId: Id<"workflow_runs">, now = Date.now()): Promise<string | null> {
  const run: Doc<"workflow_runs"> | null = await ctx.db.get(runId);
  const queued = run?.resume_queued;
  if (!run || !queued) return null;
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  const drop = async () => { await ctx.db.patch(run._id, { resume_queued: undefined }); return null; };
  if (!endedFailing(run) || !run.runner_device || (task && isTerminalTaskStatus(task.status))) return drop();
  if (queued.current_flow) {
    try {
      await repinRunForResume(ctx, run, queued.at);
    } catch {
      return drop();
    }
  }
  await resumeRunAt(ctx, queued.by, run, queued.at, now, { newAttempt: true });
  return String(run._id);
}

export const resumeFromCli = mutation({
  args: { api_token: v.string(), run_id: v.id("workflow_runs"), at: v.string(), check: v.optional(v.boolean()), current_flow: v.optional(v.boolean()), queue: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    return resumeFailedRunCore(ctx, auth.userId, args.run_id, args.at, { check: args.check, currentFlow: args.current_flow, queue: args.queue });
  },
});

/** A landing step's own words for refusing a branch the default branch has moved past ("line: codecast/line-ct-58259
 *  is behind origin/main; rebase it first"): the one refusal a rebase answers. */
export const BEHIND_MAIN = /\S+ is behind (?:origin\/)?\S+?[;,.\s]/;

/** Why "Rebase and land" cannot start on a run, or null: the run ended, a person answered Ship on its card, and its
 *  landing step refused the branch only because the default branch moved past it. */
export function landAgainRefusal(run: { status: string; gate_response?: string | null; node_statuses?: Array<{ node_id: string; status: string; result_preview?: string | null }> | null }): string | null {
  if (run.status !== "completed" && run.status !== "failed") return `The run is ${run.status}: it has not ended`;
  if (!/^\s*(?:\[?S\]?|ship\b)/i.test(run.gate_response ?? "")) return "Nobody answered Ship on its card";
  const landing = [...(run.node_statuses ?? [])].reverse().find((n) => n.node_id === "ship" || n.node_id === "merge");
  if (!landing || landing.status !== "failed" || !BEHIND_MAIN.test(`${landing.result_preview ?? ""} `)) return "Its landing step did not refuse it for being behind the default branch";
  return null;
}

// "Rebase and land": an approved fix whose landing step refused it because the default branch moved on. The run picks
// up at the line's Rebase station on its own machine, keeping its Ship answer and its worktree (the checkpoint's
// context): the branch goes onto the default branch as the remote has it, the project's check runs on the result, and
// Ship lands it; a conflict or a red check sends it back to the builder, as on any run. `fresh_branch` makes the daemon
// read the line's graph file again, so a run from before the Rebase station existed gets it. The run's owner asks.
export async function landAgainCore(ctx: Ctx, userId: Id<"users">, runId: Id<"workflow_runs">): Promise<{ ok: true }> {
  const run = await ctx.db.get(runId);
  if (!run || !(await canReadRun(ctx, userId, run))) throw new ConvexError("Run not found");
  if (!(await canCancelRun(ctx, userId, run))) throw new ConvexError("Only the run's owner can land it");
  const refused = landAgainRefusal(run as any);
  if (refused) throw new ConvexError(refused);
  // The line the run's machine resumes on must have the Rebase station, or the runner refuses and the run stalls.
  const wf = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
  if (!((wf as any)?.nodes ?? []).some((n: { id?: string }) => n.id === "rebase")) throw new ConvexError("Its line has no Rebase step");
  const device = await runMachine(ctx, run);
  if (!device) throw new ConvexError("The machine that built the fix is not known");
  const now = Date.now();
  await ctx.db.patch(run._id, { status: "running", current_node_id: "rebase", fail_reason: undefined, fresh_branch: true, resume_requested_at: now, updated_at: now });
  await queueRunOnDaemon(ctx, run.user_id, run._id, { device, now });
  return { ok: true };
}

export const cancel = mutation({
  args: { id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    await cancelRunByPerson(ctx, userId, args.id);
  },
});

/** A person stops a run: the run ends, and its task says so, as when a run
 *  fails, instead of reading in progress with nothing running and nothing to
 *  restart it. */
export async function cancelRunByPerson(ctx: Ctx, userId: Id<"users">, runId: Id<"workflow_runs">, now = Date.now()): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run || !(await canReadRun(ctx, userId, run))) throw new Error("Not found");
  if (!(await canCancelRun(ctx, userId, run))) throw new Error("Unauthorized: not your run");
  const live = run.status !== "completed" && run.status !== "failed";
  await cancelCore(ctx, run, now);
  if (live && run.task_id) await settleRunTask(ctx, run, "failed", "Cancelled by user", now);
}

// ── the-line.md L8: the one run list ─────────────────────────────────────────

type ListRunsArgs = { team_id?: Id<"teams">; task_id?: string; plan_id?: string; status?: string; limit?: number };

async function findByRef(ctx: Ctx, table: "tasks" | "plans", ref: string): Promise<any | null> {
  const byShort = await ctx.db.query(table).withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
  if (byShort) return byShort;
  const id = ctx.db.normalizeId(table, ref);
  return id ? await ctx.db.get(id) : null;
}

// The one list for the web feeder, the scope feed and the task page. Reads
// go through the data context: the viewer's workspace key is resolved by
// createDataContext (team membership is required for a team key), and every
// row is one equality against it. With task_id or plan_id the rows come off
// that item's index, still filtered by the key, so a teammate who can read
// the task can read its run and a stranger reads nothing. Rows minted
// before the backfill (no stored key) resolve personal to their owner.
export async function listRunsCore(ctx: Ctx, userId: Id<"users">, args: ListRunsArgs) {
  const db = await createDataContext(ctx, args.team_id
    ? { userId, workspace: "team", team_id: args.team_id }
    : { userId, workspace: "personal" });
  const key = db.workspaceKey;
  const limit = Math.max(1, Math.min(args.limit ?? 50, 200));

  let rows: any[] = [];
  if (args.task_id || args.plan_id) {
    const item = args.task_id ? await findByRef(ctx, "tasks", args.task_id) : await findByRef(ctx, "plans", args.plan_id!);
    if (!item) return [];
    const allowed = args.task_id ? await canAccessTask(ctx, userId, item) : await canAccessPlan(ctx, userId, item);
    if (!allowed) return [];
    const all = args.task_id
      ? await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", item._id)).order("desc").take(limit * 4)
      : await ctx.db.query("workflow_runs").withIndex("by_plan", (q: any) => q.eq("plan_id", item._id)).order("desc").take(limit * 4);
    for (const r of all) if (await canReadRun(ctx, userId, r)) rows.push(r);
  } else {
    rows = await (args.status
      ? ctx.db.query("workflow_runs").withIndex("by_workspace_status_updated", (q: any) => q.eq("workspace", key).eq("status", args.status))
      : ctx.db.query("workflow_runs").withIndex("by_workspace_updated", (q: any) => q.eq("workspace", key)))
      .order("desc")
      .take(limit * 2);
    if (!args.team_id) {
      // Legacy rows (no stored key yet) ride the owner index, same as the
      // scoped tables' chokepoint does until the backfill retires it.
      const seen = new Set(rows.map((r) => String(r._id)));
      const legacy = await ctx.db
        .query("workflow_runs")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .order("desc")
        .take(limit * 2);
      for (const r of legacy) {
        if (seen.has(String(r._id)) || (typeof r.workspace === "string" && r.workspace)) continue;
        rows.push(r);
      }
    }
  }
  const out = rows.filter((r) => !args.status || r.status === args.status);
  out.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  const workflows = new Map<string, any>();
  // Node sessions ride every feed (see listForWorkflow); the budget keeps a
  // 200 run page bounded, newest runs claiming lookups first.
  const budget = { reads: 300 };
  const shaped = [];
  for (const run of out.slice(0, limit)) shaped.push(await enrichRun(ctx, await withAgentSessions(ctx, run, budget), workflows));
  return shaped;
}

// The option an answered gate decision chose, in its own words. On a line card
// those words are the instruction its card wrote ("Revise it first: find why it
// goes silent on garbled calls"), which the bare key in gate_response lacks.
export function answeredOptionLabel(decision: any): string | undefined {
  return decision?.status === "answered" && typeof decision.answer_index === "number" ? decision.options?.[decision.answer_index]?.label : undefined;
}

// The one shape every run feed hands the web store (the-line.md L10): the
// list and the single run query agree, so a store row replaced by either
// keeps its task, workflow, node label and gate decision chips.
export async function enrichRun(ctx: Ctx, run: any, workflows: Map<string, any> = new Map()) {
  let workflow: any = null;
  if (run.workflow_id) {
    const wid = String(run.workflow_id);
    if (!workflows.has(wid)) workflows.set(wid, await ctx.db.get(run.workflow_id));
    workflow = workflows.get(wid);
  }
  const node = workflow?.nodes?.find((n: any) => n.id === run.current_node_id);
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;
  const plan = run.plan_id ? await ctx.db.get(run.plan_id) : null;
  const decision = run.gate_decision_id ? await ctx.db.get(run.gate_decision_id) : null;
  return {
    ...run,
    task_short_id: task?.short_id,
    task_title: task?.title,
    plan_short_id: plan?.short_id,
    workflow_name: run.workflow_name ?? workflow?.name,
    workflow_slug: workflow?.slug,
    // What a person reads as the flow's name, read from its workflow row; `workflow_name` stays the key.
    workflow_label: workflow?.label,
    current_node_label: node?.label ?? run.node_statuses?.find((n: any) => n.node_id === run.current_node_id)?.label ?? run.current_node_id,
    gate_decision_short_id: decision?.short_id,
    gate_decision_status: decision?.status,
    // What the last gate was answered with, in the option's own words, and
    // what its card says the run cost (LE16 run report, LE14 versions).
    gate_answer: answeredOptionLabel(decision),
    // How a line run ended (LE16): shipped, dropped, dissolved or parked,
    // so a project reading its runs never re-derives it from station ids.
    line_outcome: lineRunOutcome(run)?.kind,
    // Billed money and the subscription sessions' list price, two kinds never added (changeCard costParts).
    ...(typeof decision?.card?.cost?.usd === "number" ? (({ billed_usd, list_usd }) => ({ card_billed_usd: billed_usd, card_list_usd: list_usd }))(costParts(decision.card.cost)) : {}),
    // line-versions.md LV1: a live run a later run, a dropped station or its problem replaced; null while current.
    superseded: await runSuperseded(ctx, run, task),
  };
}

export const listRuns = query({
  args: {
    team_id: v.optional(v.id("teams")),
    task_id: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return listRunsCore(ctx, userId, args);
  },
});

// `cast workflow runs [--task|--plan]` (the-line.md L10) through /cli/workflow-runs/list.
export const listRunsFromCli = query({
  args: {
    api_token: v.string(),
    team_id: v.optional(v.id("teams")),
    task_id: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const { api_token: _t, ...rest } = args;
    return { runs: await listRunsCore(ctx, auth.userId, rest) };
  },
});

// the-line.md L8: rows minted before the workspace field are stamped
// personal to their owner. Run repeatedly until it reports 0.
export const backfillWorkspace = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workflow_runs")
      .filter((q) => q.eq(q.field("workspace"), undefined))
      .take(args.limit ?? 500);
    for (const r of rows) {
      await ctx.db.patch(r._id, { workspace: computeWorkspaceKey({ user_id: r.user_id }, null) });
    }
    return { stamped: rows.length };
  },
});

// ── LE16 repair: causes the old run end left in review ───────────────────────

/**
 * One time repair (LE16): walk completed runs, and move each line cause the
 * old run end left in review to the status its run decided, through the one
 * status path. `dry_run` reports what it would move without writing.
 * Paged: call again with the returned cursor until `done`.
 */
export const repairLineCauseStatus = internalMutation({
  args: { dry_run: v.boolean(), cursor: v.optional(v.union(v.string(), v.null())), page: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("workflow_runs")
      .withIndex("by_status", (q: any) => q.eq("status", "completed"))
      .paginate({ cursor: args.cursor ?? null, numItems: args.page ?? 200 });
    const moved: Array<{ task: string; from: string; to: string }> = [];
    const restamped: Array<{ task: string; from: number; to: number }> = [];
    let skipped = 0;
    for (const run of page.page) {
      if (!run.task_id) continue;
      const task: any = await ctx.db.get(run.task_id);
      // Only the run the cause is bound to speaks for it now.
      if (!task || String(task.workflow_run_id ?? "") !== String(run._id)) continue;
      // The cause closed when its run reached the end, not when this repair ran.
      const end = lineRunOutcome(run);
      const next = repairedLineStatus(task, run);
      if (!next) {
        const at = repairedClosedAt(task, run, await statusHistory(ctx, task._id));
        if (at !== null) {
          restamped.push({ task: task.short_id, from: task.closed_at, to: at });
          if (!args.dry_run) await patchTask(ctx, task, { closed_at: at });
        }
        continue;
      }
      const history = await statusHistory(ctx, task._id);
      if (history.some((h: any) => h.created_at > run.updated_at)) { skipped++; continue; }
      moved.push({ task: task.short_id, from: task.status, to: next });
      if (!args.dry_run) await moveTaskStatus(ctx, task, next, { actorUserId: run.user_id, ...(next !== "open" && end ? { closedAt: end.at } : {}) });
    }
    return { scanned: page.page.length, moved, restamped, skipped, cursor: page.continueCursor, done: page.isDone };
  },
});

// The graph a run ran, for a viewer who may read the run (line-map.md LX5):
// a project's causes run more than one graph (codecast's line, a repo's own
// such as Union's AgentWatch), each pushed under the user whose daemon ran
// it, so a teammate reading the project's line reaches the row through the
// run rather than through ownership. The raw row, the shape workflows.webGet
// returns, so it lands in the same store collection.
export const graphOfRun = query({
  args: { run_id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const run = await ctx.db.get(args.run_id);
    if (!run?.workflow_id || !(await canReadRun(ctx, userId, run))) return null;
    const row = await ctx.db.get(run.workflow_id);
    if (!row) return null;
    // A teammate reads the graph, never where it lives: origin names the
    // owner's checkout path and machine.
    if (String(row.user_id) === String(userId)) return row;
    const { origin: _origin, ...shared } = row as typeof row & { origin?: unknown };
    return shared;
  },
});

// Once, for the hosts stamped before the flag meant only "this session is the
// run's log": a person's own session that called the Workflow tool
// (ingestSnapshot) or launched a run from its composer (create with
// existing_conversation_id) was marked the run's log, so it left the inbox and
// the feed with the logs (isRunLog), and an ended run replaced its composer
// with the RunLogEndedBar. A log is born in the same mutation as its run
// (started_at is the run's created_at, session wf-<runId> until the daemon
// rebinds it); a host started before its run. Clears the flag on every host.
export const unmarkRunHosts = internalMutation({
  args: { dry_run: v.boolean(), cursor: v.optional(v.union(v.string(), v.null())), page: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("workflow_runs")
      .paginate({ cursor: args.cursor ?? null, numItems: args.page ?? 200 });
    const cleared: string[] = [];
    for (const run of page.page) {
      if (!run.primary_conversation_id) continue;
      const conv = await ctx.db.get(run.primary_conversation_id);
      if (!conv || !conv.is_workflow_primary) continue;
      const bornWithRun = conv.session_id === `wf-${run._id}` || (conv.started_at ?? 0) >= run.created_at;
      if (bornWithRun) continue;
      cleared.push(conv.session_id);
      if (!args.dry_run) await ctx.db.patch(conv._id, { is_workflow_primary: false });
    }
    return { scanned: page.page.length, cleared, cursor: page.continueCursor, done: page.isDone };
  },
});

