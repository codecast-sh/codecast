// The per-session classifier, run (lib/priorityClassifier.ts is its pure
// core, lib/priorityClassifierHook.ts says when it runs and what it may
// spend): for one pending ask, read the person's active priorities in the
// session's own workspace and the session itself, ask the cheap model once,
// and link the session through lib/priorityLinks linkSession as the
// classifier's. "new" leaves the session to the pass.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { runModelCall } from "./modelCalls";
import { callScope } from "./priorityPassRun";
import { sessionTasks } from "./priorityPassInputs";
import { linkSession } from "./lib/priorityLinks";
import { sessionVisibility } from "./lib/prioritySessionVisibility";
import { classifierOn, classifierReads, rerunUnassigned } from "./lib/priorityClassifierHook";
import { passSoon } from "./lib/priorityPassSchedule";
import {
  CLASSIFIER_CAPS,
  classifierPriorities,
  classifierRequest,
  parseClassifierReply,
  type ClassifierChoice,
  type ClassifierInput,
  type ClassifierSession,
  type ClassifierTask,
} from "./lib/priorityClassifier";

// Codegen catches up on the next push.
const self = (internal as any).priorityClassifier;

/** The newest sessions under one priority read for its examples. */
const EXAMPLES_READ = 20;
/** The newest typed messages of the session read. */
const TYPED_READ = 8;
const CALL_TIMEOUT_MS = 60_000;

/** Tasks by short id in the workspace, with the plan and project each sits in. */
export async function classifierTasks(ctx: { db: any }, shortIds: Iterable<string>, workspace: string): Promise<Map<string, ClassifierTask>> {
  const out = new Map<string, ClassifierTask>();
  const titles = new Map<string, string | null>();
  const titleOf = async (id: Id<"plans"> | Id<"projects"> | undefined, plan: boolean) => {
    if (!id) return undefined;
    if (!titles.has(String(id))) {
      const row: any = await ctx.db.get(id);
      titles.set(String(id), row ? (plan ? `${row.short_id ?? ""} "${row.title}"`.trim() : row.title) : null);
    }
    return titles.get(String(id)) ?? undefined;
  };
  for (const short_id of new Set(shortIds)) {
    const t: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", short_id)).first();
    if (!t || t.workspace !== workspace) continue;
    const plan = await titleOf(t.plan_id, true);
    const project = await titleOf(t.project_id, false);
    out.set(short_id, { short_id, title: t.title, status: t.status, ...(plan ? { plan } : {}), ...(project ? { project } : {}) });
  }
  return out;
}

/** The person's active priorities in the workspace as candidates, most recently active first. */
async function candidatesFor(ctx: { db: any }, userId: Id<"users">, workspace: string) {
  const rows: Doc<"priorities">[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", userId).eq("workspace", workspace))
    .order("desc")
    .take(4 * CLASSIFIER_CAPS.priorities);
  const active = rows.filter((p) => p.status === "active").slice(0, CLASSIFIER_CAPS.priorities);
  const withSessions = [];
  for (const p of active) {
    const held: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)).order("desc").take(EXAMPLES_READ);
    withSessions.push({ ...p, sessions: held.map((c) => ({ title: c.title ?? "", step_key: c.priority_step_key ?? null })) });
  }
  const tasks = await classifierTasks(ctx, active.flatMap((p) => p.steps.flatMap((s) => s.refs.filter((r) => r.kind === "task").map((r) => r.id))), workspace);
  return classifierPriorities(withSessions, tasks);
}

/**
 * The session as the classifier reads it: title, pin, opening prompt, the
 * newest typed messages, its tasks and its agent's `serves` hint. `asOf`
 * replays the moment of an earlier ask (priorityClassifierEval): its first
 * generated title (the oldest one kept), the typed messages and task links
 * made by then, the pin only for a pin's ask, and no `serves`, whose pri-N
 * names priorities the replay does not hold.
 */
export async function sessionFor(ctx: { db: any }, conv: Doc<"conversations">, workspace: string, asOf?: { at: number; pin: boolean }): Promise<ClassifierSession> {
  // What the person typed (the per-send log), not every prompt-shaped message: in a person's sessions most of those are
  // other agents' messages and reports posted under their name (Study 1, ct-102386: 5,423 of them against 641 typed).
  const sends: Doc<"user_sends">[] = await ctx.db
    .query("user_sends")
    .withIndex("by_conversation_timestamp", (q: any) => (asOf ? q.eq("conversation_id", conv._id).lte("timestamp", asOf.at) : q.eq("conversation_id", conv._id)))
    .order("desc")
    .take(TYPED_READ);
  const typed = sends.reverse().flatMap((s) => (s.text.trim() && !s.decision?.picked ? [s.text] : []));
  const tasks = await sessionTasks(ctx, conv, workspace, asOf?.at);
  if (asOf) {
    const pin: Doc<"thread_state_events"> | null = asOf.pin
      ? await ctx.db.query("thread_state_events").withIndex("by_conversation_at", (q: any) => q.eq("conversation_id", conv._id).lte("at", asOf.at)).order("desc").first()
      : null;
    return { title: conv.earlier_titles?.[0] ?? conv.title ?? "", first_prompt: conv.first_prompt ?? "", pin: pin?.text ? { text: pin.text, status: pin.status } : null, typed, tasks };
  }
  const pin: Doc<"thread_state_events"> | null = await ctx.db.query("thread_state_events").withIndex("by_conversation_at", (q: any) => q.eq("conversation_id", conv._id)).order("desc").first();
  return {
    title: conv.title ?? "",
    first_prompt: conv.first_prompt ?? "",
    pin: conv.thread_state ? { text: conv.thread_state, ...(conv.thread_state_status ? { status: conv.thread_state_status } : {}) } : null,
    typed,
    tasks,
    ...(pin?.serves ? { serves: pin.serves } : {}),
  };
}

