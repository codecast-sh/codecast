// The per-session classifier for calibration (packages/evals/scripts/
// priorities-measure.ts --classifier).
//
// `evalClassify` replays a window for one person in one workspace against the
// priorities it is handed (the golden set's, seeded), writing nothing. It
// reads the window's sessions through passInputs, oldest first, and does for
// each what live would have done, as live would have seen it then:
//   - a fork, spawn worker or handoff whose parent the replay placed takes
//     its parent's placement, with no call (lib/priorityLinks inheritLink);
//   - else the classifier is asked at the session's first title (taken as its
//     first typed message) or first pin, whichever came first, and once more
//     at its first pin when the title's ask said "new"
//     (lib/priorityClassifierHook asksNow), each through sessionFor `asOf`
//     that moment: only the typed messages and task links made by then, the
//     pin only for a pin's ask, and no `serves` hint.
// Only sessions live would ask about (classifierReads) are asked. A placement
// joins its milestone in memory, so later sessions see it as an example, as
// they would live. Calls go on codecast's own key. Internal, so staff run it
// (packages/convex/run.sh).

import { v } from "convex/values";
import { internalAction, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { classifierPriorities, type ClassifierChoice, type ClassifierSession, type ClassifierTask } from "./lib/priorityClassifier";
import { classifierReads } from "./lib/priorityClassifierHook";
import type { PassPriority } from "./lib/priorityPass";
import { LATE_MARGIN_MS, MINUTE, type PassInputs } from "./priorityPassInputs";
import { classifierTasks, classifyOnce, sessionFor } from "./priorityClassifier";

// Codegen catches up on the next push.
const fns = internal as any;

/** No new chunk (at most 50 sessions, up to two calls each, in turn) starts past this: the action returns `resume` inside Convex's ten minutes. */
const EVAL_CHUNKS_START_WITHIN_MS = 3 * MINUTE;

export type ClassifierEvalState = { cursor_at: number; priorities: PassPriority[] };

/** What live would ask about one session, in order: its first title's or first pin's ask, then its first pin's after a "new". */
export type EvalAsk = { trigger: "title" | "pin"; at: number; session: ClassifierSession };
/** Keyed by conversation id (a short id is shared by other conversations); in production a short id is its first 7 characters, which the golden labels use. */
export type EvalSession = { id: string; title: string; last_active: number; parent: string | null; asks: EvalAsk[] };

export type ClassifierEvalResult = {
  /** One per session it placed or asked about, oldest first: the asks' choices in order, or the parent it inherited from. */
  placements: Array<{ session: string; title: string; choice: ClassifierChoice | null; asks: Array<{ trigger: string; choice: ClassifierChoice | null; error?: string }>; inherited_from?: string }>;
  /** The handed priorities, holding the sessions placed under them. */
  priorities: PassPriority[];
  /** Every session the window held for this workspace, asked about or not. */
  sessions_read: Array<{ id: string; title: string }>;
  cost_usd: number;
  /** Set when the window is not finished: call again with it as `resume`. */
  resume?: ClassifierEvalState;
};

/**
 * The window's sessions live would ask about, each with its parent (a fork,
 * spawn worker or handoff, not a Task-tool subagent) and its asks as of their
 * moments; and the tasks the priorities name. A session's first title is
 * taken at its first typed message (title generation runs at the second
 * message), else at its first activity in the window.
 */
export const evalFacts = internalQuery({
  args: {
    workspace: v.string(),
    /** The conversations passInputs read (PassInputs conversations), each with its first activity in the window. */
    sessions: v.array(v.object({ conversation_id: v.id("conversations"), first_at: v.number() })),
    tasks: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ sessions: EvalSession[]; tasks: ClassifierTask[] }> => {
    const sessions: EvalSession[] = [];
    for (const { conversation_id, first_at } of args.sessions) {
      const conv = await ctx.db.get(conversation_id);
      if (!conv || !classifierReads(conv)) continue;
      const firstTyped = await ctx.db.query("messages").withIndex("by_conversation_nav_prompt", (q) => q.eq("conversation_id", conv._id).eq("nav_prompt", true)).first();
      const firstPin = await ctx.db.query("thread_state_events").withIndex("by_conversation_at", (q) => q.eq("conversation_id", conv._id)).first();
      const titleAt = firstTyped?.timestamp ?? first_at;
      const ask = async (trigger: "title" | "pin", at: number): Promise<EvalAsk> => ({ trigger, at, session: await sessionFor(ctx, conv, args.workspace, { at, pin: trigger === "pin" }) });
      const asks = firstPin && firstPin.at <= titleAt
        ? [await ask("pin", firstPin.at)]
        : [await ask("title", titleAt), ...(firstPin ? [await ask("pin", firstPin.at)] : [])];
      sessions.push({ id: String(conv._id), title: conv.title ?? "", last_active: first_at, parent: conv.parent_conversation_id ? String(conv.parent_conversation_id) : null, asks });
    }
    return { sessions, tasks: [...(await classifierTasks(ctx, args.tasks, args.workspace)).values()] };
  },
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
    const placementOf = (session: string) => {
      for (const p of state.priorities) for (const s of p.sessions) if (s.id === session) return { priority: p.short_id, step: s.step_key };
      return null;
    };
    for (;;) {
      if (result.sessions_read.length && Date.now() - started > EVAL_CHUNKS_START_WITHIN_MS) return { ...result, priorities: state.priorities, resume: state };
      const read: PassInputs = await ctx.runQuery(fns.priorityPassInputs.passInputs, { user_id: args.user_id, workspace: args.workspace, now, window_start: state.cursor_at });
      const firstAt = (s: PassInputs["input"]["sessions"][number]) => Math.min(...[...s.typed, ...s.pin_events].map((r) => r.at), s.last_active);
      const facts: { sessions: EvalSession[]; tasks: ClassifierTask[] } = await ctx.runQuery(fns.priorityClassifierEval.evalFacts, {
        workspace: args.workspace,
        sessions: read.input.sessions.filter((s) => s.kind !== "role").map((s) => ({ conversation_id: read.conversations[s.id]!, first_at: firstAt(s) })),
        tasks: tasks ? [] : taskIds,
      });
      tasks ??= new Map(facts.tasks.map((t) => [t.short_id, t]));
      result.sessions_read.push(...read.input.sessions.map((s) => ({ id: String(read.conversations[s.id] ?? s.id), title: s.title })));
      // One at a time, as live: each session sees the ones placed before it.
      for (const s of facts.sessions) {
        const inherited = s.parent ? placementOf(s.parent) : null;
        let choice: ClassifierChoice | null = inherited;
        const asks: ClassifierEvalResult["placements"][number]["asks"] = [];
        if (!inherited) {
          for (const ask of s.asks) {
            if (asks.length && choice !== "new") break;
            const priorities = classifierPriorities(state.priorities.filter((p) => p.status === "active"), tasks);
            const reply = await classifyOnce(ctx, { person: read.input.person, priorities, session: ask.session }, args.workspace, false, args.model);
            result.cost_usd += reply.cost_usd;
            choice = reply.choice;
            asks.push({ trigger: ask.trigger, choice, ...(reply.error ? { error: reply.error } : {}) });
          }
        }
        result.placements.push({ session: s.id, title: s.title, choice, asks, ...(inherited ? { inherited_from: s.parent! } : {}) });
        if (!choice || choice === "new") continue;
        state.priorities.find((x) => x.short_id === choice.priority)?.sessions.unshift({ id: s.id, title: s.title, step_key: choice.step, last_active: s.last_active });
      }
      if (!read.more || read.read_to <= state.cursor_at) return { ...result, priorities: state.priorities };
      state = { ...state, cursor_at: read.read_to };
    }
  },
});
