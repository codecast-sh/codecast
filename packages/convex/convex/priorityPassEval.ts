// The priorities pass for calibration (packages/evals/scripts/priorities-measure.ts).
//
// `evalPass` runs the pass from empty over a window and returns what it would
// have written, writing nothing. It reads through passInputs and asks through
// the same request builder, parser and merge as the pass (priorityPassRun.ts),
// chunk after chunk oldest first, carrying each chunk's priorities into the
// next chunk's input in memory, so its end state is what a chain of first
// passes would leave. Calls go on codecast's own key; a team's vendor refusal
// and the regulated-team filter hold as for any pass. Internal, so staff run
// it (packages/convex/run.sh).

import { v } from "convex/values";
import { internalAction, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { runModelCall } from "./modelCalls";
import { mergePriorities, priorityPassRequest, type MergePlan, type PassPriority, type PassTask, type PriorityPassInput } from "./lib/priorityPass";
import { parsePriorityPassOutput } from "./lib/priorityPassParse";
import { LATE_MARGIN_MS, MINUTE, type PassInputs } from "./priorityPassInputs";
import { PASS_TIMEOUT_MS, callScope, fittingPrefix, runShare } from "./priorityPassRun";

/** The most teams of the person a calibration run lists. */
const MEMBERSHIPS_READ = 500;
// Codegen catches up on the next push.
const inputs = (internal as any).priorityPassInputs;

/** A calibration action starts no model call past this, so the call it starts ends inside Convex's ten-minute action limit; it returns `resume` instead. */
const EVAL_CALLS_START_WITHIN_MS = 4 * MINUTE;

type EvalOutput = NonNullable<ReturnType<typeof parsePriorityPassOutput>["output"]>;

/** Where a calibration run stands between chunks: the next chunk's cursor and the priorities so far. */
export type EvalState = {
  cursor_at: number;
  priorities: PassPriority[];
  /** Every task a read session linked, newest status, for later chunks' step_tasks. */
  tasks: PassTask[];
  /** The last pri-N given out in memory. */
  next_id: number;
};

export type EvalChunk = { cursor_at: number; read_to: number; sessions: string[]; output: EvalOutput; dropped: string[]; plan: MergePlan; cost_usd: number };

export type EvalResult = {
  /** One per model call, oldest first, with the reply as parsed and the plan it made. */
  outputs: EvalChunk[];
  /** The end state: every priority the passes would have left, with its steps and sessions. */
  priorities: PassPriority[];
  cost_usd: number;
  /** Every session the window held for this workspace, whether or not its prompt fit it. */
  sessions_read: Array<{ id: string; title: string }>;
  /** Sessions a prompt left out for length: the model never saw them. */
  omitted: string[];
  /** Set when the window is not finished: call again with it as `resume`. */
  resume?: EvalState;
};

/** A plan applied to in-memory priorities as applyPlan applies it to the rows (a calibration run has no person settings to keep). */
export function applyPlanInMemory(state: EvalState, plan: MergePlan, input: PriorityPassInput): Pick<EvalState, "priorities" | "next_id"> {
  const known = new Map<string, { title: string; last_active: number }>();
  for (const p of state.priorities) for (const s of p.sessions) known.set(s.id, s);
  for (const s of input.sessions) known.set(s.id, s);
  const byId = new Map(state.priorities.map((p) => [p.short_id, { ...p, sessions: [...p.sessions] }]));
  const ids = new Map<string, string>();
  let next_id = state.next_id;
  for (const c of plan.creates) {
    const short_id = `pri-${++next_id}`;
    ids.set(c.ref, short_id);
    byId.set(short_id, { short_id, title: c.title, summary: c.summary, status: c.status, person_pos: null, ai_rank: c.ai_rank, serves: c.serves, steps: c.steps, last_active_at: c.last_active_at, sessions: [] });
  }
  for (const u of plan.updates) {
    const p = byId.get(u.short_id);
    if (!p) continue;
    const { done_at: _d, pass_at: _p, ...patch } = u.patch;
    Object.assign(p, patch);
  }
  for (const m of plan.merges) byId.delete(m.short_id);
  const detach = (session: string) => {
    for (const p of byId.values()) p.sessions = p.sessions.filter((s) => s.id !== session);
  };
  for (const s of plan.sessions) {
    const p = byId.get(ids.get(s.priority) ?? s.priority);
    if (!p) continue;
    detach(s.session);
    const info = known.get(s.session);
    p.sessions.push({ id: s.session, title: info?.title ?? "", step_key: s.step_key, last_active: info?.last_active ?? 0 });
  }
  for (const id of plan.unmap) detach(id);
  return { priorities: [...byId.values()], next_id };
}

/** The pass from empty over [window_start, window_end] for one person in one workspace, written nowhere. `chunk` caps the sessions one model call reads; `system` replaces the pass's system prompt for this replay, to try a prompt before it ships. */
export const evalPass = internalAction({
  args: { user_id: v.id("users"), workspace: v.string(), window_start: v.number(), window_end: v.number(), chunk: v.optional(v.number()), resume: v.optional(v.any()), system: v.optional(v.string()) },
  handler: async (ctx, args): Promise<EvalResult> => {
    const started = Date.now();
    const now = Math.min(args.window_end + LATE_MARGIN_MS, started);
    let state: EvalState = (args.resume as EvalState | undefined) ?? { cursor_at: args.window_start, priorities: [], tasks: [], next_id: 0 };
    const outputs: EvalChunk[] = [];
    const readIds = new Map<string, string>();
    const omitted: string[] = [];
    let cost_usd = 0;
    const done = (resume?: EvalState): EvalResult => ({
      outputs, priorities: state.priorities, cost_usd, sessions_read: [...readIds].map(([id, title]) => ({ id, title })), omitted, ...(resume ? { resume } : {}),
    });
    for (;;) {
      if (outputs.length && Date.now() - started > EVAL_CALLS_START_WITHIN_MS) return done(state);
      const read: PassInputs = await ctx.runQuery(inputs.passInputs, { user_id: args.user_id, workspace: args.workspace, now, window_start: state.cursor_at });
      if (!read.input.sessions.length && !read.input.calls.length) {
        if (!read.more || read.read_to <= state.cursor_at) return done();
        state = { ...state, cursor_at: read.read_to };
        continue;
      }
      const tasks = new Map(state.tasks.map((t) => [t.short_id, t]));
      for (const s of read.input.sessions) for (const t of s.tasks) tasks.set(t.short_id, t);
      const stepTaskIds = new Set(state.priorities.flatMap((p) => p.steps.flatMap((s) => s.refs.filter((r) => r.kind === "task").map((r) => r.id))));
      // A calibration run starts from empty: the person's real corrections and session placements name priorities it never made.
      const full: PriorityPassInput = {
        ...read.input,
        priorities: state.priorities,
        step_tasks: [...stepTaskIds].flatMap((id) => tasks.get(id) ?? []),
        sessions: read.input.sessions.map(({ placed: _p, not_for: _n, ...session }) => session),
        corrections: [],
      };
      const { input, readTo, left } = runShare(read, full, Math.min(fittingPrefix(full), args.chunk ?? Infinity));
      if (left && readTo <= state.cursor_at) throw new Error(`calibration stuck at cursor ${state.cursor_at}: the next chunk would read the same sessions`);
      for (const s of input.sessions) readIds.set(s.id, s.title);
      const { req, omitted: cut } = priorityPassRequest(input);
      omitted.push(...cut);
      const reply = await runModelCall(
        ctx,
        callScope(args.workspace),
        "grouping",
        { model: req.model, max_tokens: req.max_tokens, system: args.system ?? req.system, prompt: req.prompt, output: "json", output_schema: req.output_schema },
        "Priority pass calibration",
        PASS_TIMEOUT_MS,
        { budgeted: false },
      );
      cost_usd += reply.cost_usd;
      if (!reply.ok) throw new Error(`calibration chunk ${outputs.length + 1} failed: ${reply.error}`);
      const { output, dropped } = parsePriorityPassOutput(reply.json, input);
      if (!output) throw new Error(`calibration chunk ${outputs.length + 1}: unreadable reply: ${dropped.join("; ")}`);
      const plan = mergePriorities(input, output);
      outputs.push({ cursor_at: state.cursor_at, read_to: readTo, sessions: input.sessions.map((s) => s.id), output, dropped, plan, cost_usd: reply.cost_usd });
      state = { ...applyPlanInMemory(state, plan, input), tasks: [...tasks.values()], cursor_at: readTo };
      if (!left) return done();
    }
  },
});

/** Who a calibration run is for, by email or user id, and the workspaces they hold: their own and each team's. */
export const evalTargets = internalQuery({
  args: { user: v.string() },
  handler: async (ctx, args): Promise<{ user_id: Id<"users">; workspaces: Array<{ workspace: string; name: string }> }> => {
    const id = ctx.db.normalizeId("users", args.user);
    const user: Doc<"users"> | null = id ? await ctx.db.get(id) : await ctx.db.query("users").withIndex("email", (q: any) => q.eq("email", args.user)).first();
    if (!user) throw new Error(`no user ${args.user}`);
    const memberships: Doc<"team_memberships">[] = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", user._id)).take(MEMBERSHIPS_READ);
    const workspaces = [{ workspace: `user:${user._id}`, name: "personal" }];
    for (const m of memberships) {
      const team: Doc<"teams"> | null = await ctx.db.get(m.team_id);
      if (team) workspaces.push({ workspace: `team:${m.team_id}`, name: team.name });
    }
    return { user_id: user._id, workspaces };
  },
});
