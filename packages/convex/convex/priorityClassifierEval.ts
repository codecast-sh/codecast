// The per-session classifier for calibration (packages/evals/scripts/
// priorities-measure.ts --classifier).
//
// `evalClassify` replays a window for one person in one workspace against the
// priorities it is handed (the golden set's, seeded), writing nothing: it
// reads the window's sessions through passInputs, oldest first, and asks the
// classifier about each session it would ask about in production
// (classifierReads, not a role's seat), through the same input builder,
// request and parser (lib/priorityClassifier.ts). A placement joins its
// milestone in memory, so later sessions see it as an example, as they would
// live. Calls go on codecast's own key. Internal, so staff run it
// (packages/convex/run.sh).

import { v } from "convex/values";
import { internalAction, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { classifierPriorities, type ClassifierChoice, type ClassifierTask } from "./lib/priorityClassifier";
import { classifierReads } from "./lib/priorityClassifierHook";
import type { PassPriority, PassSession } from "./lib/priorityPass";
import { LATE_MARGIN_MS, MINUTE, type PassInputs } from "./priorityPassInputs";
import { classifierTasks, classifyOnce } from "./priorityClassifier";

// Codegen catches up on the next push.
const fns = internal as any;

/** No new chunk (at most 50 sessions, one call each, in turn) starts past this: the action returns `resume` inside Convex's ten minutes. */
const EVAL_CHUNKS_START_WITHIN_MS = 3 * MINUTE;

export type ClassifierEvalState = { cursor_at: number; priorities: PassPriority[] };

export type ClassifierEvalResult = {
  /** One per session it asked about, oldest first. */
  placements: Array<{ session: string; title: string; choice: ClassifierChoice | null; error?: string }>;
  /** The handed priorities, holding the sessions placed under them. */
  priorities: PassPriority[];
  /** Every session the window held for this workspace, asked about or not. */
  sessions_read: Array<{ id: string; title: string }>;
  cost_usd: number;
  /** Set when the window is not finished: call again with it as `resume`. */
  resume?: ClassifierEvalState;
};

/** Which of the window's sessions the classifier would read, and the tasks the priorities name. */
export const evalFacts = internalQuery({
  args: { workspace: v.string(), sessions: v.array(v.string()), tasks: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ eligible: string[]; tasks: ClassifierTask[] }> => {
    const eligible: string[] = [];
    for (const ref of args.sessions) {
      const id = ctx.db.normalizeId("conversations", ref);
      const conv: Doc<"conversations"> | null = id ? await ctx.db.get(id) : await ctx.db.query("conversations").withIndex("by_short_id", (q) => q.eq("short_id", ref)).first();
      if (conv && classifierReads(conv)) eligible.push(ref);
    }
    return { eligible, tasks: [...(await classifierTasks(ctx, args.tasks, args.workspace)).values()] };
  },
});

const sessionOf = (s: PassSession) => ({
  title: s.title,
  first_prompt: s.first_prompt,
  pin: s.pin,
  typed: s.typed.map((m) => m.text),
  tasks: s.tasks,
  ...(s.serves ? { serves: s.serves } : {}),
});

/** The classifier over [window_start, window_end] for one person in one workspace, against `priorities`, written nowhere. `model` tries another tier. */
export const evalClassify = internalAction({
  args: { user_id: v.id("users"), workspace: v.string(), window_start: v.number(), window_end: v.number(), priorities: v.optional(v.any()), model: v.optional(v.string()), resume: v.optional(v.any()) },
  handler: async (ctx, args): Promise<ClassifierEvalResult> => {
    const started = Date.now();
    const now = Math.min(args.window_end + LATE_MARGIN_MS, started);
    let state: ClassifierEvalState = (args.resume as ClassifierEvalState | undefined) ?? { cursor_at: args.window_start, priorities: (args.priorities as PassPriority[] | undefined) ?? [] };
    const result: ClassifierEvalResult = { placements: [], priorities: state.priorities, sessions_read: [], cost_usd: 0 };
    const taskIds = [...new Set(state.priorities.flatMap((p) => p.steps.flatMap((s) => s.refs.filter((r) => r.kind === "task").map((r) => r.id))))];
    let tasks: Map<string, ClassifierTask> | null = null;
    for (;;) {
      if (result.sessions_read.length && Date.now() - started > EVAL_CHUNKS_START_WITHIN_MS) return { ...result, priorities: state.priorities, resume: state };
      const read: PassInputs = await ctx.runQuery(fns.priorityPassInputs.passInputs, { user_id: args.user_id, workspace: args.workspace, now, window_start: state.cursor_at });
      const facts: { eligible: string[]; tasks: ClassifierTask[] } = await ctx.runQuery(fns.priorityClassifierEval.evalFacts, { workspace: args.workspace, sessions: read.input.sessions.map((s) => s.id), tasks: tasks ? [] : taskIds });
      tasks ??= new Map(facts.tasks.map((t) => [t.short_id, t]));
      const eligible = new Set(facts.eligible);
      result.sessions_read.push(...read.input.sessions.map((s) => ({ id: s.id, title: s.title })));
      const asked = read.input.sessions.filter((s) => s.kind !== "role" && eligible.has(s.id));
      // One at a time, as live: each session sees the ones placed before it.
      for (const s of asked) {
        const priorities = classifierPriorities(state.priorities.filter((p) => p.status === "active"), tasks);
        const { choice, cost_usd, error } = await classifyOnce(ctx, { person: read.input.person, priorities, session: sessionOf(s) }, args.workspace, false, args.model);
        result.cost_usd += cost_usd;
        result.placements.push({ session: s.id, title: s.title, choice, ...(error ? { error } : {}) });
        if (!choice || choice === "new") continue;
        state.priorities.find((x) => x.short_id === choice.priority)?.sessions.unshift({ id: s.id, title: s.title, step_key: choice.step, last_active: s.last_active });
      }
      if (!read.more || read.read_to <= state.cursor_at) return { ...result, priorities: state.priorities };
      state = { ...state, cursor_at: read.read_to };
    }
  },
});
