import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { resolveCreationPrivacy } from "./privacy";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { askCore, finalizeAnswer, normalizeVerdict, personMayResolve, withdrawCore, type AnsweredBy } from "./sessionDecisions";
import { createStackCore } from "./decisionStacks";
import { canAccessTask, canAccessPlan, computeWorkspaceKey, resolveWorkspaceKey, workspaceGrantsAccess } from "./lib/access";
import { patchTask } from "./lib/taskWrite";
import { createDataContext } from "./data";

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
async function canReadRun(ctx: Ctx, userId: Id<"users">, run: any): Promise<boolean> {
  if (String(run.user_id) === String(userId)) return true;
  return workspaceGrantsAccess(ctx, userId, await resolveWorkspaceKey(ctx, run));
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

// Pause the run at a gate and ask the person through the one rail every
// human question uses (the-line.md L4). The asker is the session that
// started the run (so the ladder and grants apply), else the run's primary
// conversation. gate_prompt / gate_choices stay on the run as a mirror for
// old readers and for the key map the answer rides back on.
export async function pauseAtGateCore(
  ctx: Ctx,
  auth: { userId: Id<"users"> },
  args: { run_id: Id<"workflow_runs">; node_id: string; prompt: string; choices: GateChoice[]; doc_md?: string; category?: string; stack?: string },
) {
  const run = await ctx.db.get(args.run_id);
  if (!run || String(run.user_id) !== String(auth.userId)) return { error: "Not found" };

  const now = Date.now();
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
  // decision is bound there so a blocking gate holds the task (L5).
  if (run.task_id) {
    const held = await ctx.db.get(run.task_id);
    if (held) await patchTask(ctx, held, { status: "in_review", updated_at: now });
  }
  const task = run.task_id ? await ctx.db.get(run.task_id) : null;

  let decision: { id: Id<"session_decisions">; short_id?: string } | null = null;
  const askerId = run.spawner_conversation_id ?? run.primary_conversation_id;
  const asker = askerId ? await ctx.db.get(askerId) : null;
  if (asker) {
    const [first, ...rest] = args.prompt.split("\n");
    const question = first.trim() || args.node_id;
    const body = rest.join("\n").trim();
    const asked = await askCore(ctx, auth, {
      session_id: asker.session_id,
      question,
      context_md: body || undefined,
      options: args.choices.map((c) => ({ label: stripGateKey(c.label), ...(c.description ? { description: c.description } : {}) })),
      doc_md: args.doc_md,
      category: args.category,
      stack: stackRef,
      blocking: true,
      task: task?.short_id,
      station: task ? task.status_id ?? task.status : undefined,
      workflow_run_id: args.run_id,
      gate_node_id: args.node_id,
    });
    if (asked && !asked.error) {
      decision = { id: asked.id, short_id: asked.short_id };
      await ctx.db.patch(args.run_id, { gate_decision_id: asked.id });
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
    // The run panel answers under the same rule as the decision card: only
    // a person the gate was asked of (or its owner) may answer it.
    if (by.user_id && !personMayResolve(decision, by.user_id)) return { error: "Unauthorized: not your decision" };
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
export async function cancelCore(ctx: Ctx, run: any, now = Date.now()): Promise<void> {
  if (run.status === "completed" || run.status === "failed") return;
  if (run.gate_decision_id) {
    const decision = await ctx.db.get(run.gate_decision_id);
    if (decision && decision.status === "pending") await withdrawCore(ctx, decision, now);
  }
  await ctx.db.patch(run._id, { status: "failed", fail_reason: "Cancelled by user", updated_at: now });
}

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
      if (bound) await patchTask(ctx, bound, { workflow_run_id: runId, status: "in_progress", updated_at: now });
    }

    if (args.plan_id) {
      await ctx.db.patch(args.plan_id, {
        workflow_run_id: runId,
        updated_at: now,
      });
    }

    let primaryConvId: any;

    if (args.existing_conversation_id) {
      // Take over the existing conversation as the workflow primary
      const existing = await ctx.db.get(args.existing_conversation_id);
      if (existing && existing.user_id === userId) {
        await ctx.db.patch(args.existing_conversation_id, {
          workflow_run_id: runId,
          is_workflow_primary: true,
          title: workflow.name,
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

    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "run_workflow",
      args: JSON.stringify({ workflow_run_id: runId }),
      created_at: now,
    });

    return runId;
  },
});

// The one insert shape for a run: the run row, the bound task or plan patched
// to carry it, the primary conversation the run speaks through, and its
// "started" message. createFromCli calls it for a run the CLI executes
// itself; orgLine.startLineRun calls it for a run the sweep hands to the
// daemon (the-line.md L9). One place, so a field added to runs or to the
// primary conversation lands on both paths.
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
    // The team the primary session routes to when no directory rule names
    // one (a role's team, for a run the sweep starts).
    fallback_team_id?: Id<"teams">;
    now?: number;
  },
): Promise<{ run_id: Id<"workflow_runs">; primary_conversation_id: Id<"conversations"> }> {
  const now = opts.now ?? Date.now();
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
    status: "pending",
    node_statuses: [],
    goal_override: opts.goal_override,
    project_path: opts.project_path,
    created_at: now,
    updated_at: now,
  });

  if (opts.task) {
    await patchTask(ctx, opts.task, { workflow_run_id: runId, status: "in_progress", updated_at: now });
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
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) throw new Error("Unauthorized");
    const userId = result.userId;

    const now = Date.now();
    const spawner = args.spawner_session ? await findConversationByAnyRef(ctx, args.spawner_session, userId) : null;

    const taskRow: any = args.task_id
      ? await ctx.db.query("tasks").withIndex("by_short_id", q => q.eq("short_id", args.task_id!)).first()
      : null;
    const planRow: any = args.plan_id
      ? await ctx.db.query("plans").withIndex("by_short_id", q => q.eq("short_id", args.plan_id!)).first()
      : null;

    // Resolve workflow_id — either passed directly or look up by name
    let workflowDocId: any = args.workflow_id ? (args.workflow_id as any) : undefined;
    if (!workflowDocId) {
      const wf = await ctx.db.query("workflows")
        .withIndex("by_user_id", q => q.eq("user_id", userId))
        .collect();
      const match = wf.find(w => w.name === args.workflow_name);
      if (match) workflowDocId = match._id;
    }

    const { run_id } = await createRunCore(ctx, userId, {
      workflow_name: args.workflow_name,
      workflow_goal: args.workflow_goal,
      workflow_id: workflowDocId || undefined,
      task: taskRow,
      plan: planRow,
      goal_override: args.goal_override,
      project_path: args.project_path,
      spawner_conversation_id: spawner?._id,
      now,
    });
    return { run_id };
  },
});