type Prep =
  | { skip: string }
  | { input: ClassifierInput; workspace: string; budgeted: boolean; model: string };

/** What a pending ask reads, or why it stands down: the feature off, the session gone, mapped since, or one the classifier never reads. */
export const classifierInput = internalQuery({
  args: { classification_id: v.id("priority_classifications") },
  handler: async (ctx, args): Promise<Prep> => {
    const row = await ctx.db.get(args.classification_id);
    if (!row || row.status !== "pending") return { skip: "not pending" };
    const conv = await ctx.db.get(row.conversation_id);
    if (!conv) return { skip: "session gone" };
    if (conv.priority_id) return { skip: "mapped since it was asked" };
    if (!classifierReads(conv)) return { skip: "not a session the classifier reads" };
    if ((await sessionVisibility(ctx).workspaceOf(conv)) !== row.workspace) return { skip: "left the workspace" };
    if (!(await classifierOn(ctx, row.user_id, row.workspace))) return { skip: "the classifier is off here" };
    const priorities = await candidatesFor(ctx, row.user_id, row.workspace);
    if (!priorities.length) return { skip: "no active priorities" };
    const user = await ctx.db.get(row.user_id);
    const budget = await ctx.db.query("team_budgets").withIndex("by_workspace", (q: any) => q.eq("workspace", row.workspace)).first();
    return {
      input: { person: user?.name ?? "this person", priorities, session: await sessionFor(ctx, conv, row.workspace) },
      workspace: row.workspace,
      budgeted: (budget?.cap_usd ?? 0) > 0,
      model: row.model,
    };
  },
});

const choiceArg = v.union(v.literal("new"), v.object({ priority: v.string(), step: v.union(v.string(), v.null()) }));

/**
 * Settles one ask: a placement links the session as the classifier's
 * (linkSession, which refuses a session mapped since, one the person said is
 * not part of that priority, and a milestone they dropped), "new" leaves it
 * unassigned for the pass and a later re-run.
 */
export const settle = internalMutation({
  args: { classification_id: v.id("priority_classifications"), cost_usd: v.number(), choice: v.optional(choiceArg), skip: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Doc<"priority_classifications">["status"] | null> => {
    const row = await ctx.db.get(args.classification_id);
    if (!row || row.status !== "pending") return null;
    const done = async (status: Doc<"priority_classifications">["status"], fields: Partial<Doc<"priority_classifications">> = {}) => {
      await ctx.db.patch(row._id, { status, cost_usd: args.cost_usd, ...fields });
      return status;
    };
    if (args.skip) return done("skipped", { error: args.skip });
    if (args.error || !args.choice) return done("error", { error: args.error ?? "no choice" });
    if (args.choice === "new") {
      // None of the person's priorities holds it: their pass runs soon, so a new priority shows while the session runs.
      await passSoon(ctx, row.user_id, row.workspace);
      return done("new");
    }
    const { priority: shortId, step } = args.choice;
    const p = await ctx.db.query("priorities").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first();
    const conv = await ctx.db.get(row.conversation_id);
    if (!p || !conv || p.status !== "active" || p.workspace !== row.workspace) return done("skipped", { error: `${shortId} is not an active priority here` });
    if (!(await linkSession(ctx, conv, p._id, step ?? undefined, "classifier"))) return done("skipped", { error: "the link was refused" });
    return done("placed", { priority_id: p._id, ...(step ? { step_key: step } : {}) });
  },
});

/** One ask (lib/priorityClassifierHook enqueue): read, ask the model, settle. */
export const classify = internalAction({
  args: { classification_id: v.id("priority_classifications") },
  handler: async (ctx, args): Promise<void> => {
    const prep: Prep = await ctx.runQuery(self.classifierInput, args);
    if ("skip" in prep) {
      await ctx.runMutation(self.settle, { ...args, cost_usd: 0, skip: prep.skip });
      return;
    }
    const { choice, cost_usd, error } = await classifyOnce(ctx, prep.input, prep.workspace, prep.budgeted, prep.model);
    await ctx.runMutation(self.settle, { ...args, cost_usd, ...(choice ? { choice } : { error: error ?? "unreadable reply" }) });
  },
});

/** One model call for one session's input: what it chose (null when the reply named nothing the input showed), and its cost. */
export async function classifyOnce(ctx: any, input: ClassifierInput, workspace: string, budgeted: boolean, model?: string): Promise<{ choice: ClassifierChoice | null; cost_usd: number; error?: string }> {
  const reply = await runModelCall(ctx, callScope(workspace), "grouping", classifierRequest(input, model), "Priority classifier", CALL_TIMEOUT_MS, { budgeted });
  if (!reply.ok) return { choice: null, cost_usd: reply.cost_usd, error: reply.error };
  return { choice: parseClassifierReply(reply.json, input), cost_usd: reply.cost_usd };
}

/** A pass created a priority or milestone RERUN_DELAY_MS ago (lib/priorityClassifierHook askRerun): ask again about what is still unassigned. */
export const rerun = internalMutation({
  args: { user_id: v.id("users"), workspace: v.string(), since: v.number() },
  handler: async (ctx, args): Promise<number> => rerunUnassigned(ctx, args.user_id, args.workspace, args.since),
});