// Attach each agent's synced conversation to its node status so run UIs can render
// a clickable session list. The daemon uploads per-agent transcripts
// (<session>/subagents/workflows/<wf_id>/agent-<id>.jsonl) as conversations keyed
// session_id="agent-<id>", so dynamic-workflow nodes resolve deterministically even on
// runs ingested before session_id stamping; routine/graph nodes carry a real session_id
// already. `budget` caps conversation lookups so list queries stay bounded — runs are
// enriched most-recent-first and older ones degrade to plain (non-clickable) rows.
async function withAgentSessions(ctx: any, run: any, budget = { reads: 200 }) {
  if (!run?.node_statuses?.length) return run;
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const node_statuses = await Promise.all(run.node_statuses.map(async (node: any) => {
    const sessionId = node.session_id
      || (run.run_kind === "workflow" && node.node_id ? `agent-${node.node_id}` : null);
    if (!sessionId || budget.reads <= 0) return node;
    budget.reads--;
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
      .filter((q: any) => q.eq(q.field("user_id"), run.user_id))
      .first();
    if (!conv) return node;
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

    return {
      run: { ...run, task_short_id: taskShortId, plan_short_id: planShortId },
      workflow: workflow || { name: "workflow", goal: run.goal_override, nodes: [], edges: [] },
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
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    const now = Date.now();
    const nodeStatuses = [...run.node_statuses];
    const existing = nodeStatuses.findIndex((n) => n.node_id === args.node_id);
    const prev = existing >= 0 ? nodeStatuses[existing] : undefined;
    const nodeEntry = {
      node_id: args.node_id,
      status: args.node_status,
      outcome: args.outcome,
      session_id: args.session_id ?? prev?.session_id,
      result_preview: args.result_preview ?? prev?.result_preview,
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
      fail_reason: args.fail_reason,
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

    // Sync status to bound task/plan
    if (args.run_status) {
      const taskId = (run as any).task_id;
      const planId = (run as any).plan_id;

      if (taskId) {
        const taskUpdates: Record<string, any> = { updated_at: now };
        if (args.run_status === "completed") {
          taskUpdates.status = "in_review";
        } else if (args.run_status === "failed") {
          taskUpdates.execution_status = "blocked";
          if (args.fail_reason) taskUpdates.execution_concerns = args.fail_reason;
        }
        if (Object.keys(taskUpdates).length > 1) {
          await ctx.db.patch(taskId, taskUpdates);
        }
      }

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
export const ingestSnapshot = mutation({
  args: {
    api_token: v.string(),
    external_run_id: v.string(),
    session_id: v.string(),
    project_path: v.optional(v.string()),
    workflow_name: v.string(),
    status: v.string(),
    phases: v.array(v.object({ title: v.string(), detail: v.optional(v.string()) })),
    agents: v.array(v.object({
      agent_id: v.string(),
      label: v.optional(v.string()),
      phase: v.optional(v.string()),
      state: v.string(),
      tokens: v.optional(v.number()),
      duration_ms: v.optional(v.number()),
      started_at: v.optional(v.number()),
      result_preview: v.optional(v.string()),
      last_tool_name: v.optional(v.string()),
      last_tool_summary: v.optional(v.string()),
    })),
    total_tokens: v.optional(v.number()),
    agent_count: v.optional(v.number()),
    started_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const now = Date.now();

    const allowed = ["pending", "running", "paused", "completed", "failed"];
    const runStatus = (allowed.includes(args.status) ? args.status : "running") as
      "pending" | "running" | "paused" | "completed" | "failed";
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
    // Stamp the host conversation with its current run, the same link the DOT
    // path writes in updateProgress. This is what feeds the inbox row's
    // workflow_run_status enrichment — without it a session running a workflow
    // has no card-level "workflow running" signal at all. A live run always
    // claims the pointer (a session runs its waves one after another; the
    // newest live run is the current one); a terminal snapshot only claims it
    // when nothing is stamped yet, so a finished wave's final re-post can't
    // steal the pointer back from the wave that's running now.
    if (primaryConvId) {
      const conv = await ctx.db.get(primaryConvId);
      if (conv && conv.workflow_run_id !== runId && (!isTerminal || !conv.workflow_run_id)) {
        await ctx.db.patch(primaryConvId, { workflow_run_id: runId, is_workflow_primary: true });
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

    return {
      status: run.status,
      gate_response: run.gate_response ?? null,
    };
  },
});

export const cancel = mutation({
  args: { id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const run = await ctx.db.get(args.id);
    if (!run || !(await canReadRun(ctx, userId, run))) throw new Error("Not found");
    if (!(await canCancelRun(ctx, userId, run))) throw new Error("Unauthorized: not your run");
    await cancelCore(ctx, run);
  },
});

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
    rows = await ctx.db
      .query("workflow_runs")
      .withIndex("by_workspace_updated", (q: any) => q.eq("workspace", key))
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
    current_node_label: node?.label ?? run.node_statuses?.find((n: any) => n.node_id === run.current_node_id)?.label ?? run.current_node_id,
    gate_decision_short_id: decision?.short_id,
    gate_decision_status: decision?.status,
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
