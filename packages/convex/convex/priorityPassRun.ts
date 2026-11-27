// The priorities pass, run (lib/priorityPass.ts is its pure core): for one
// person in one workspace, read what they touched since the last pass
// (priorityPassInputs.ts), ask the model once, and write the plan. reserve
// holds the pair, runPass asks, applyPlan writes atomically. The person's
// activity schedules it (priorityPassSchedule.ts), a daily sweep catches what
// no hook saw (priorityPassSweep.ts); `cast priorities run` calls runNow.
//
// A run that reads more than one prompt holds moves the cursor to the last
// session it read and chains another run for the rest. A run that finds
// nothing of this workspace's moves the cursor past what it read; one that
// keeps failing on a cursor steps past it. Each pair spends at most
// PRIORITY_PASS_DAILY_USD a day.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { PRIORITY_CARDS_EXPERIMENT } from "@codecast/shared/contracts/priorityCard";
import { hasExperiment } from "./lib/experiments";
import { splitPlan } from "./lib/priorityCard";
import { cardDraft, type CardDraft } from "./lib/priorityCardPass";
import { postPriorityCard } from "./priorityCardPost";
import { nextShortId } from "./counters";
import { runModelCall, type CallScope } from "./modelCalls";
import { modelCallProblem } from "@codecast/shared/contracts/modelCall";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { sessionVisibility, type SessionVisibility } from "./lib/prioritySessionVisibility";
import { passOn } from "./lib/priorityPassSchedule";
import { askRerun } from "./lib/priorityClassifierHook";
import { recomputeStepDone } from "./lib/priorityLinks";
import { stepKeyMark } from "./lib/priorityGroup";
import { PRIORITY_PASS_MODEL, mergePriorities, priorityPassRequest, type MergePlan, type PriorityPassInput, type PriorityWrite } from "./lib/priorityPass";
import { stepKeyMax, holdPersonSteps, isPersonHeld, withPersonFields } from "./lib/priorityPassSteps";
import { SESSION_PAGE, clearDeadStepKeysNow, moveMergedSessionsNow, sessionMover } from "./priorityPassSessions";
import { parsePriorityPassOutput } from "./lib/priorityPassParse";
import type { PriorityStep } from "@codecast/shared/contracts/priorities";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { DAY, LATE_MARGIN_MS, MINUTE, RESERVATION_TTL_MS, cursorFor, firstAfter, inWorkspace, recentRuns, storedSessionId, type PassInputs } from "./priorityPassInputs";

/** Runs one pass chains for work that did not fit, the first included: the rest waits for the next pass. */
export const MAX_CHAINED_RUNS = 6;
const CHAIN_DELAY_MS = 2_000;
/** After this many failed runs in a row on one cursor, the last one steps the cursor past what failed. */
export const FAILURES_BEFORE_STEP = 3;
/** What one (person, workspace) may spend on passes in a day; past it, passes skip until older runs age out. */
export const PRIORITY_PASS_DAILY_USD = 5;
/**
 * A pair's first catch-up (its runs before any ok run, and the runs that run
 * chains) reads up to FIRST_PASS_WINDOW_MS of work at once: it spends from
 * this one-time allowance instead of the daily ceiling, which applies after.
 */
export const PRIORITY_PASS_FIRST_USD = 5;
/** The most of a pair's runs the catch-up allowance reads, newest first; a pair with more is past its catch-up. */
export const CATCH_UP_RUNS_READ = 1_000;
/** `cast priorities run` runs at most once in this long per (person, workspace). */
export const RUN_NOW_EVERY_MS = 10 * MINUTE;
/** A merge moves an absorbed priority's corrections to the survivor this many at a time, until none is left. */
export const CORRECTIONS_PAGE = 100;
/** How long the model may take: a full prompt and a long reply run minutes. */
export const PASS_TIMEOUT_MS = 5 * 60_000;
/** The most runs of one pair in a day a reservation reads. */
const RUNS_OF_DAY_READ = 500;
// Codegen catches up on the next push.
const self = (internal as any).priorityPassRun;
const inputs = (internal as any).priorityPassInputs;

type Counts = { created: number; updated: number; merged: number; mapped_sessions: number };
const NO_COUNTS: Counts = { created: 0, updated: 0, merged: 0, mapped_sessions: 0 };

export type PassResult = {
  status: "ok" | "error" | "skipped";
  reason?: string;
  /** Another run was scheduled for what this one did not read. */
  chained?: boolean;
  counts?: Counts;
  cost_usd?: number;
  /** What the reply named that the input did not show, and where a rule overrode the reply. */
  dropped?: string[];
  notes?: string[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const minutes = (ms: number) => Math.max(1, Math.ceil(ms / MINUTE));

type BlockerKind = "busy" | "daily_ceiling" | "throttled";
type Reservation = { run_id: Id<"priority_pass_runs">; catch_up: boolean } | { refused: BlockerKind; reason: string };

/** A run that asked the model (or settled as if it had): what the gap, the throttle and the ceiling count. */
export const isPaidRun = (r: Doc<"priority_pass_runs">): boolean => r.status === "ok" || r.status === "error" || (r.cost_usd ?? 0) > 0;

/** The pair's runs started in the last day, newest first. */
export const runsOfDay = (ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<Doc<"priority_pass_runs">[]> =>
  ctx.db
    .query("priority_pass_runs")
    .withIndex("by_user_workspace_started", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).gte("started_at", now - DAY))
    .order("desc")
    .take(RUNS_OF_DAY_READ);


/** Whether the pair has finished a run that wrote a plan: before one, a run is its first catch-up. */
export async function hasOkRun(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<boolean> {
  return !!(await ctx.db
    .query("priority_pass_runs")
    .withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).eq("status", "ok"))
    .first());
}

/**
 * What the pair's first catch-up has spent of PRIORITY_PASS_FIRST_USD: its
 * runs newest first, stopping once the allowance is spent. A pair with more
 * runs than CATCH_UP_RUNS_READ counts as spent, so however many cheap runs it
 * piles up, a catch-up never spends uncapped.
 */
export async function catchUpSpent(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<number> {
  let spent = 0;
  let read = 0;
  for await (const r of ctx.db.query("priority_pass_runs").withIndex("by_user_workspace_started", (q: any) => q.eq("user_id", userId).eq("workspace", workspace)).order("desc") as AsyncIterable<Doc<"priority_pass_runs">>) {
    if (r.catch_up) spent += r.cost_usd ?? 0;
    if (spent >= PRIORITY_PASS_FIRST_USD) return spent;
    if (++read >= CATCH_UP_RUNS_READ) return Infinity;
  }
  return spent;
}

/**
 * Why a run of the pair may not start now, or null; `catch_up` true when it
 * runs on the first catch-up's allowance. The daily ceiling counts only runs
 * outside the catch-up.
 */
export async function runBlocker(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number, runNow: boolean, catchUp = false): Promise<{ kind: BlockerKind; reason: string } | { catch_up: boolean } | null> {
  const day = await runsOfDay(ctx, userId, workspace, now);
  if (day.some((r) => r.status === "running" && r.started_at > now - RESERVATION_TTL_MS)) return { kind: "busy", reason: "A pass is already running here." };
  const paid = day.filter(isPaidRun).map((r) => r.started_at);
  const last = paid.length ? Math.max(...paid) : null;
  if (runNow && last !== null && now - last < RUN_NOW_EVERY_MS) {
    return { kind: "throttled", reason: `A pass ran here ${plural(minutes(now - last), "minute")} ago; run it again in ${plural(minutes(last + RUN_NOW_EVERY_MS - now), "minute")}.` };
  }
  if (catchUp && (await catchUpSpent(ctx, userId, workspace)) < PRIORITY_PASS_FIRST_USD) return { catch_up: true };
  if (day.filter((r) => !r.catch_up).reduce((sum, r) => sum + (r.cost_usd ?? 0), 0) >= PRIORITY_PASS_DAILY_USD) {
    return { kind: "daily_ceiling", reason: `Passes here spent today's $${PRIORITY_PASS_DAILY_USD.toFixed(2)}; the next one can run tomorrow.` };
  }
  return null;
}

/**
 * Reserves the pair for one run before it reads or pays, atomically: refused
 * while another run holds it (a reservation older than RESERVATION_TTL_MS is
 * dead and settled as abandoned), for `cast priorities run` within
 * RUN_NOW_EVERY_MS of the last run that asked the model, and once the pair's
 * runs cost PRIORITY_PASS_DAILY_USD in the last day (that refusal is recorded).
 */
export const reserve = internalMutation({
  args: { user_id: v.id("users"), workspace: v.string(), started_at: v.number(), cursor_at: v.number(), model: v.string(), run_now: v.boolean(), catch_up: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Reservation> => {
    const now = args.started_at;
    for (const r of await runsOfDay(ctx, args.user_id, args.workspace, now)) {
      if (r.status === "running" && r.started_at <= now - RESERVATION_TTL_MS) {
        await ctx.db.patch(r._id, { status: "error", error: "abandoned: the run stopped before it settled", finished_at: now });
      }
    }
    const { run_now, catch_up: firstCatchUp, ...run } = args;
    // A run is the first catch-up's when the chain says so, or when the pair has never finished one.
    const catchUp = firstCatchUp ?? !(await hasOkRun(ctx, args.user_id, args.workspace));
    const blocked = await runBlocker(ctx, args.user_id, args.workspace, now, run_now, catchUp);
    if (blocked && "kind" in blocked) {
      if (blocked.kind === "daily_ceiling") await ctx.db.insert("priority_pass_runs", { ...run, finished_at: now, status: "skipped", error: "daily ceiling", counts: NO_COUNTS });
      return { refused: blocked.kind, reason: blocked.reason };
    }
    const catch_up = !!blocked?.catch_up;
    return { run_id: await ctx.db.insert("priority_pass_runs", { ...run, finished_at: now, status: "running", counts: NO_COUNTS, ...(catch_up ? { catch_up } : {}) }), catch_up };
  },
});

type Gate = { on: boolean; cursor_at: number; budgeted: boolean; cards?: boolean };

/** Whether the pass may write here (passOn), the cursor, whether the workspace pays for model calls, and whether the person's changes go on a card (the priority_cards experiment). */
export const passGate = internalQuery({
  args: { user_id: v.id("users"), workspace: v.string() },
  handler: async (ctx, args): Promise<Gate> => {
    const on = await passOn(ctx, args.user_id, args.workspace);
    const budget = await ctx.db.query("team_budgets").withIndex("by_workspace", (q: any) => q.eq("workspace", args.workspace)).first();
    const cards = await hasExperiment(ctx, args.user_id, PRIORITY_CARDS_EXPERIMENT);
    return { on, cursor_at: await cursorFor(ctx, args.user_id, args.workspace, Date.now()), budgeted: (budget?.cap_usd ?? 0) > 0, ...(cards ? { cards } : {}) };
  },
});

const runRowArgs = {
  user_id: v.id("users"),
  workspace: v.string(),
  started_at: v.number(),
  cursor_at: v.number(),
  model: v.string(),
  cost_usd: v.optional(v.number()),
  /** The run's reservation, settled in place; absent for a run that never reserved (the feature was off). */
  run_id: v.optional(v.id("priority_pass_runs")),
};

type SettledRun = {
  user_id: Id<"users">; workspace: string; started_at: number; cursor_at: number; model: string; cost_usd?: number;
  status: "ok" | "error" | "skipped"; error?: string; repeats?: boolean; counts?: Counts; run_id?: Id<"priority_pass_runs">;
};

/** Settles a run: its reservation becomes the run's row, or a row is written when it had none. */
async function settleRun(ctx: { db: any }, { run_id, ...row }: SettledRun): Promise<Id<"priority_pass_runs">> {
  const fields = { ...row, counts: row.counts ?? NO_COUNTS, finished_at: Date.now() };
  const held: Doc<"priority_pass_runs"> | null = run_id ? await ctx.db.get(run_id) : null;
  if (!held) return ctx.db.insert("priority_pass_runs", fields);
  await ctx.db.patch(held._id, { ...fields, started_at: held.started_at });
  return held._id;
}

/**
 * A run that wrote no plan: skipped or failed, at the cursor it started from
 * (a skip that read everything up to `step_to` and found nothing here moves
 * it there). A failure that `repeats` (the same input fails the same way) and
 * is the FAILURES_BEFORE_STEP-th such in a row on one cursor steps it to
 * `step_to`, past what keeps failing, and says so. A passing failure (an
 * overloaded or unreachable model, no budget room) never moves the cursor.
 */
export const recordRun = internalMutation({
  args: { ...runRowArgs, status: v.union(v.literal("error"), v.literal("skipped")), error: v.optional(v.string()), step_to: v.optional(v.number()), repeats: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Id<"priority_pass_runs">> => {
    const { step_to, ...run } = args;
    // A run whose plan landed stays ok, whatever its action heard back.
    const held: Doc<"priority_pass_runs"> | null = run.run_id ? await ctx.db.get(run.run_id) : null;
    if (held?.status === "ok") return held._id;
    if (step_to === undefined || step_to <= run.cursor_at) return settleRun(ctx, run);
    if (run.status === "skipped") return settleRun(ctx, { ...run, cursor_at: step_to });
    if (!run.repeats) return settleRun(ctx, run);
    let failures = 1;
    for (const r of await recentRuns(ctx, run.user_id, run.workspace)) {
      if (r.status === "running" || r.status === "skipped" || (r.status === "error" && !r.repeats && r.cursor_at === run.cursor_at)) continue;
      if (r.status !== "error" || r.cursor_at !== run.cursor_at) break;
      failures++;
    }
    if (failures < FAILURES_BEFORE_STEP) return settleRun(ctx, run);
    return settleRun(ctx, { ...run, cursor_at: step_to, error: `${run.error ?? "failed"} (failed ${failures} times here: stepped past)` });
  },
});

/** A milestone whose done state its tasks or pull requests decide (lib/priorityLinks evidenceFor). */
const hasRecords = (st: { refs: Array<{ kind: string }> }) => st.refs.some((r) => r.kind === "task" || r.kind === "pr");

/** Plan fields as row fields: null clears a field on a patch and is left out of an insert. */
function rowFields(w: Record<string, unknown>, insert = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(w)) {
    if (val === null && insert) continue;
    out[k] = val === null ? undefined : val;
  }
  return out;
}

/** Moves every correction on `from` to `into`, a page at a time, each onto the step `stepFor` maps its step to. */
export async function moveCorrections(ctx: { db: any }, from: Id<"priorities">, into: Id<"priorities">, stepFor: (key: string | undefined) => string | undefined): Promise<void> {
  for (;;) {
    const page: Doc<"priority_corrections">[] = await ctx.db.query("priority_corrections").withIndex("by_priority_created", (q: any) => q.eq("priority_id", from)).take(CORRECTIONS_PAGE);
    for (const c of page) await ctx.db.patch(c._id, { priority_id: into, step_key: stepFor(c.step_key) });
    if (page.length < CORRECTIONS_PAGE) return;
  }
}


/**
 * A session that left this workspace lets go of the priority here, so its new
 * workspace's pass can map it. The priority's title and summary may have been
 * written from it: it needs a rewrite (hidden from teammates until then)
 * unless this plan rewrote it already (`rewritten`, short ids).
 */
async function letGoStrays(
  ctx: { db: any },
  vis: SessionVisibility,
  move: (conv: Doc<"conversations">, to: undefined, step_key: undefined) => Promise<void>,
  pair: { user_id: Id<"users">; workspace: string },
  strays: Id<"conversations">[],
  rewritten: Set<string> = new Set(),
): Promise<void> {
  for (const id of strays) {
    const conv: Doc<"conversations"> | null = await ctx.db.get(id);
    const held: Doc<"priorities"> | null = conv?.priority_id ? await ctx.db.get(conv.priority_id) : null;
    if (!conv || !held || (await inWorkspace(vis, conv, pair.user_id, pair.workspace)) || String(held.user_id) !== String(pair.user_id) || held.workspace !== pair.workspace) continue;
    await move(conv, undefined, undefined);
    if (!rewritten.has(held.short_id)) await ctx.db.patch(held._id, { needs_rewrite: true });
  }
}

/** A pair past its daily ceiling still lets go of sessions that left the workspace: that asks no model. Its next pass rewrites what held them. */
export const releaseStrays = internalMutation({
  args: { user_id: v.id("users"), workspace: v.string(), strays: v.array(v.id("conversations")) },
  handler: async (ctx, args): Promise<void> => {
    const { move, recount } = sessionMover(ctx);
    await letGoStrays(ctx, sessionVisibility(ctx), move, args, args.strays);
    await recount(args.user_id);
  },
});

/**
 * Writes one pass's plan, atomically, with its run row at `cursor_at`. Re-checks
 * what the plan cannot know: a priority belongs to this person and workspace,
 * a session is theirs and in this workspace, and everything the person set
 * stands, as the rows are now (so a setting made while the model was reading
 * holds too). The pass's output is rejected wherever it would change one: a
 * placed rank (the plan writes ai_rank, and person_pos only to carry a
 * merged priority's place to a survivor without one); a step's
 * tier, title, done state or drop (holdPersonSteps); a set-aside, done or merged status; a session the person placed,
 * a known link or the classifier mapped, or one
 * mapped to a priority they said it is not part of. A step added to a
 * priority since the input was read (a person's merge) is kept, and a new
 * step of the plan's that took its key gets the next one. A merge moves the
 * absorbed priority's corrections to the survivor. The pending corrections
 * the run read turn applied, with the window it read. A run that another ok run finished under since
 * it started writes nothing (null) and records the cursor it started from:
 * its plan was made from what that run has since changed.
 */
export const applyPlan = internalMutation({
  args: {
    ...runRowArgs, from_cursor: v.number(), plan: v.any(), conversations: v.optional(v.record(v.string(), v.id("conversations"))), strays: v.optional(v.array(v.id("conversations"))), corrections: v.optional(v.array(v.id("priority_corrections"))), superseded: v.optional(v.array(v.id("priority_corrections"))),
    /** Behind the priority cards experiment: `plan` is the run's direct part, and this the card for the rest (lib/priorityCardPass CardDraft), posted in this same write. */
    card: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<Counts | null> => {
    const { plan, from_cursor, conversations, strays, corrections, superseded, card, ...run } = args;
    const recent = await recentRuns(ctx, args.user_id, args.workspace);
    if (recent.some((r) => r.status === "ok" && r.finished_at > args.started_at)) {
      await settleRun(ctx, { ...run, cursor_at: from_cursor, status: "skipped", error: "superseded" });
      return null;
    }
    const counts = await writePlan(ctx, { user_id: args.user_id, workspace: args.workspace }, plan as MergePlan, { conversations, strays });
    const now = Date.now();

    for (const id of [...(corrections ?? []), ...(superseded ?? [])]) {
      const c: Doc<"priority_corrections"> | null = await ctx.db.get(id);
      if (c?.status === "pending" && !c.deleted_at && String(c.user_id) === String(args.user_id) && c.workspace === args.workspace) {
        await ctx.db.patch(id, { status: "applied", applied_at: now, applied_window: { from: from_cursor, to: args.cursor_at }, ...((superseded ?? []).includes(id) ? { superseded: true } : {}) });
      }
    }

    const run_id = await settleRun(ctx, { ...run, status: "ok", counts });
    if (card) {
      const posted = await postPriorityCard(ctx, { user_id: args.user_id, workspace: args.workspace, run_id, cost_usd: args.cost_usd, from: from_cursor, to: args.cursor_at, conversations }, card as CardDraft, now);
      if (posted && "skipped" in posted) await ctx.db.patch(run_id, { error: posted.skipped });
    }
    return counts;
  },
});

/**
 * A plan's writes (applyPlan's, and an answered priority card's through
 * lib/priorityCardApply), with no run bookkeeping: the checks against the rows
 * as they are now, as applyPlan describes them. `conversations` resolves the
 * session names the plan uses; `strays` are sessions that left the workspace.
 */
export async function writePlan(
  ctx: MutationCtx,
  args: { user_id: Id<"users">; workspace: string },
  plan: MergePlan,
  { conversations, strays }: { conversations?: Record<string, Id<"conversations">>; strays?: Id<"conversations">[] } = {},
): Promise<Counts> {
    const vis = sessionVisibility(ctx);
    const now = Date.now();
    const counts: Counts = { ...NO_COUNTS };
    const ids = new Map<string, Id<"priorities">>();
    const mine = async (shortId: string): Promise<Doc<"priorities"> | null> => {
      const row: Doc<"priorities"> | null = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
      return row && String(row.user_id) === String(args.user_id) && row.workspace === args.workspace ? row : null;
    };
    const resolve = async (target: string): Promise<Id<"priorities"> | null> => ids.get(target) ?? (await mine(target))?._id ?? null;

    // A session name the input showed resolves to the conversation it named (passInputs sessionNames). Any other ref (a
    // stored one, or a test's) resolves as the person's own in this workspace, oldest first: a stored ref named a session
    // no older conversation shared it with (storedSessionId), so a newer one sharing it is not the one meant.
    const conversationOf = async (ref: string): Promise<Doc<"conversations"> | null> => {
      const named = conversations?.[ref];
      if (named) {
        const conv: Doc<"conversations"> | null = await ctx.db.get(named);
        return conv && (await inWorkspace(vis, conv, args.user_id, args.workspace)) ? conv : null;
      }
      return findConversationByAnyRefWhere(ctx, ref, (c) => inWorkspace(vis, c, args.user_id, args.workspace), (c) => c._creationTime);
    };
    // A step's new session ref is stored as storedSessionId of the conversation it names, so later reads land on it; one
    // the row already holds stays as it is, with no read (the input showed stored refs as stored).
    const storedRefs = new Map<string, Promise<string>>();
    const storedRef = (ref: string) => {
      if (!storedRefs.has(ref)) storedRefs.set(ref, conversationOf(ref).then((c) => (c ? storedSessionId(ctx, c) : ref)));
      return storedRefs.get(ref)!;
    };
    const sessionRefs = (steps: PriorityStep[]) => new Set(steps.flatMap((st) => st.refs.filter((r) => r.kind === "session").map((r) => r.id)));
    const storeRefs = (steps: PriorityStep[], held: Set<string>) =>
      Promise.all(steps.map(async (st) => ({ ...st, refs: await Promise.all(st.refs.map(async (r) => (r.kind === "session" && !held.has(r.id) ? { ...r, id: await storedRef(r.id) } : r))) })));
    for (const c of plan.creates) c.steps = await storeRefs(c.steps, new Set());
    for (const u of plan.updates) if (u.patch.steps) u.patch.steps = await storeRefs(u.patch.steps, sessionRefs((await mine(u.short_id))?.steps ?? []));

    for (const c of plan.creates) {
      const { ref, ...w } = c;
      const short_id = await nextShortId(ctx.db, "pri");
      const id = await ctx.db.insert("priorities", {
        ...(rowFields(w, true) as any),
        user_id: args.user_id,
        workspace: args.workspace,
        short_id,
        session_count: 0,
        step_key_max: stepKeyMax(w.steps),
        created_at: now,
        updated_at: now,
      });
      ids.set(ref, id);
      counts.created++;
      // A milestone born done takes its done time from its tasks and pull requests, not this pass (a catch-up builds from last week's).
      for (const st of w.steps) if (st.done && hasRecords(st)) await recomputeStepDone(ctx, id, st.key);
    }

    // Per priority this plan rewrote: its live step keys after the write, and the plan's new keys that moved.
    const liveSteps = new Map<string, Set<string>>();
    const rekeyed = new Map<string, Map<string, string>>();
    // Per priority whose milestones this plan removed, those milestones as they were: a session on a key no live milestone holds loses the step, unless it anchors a removed one.
    const gone = new Map<Id<"priorities">, Doc<"priorities">["steps"]>();
    const stepMarks = new Map<Id<"priorities">, number>();
    let newMilestone = false;
    for (const u of plan.updates) {
      const row = await mine(u.short_id);
      if (!row || row.status === "merged") continue;
      const patch: Partial<PriorityWrite> = { ...u.patch };
      // A merge survivor's carried place lands only where the person has not placed it since.
      if (row.person_pos != null) delete patch.person_pos;
      if (row.status === "set_aside" || row.status_set_by === "person") {
        delete patch.status;
        delete patch.done_at;
        if (row.status !== "active") delete patch.ai_rank;
      }
      if (patch.steps) {
        const seen = new Set(u.seen_steps ?? row.steps.map((st) => st.key));
        const unseen = row.steps.filter((st) => !seen.has(st.key));
        // Keys this priority has spent (its mark, worked out once for one written before it), and the plan's new ones that would reuse one.
        const spentUpTo = await stepKeyMark(ctx, row);
        const known = new Set(row.steps.map((st) => st.key));
        const reuses = (key: string) => !known.has(key) && stepKeyMax([{ key }]) <= spentUpTo;
        let next = stepKeyMax([...row.steps, ...patch.steps], spentUpTo);
        const moved = new Map<string, string>();
        const steps = patch.steps.map((st) => {
          if (!unseen.some((x) => x.key === st.key) && !reuses(st.key)) return st;
          moved.set(st.key, `s${++next}`);
          return { ...st, key: moved.get(st.key)! };
        });
        // A milestone carried in from a priority this plan merges stands as the person left it there since the input was read: dropped, renamed, re-tiered or done.
        for (const m of plan.merges) {
          const absorbed = m.merged_into === row.short_id ? await mine(m.short_id) : null;
          for (const [from, to] of absorbed ? Object.entries(m.step_keys ?? {}) : []) {
            const was = absorbed!.steps.find((st) => st.key === from);
            const key = moved.get(to) ?? to;
            const i = steps.findIndex((st) => st.key === key);
            if (was && i >= 0 && isPersonHeld(was)) steps[i] = withPersonFields(steps[i], { ...was, key });
          }
        }
        // A milestone a session the person placed, or a known link, sits on stays: read its sessions only when the plan would remove one.
        const proposedKeys = new Set([...steps, ...unseen].filter((st) => !st.dropped).map((st) => st.key));
        const removing = new Set(row.steps.filter((st) => !st.dropped && !proposedKeys.has(st.key)).map((st) => st.key));
        const anchored = new Set<string>();
        if (removing.size) {
          // The newest first: past SESSION_COUNT_CAP, the ones a person placed most recently are the ones seen.
          for (const conv of await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", row._id)).order("desc").take(SESSION_PAGE)) {
            if ((conv.priority_set_by === "person" || conv.priority_set_by === "link") && conv.priority_step_key && removing.has(conv.priority_step_key)) anchored.add(conv.priority_step_key);
          }
        }
        patch.steps = holdPersonSteps(row.steps, [...steps, ...unseen], [], "", anchored);
        const live = new Set(patch.steps.filter((st) => !st.dropped).map((st) => st.key));
        liveSteps.set(row.short_id, live);
        const removed = row.steps.filter((st) => !st.dropped && !live.has(st.key));
        if (removed.length) gone.set(row._id, removed);
        stepMarks.set(row._id, Math.max(next, stepKeyMax(patch.steps)));
        newMilestone ||= patch.steps.some((st) => !st.dropped && !row.steps.some((x) => x.key === st.key));
        if (moved.size) rekeyed.set(row.short_id, moved);
      }
      // A rewrite the priority needed is done: its title and summary are this pass's.
      const rewrote = plan.rewritten.includes(row.short_id) ? { needs_rewrite: undefined } : {};
      // Every key it has held stays spent: the mark only rises.
      const mark = stepMarks.has(row._id) ? { step_key_max: stepMarks.get(row._id)! } : {};
      await ctx.db.patch(row._id, { ...(rowFields(patch) as any), ...rewrote, ...mark, updated_at: now });
      counts.updated++;
      // A milestone this write leaves done, or whose done state it changed, follows its tasks and pull requests as they are now
      // (lib/priorityLinks): done_at is theirs, and a plan made before a task closed, or one that flips a merged milestone, never undoes them.
      for (const st of patch.steps ?? []) {
        const before = row.steps.find((x) => x.key === st.key);
        if (hasRecords(st) && (st.done || (before && (before.done !== st.done || before.done_at !== st.done_at)))) await recomputeStepDone(ctx, row._id, st.key);
      }
    }

    const mergedInto = new Map<Id<"priorities">, { into: Id<"priorities">; intoRow: Doc<"priorities">; step_keys: Record<string, string> }>();
    for (const m of plan.merges) {
      const row = await mine(m.short_id);
      const into = await resolve(m.merged_into);
      const intoRow: Doc<"priorities"> | null = into ? await ctx.db.get(into) : null;
      if (!row || !into || !intoRow || row.status === "set_aside" || row.status === "merged" || row.status_set_by === "person" || intoRow.status === "merged") continue;
      await ctx.db.patch(row._id, { status: "merged", merged_into: into, ai_rank: undefined, updated_at: now });
      // A milestone of the absorbed priority a session the person placed (or a known link) sits on goes to the survivor too, as a person's merge carries every one
      // (priorities.ts doMerge): the plan saw only its newest sessions. One the plan mapped live already has its key.
      const step_keys: Record<string, string> = { ...(m.step_keys ?? {}) };
      // A key the plan gave the survivor that this write moved (a person took it since the input was read): the moved key.
      for (const k of Object.keys(step_keys)) step_keys[k] = rekeyed.get(intoRow.short_id)?.get(step_keys[k]) ?? step_keys[k];
      const survivorLive = liveSteps.get(intoRow.short_id) ?? new Set(intoRow.steps.filter((st) => !st.dropped).map((st) => st.key));
      const held = new Set<string>();
      // Its newest page of sessions, as the anchors of a plain rewrite are read.
      for (const conv of await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", row._id)).order("desc").take(SESSION_PAGE)) {
        if ((conv.priority_set_by === "person" || conv.priority_set_by === "link") && conv.priority_step_key) held.add(conv.priority_step_key);
      }
      const carried = row.steps.filter((st) => !st.dropped && held.has(st.key) && !(step_keys[st.key] && survivorLive.has(step_keys[st.key])));
      // Its tombstones as the row has them now (one the person dropped after the plan's input was read included), unless the survivor holds that drop already.
      const tombstones = row.steps.filter((st) => st.dropped && !intoRow.steps.some((x) => x.dropped && x.title === st.title));
      let survivor = intoRow;
      if (carried.length || tombstones.length) {
        let next = stepKeyMax(intoRow.steps, await stepKeyMark(ctx, intoRow));
        const added = [...carried, ...tombstones].map((st) => {
          const key = `s${++next}`;
          if (!st.dropped) {
            step_keys[st.key] = key;
            survivorLive.add(key);
          }
          return { ...st, key };
        });
        survivor = { ...intoRow, steps: [...intoRow.steps, ...added], step_key_max: next };
        await ctx.db.patch(into, { steps: survivor.steps, step_key_max: next, updated_at: now });
        liveSteps.set(intoRow.short_id, survivorLive);
      }
      mergedInto.set(row._id, { into, intoRow: survivor, step_keys });
      counts.merged++;
      // Every one of its corrections follows it, onto the step their step became (step-less when that is unknown).
      await moveCorrections(ctx, row._id, into, (key) => {
        const to = key ? step_keys[key] : undefined;
        return to && survivorLive.has(to) ? to : undefined;
      });
    }

    const { move, recount } = sessionMover(ctx);

    // The person's placement and a known link's stand, and a priority they said a session is not part of never gets it.
    // The pass may revise a classifier's filing, a first guess from a session's opening.
    const refused = (conv: Doc<"conversations">, to?: Id<"priorities">) =>
      conv.priority_set_by === "person" || conv.priority_set_by === "link" || (!!to && (conv.priority_not ?? []).some((id) => String(id) === String(to)));
    for (const s of plan.sessions) {
      const conv = await conversationOf(s.session);
      const priority = await resolve(s.priority);
      if (!conv || !priority || refused(conv, priority)) continue;
      const target: Doc<"priorities"> | null = await ctx.db.get(priority);
      if (!target || target.status === "merged") continue;
      // A step key this write moved: the moved key. One the priority does not hold live as written (left out, or dropped, whether or not this plan touched its steps): no step.
      let step_key = s.step_key ?? undefined;
      if (step_key) step_key = rekeyed.get(s.priority)?.get(step_key) ?? step_key;
      if (step_key && !target.steps.some((st) => st.key === step_key && !st.dropped)) step_key = undefined;
      await move(conv, priority, step_key);
      counts.mapped_sessions++;
    }
    for (const ref of plan.unmap) {
      const conv = await conversationOf(ref);
      const held: Doc<"priorities"> | null = conv?.priority_id ? await ctx.db.get(conv.priority_id) : null;
      if (!conv || refused(conv) || (held && (String(held.user_id) !== String(args.user_id) || held.workspace !== args.workspace))) continue;
      await move(conv, undefined, undefined);
    }
    await letGoStrays(ctx, vis, move, args, strays ?? [], new Set(plan.rewritten));
    // A merged priority's sessions the plan did not list (the input shows only its newest) go to the survivor, step unknown;
    // one the person placed or a link mapped keeps its milestone there, a classifier's keeps its mark, and one they said is not part of the survivor lets go.
    // Every one of them, however many, a page now and the rest by scheduled runs: a merge leaves none behind on a merged priority.
    for (const [from, { into, step_keys }] of mergedInto) await moveMergedSessionsNow(ctx, from, into, step_keys, { user_id: args.user_id, workspace: args.workspace });

    // A session on a milestone this plan removed, or on a key no milestone holds (left from before), keeps the priority, step unknown, whoever put it there.
    for (const [id, removed] of gone) await clearDeadStepKeysNow(ctx, id, removed);

    await recount(args.user_id);
    // A new priority or milestone: the classifier asks again about the sessions it left unassigned.
    if (counts.created || newMilestone) await askRerun(ctx, args.user_id, args.workspace);
    return counts;
}

export function callScope(workspace: string): CallScope {
  const ws = parseWorkspaceKey(workspace);
  return ws?.type === "team" ? { workspace, team_id: ws.teamId } : { workspace };
}

/** How many of the sessions (oldest first) one prompt holds whole: at least one, so a chain always moves. */
export function fittingPrefix(input: PriorityPassInput): number {
  const fits = (k: number) => priorityPassRequest({ ...input, sessions: input.sessions.slice(0, k) }).omitted.length === 0;
  let lo = 0, hi = input.sessions.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(input.sessions.length, Math.max(1, lo));
}

/**
 * One run's share of what it read: the first `included` sessions, the calls
 * up to where its cursor goes (a call goes to the one run whose window holds
 * it), and that cursor: read_to when every session fit, else just before the
 * first session left out, which the next run reads from its start.
 */
export function runShare(read: PassInputs, input: PriorityPassInput, included: number): { input: PriorityPassInput; readTo: number; left: boolean } {
  const cut = included < input.sessions.length;
  const readTo = cut ? Math.max(read.cursor_at, firstAfter(input.sessions[included], read.cursor_at) - 1) : read.read_to;
  return { input: { ...input, sessions: input.sessions.slice(0, included), calls: input.calls.filter((c) => c.at <= readTo) }, readTo, left: read.more || cut };
}

type PassArgs = { user_id: Id<"users">; workspace: string; force?: boolean; chain?: number; now?: boolean; catch_up?: boolean };

/** Model-call failures that come back the same on the same input: a reply with no whole JSON, or a call the spec check refuses. */
const REPEATING_CALL_ERRORS = /^the answer (held no JSON|ran past max_tokens)/;

/** A plan that failed to land for a reason the next try need not share: a write conflict that outlasted Convex's retries. A timeout is not one: a plan too big for one transaction times out on every try. */
const TRANSIENT_APPLY_ERRORS = /changed while this mutation was being run|OptimisticConcurrency/;

async function pass(ctx: any, args: PassArgs): Promise<PassResult> {
  const started_at = Date.now();
  const pair = { user_id: args.user_id, workspace: args.workspace };
  const base = { ...pair, started_at, model: PRIORITY_PASS_MODEL };
  const gate: Gate = await ctx.runQuery(self.passGate, pair);
  if (!gate.on) {
    await ctx.runMutation(self.recordRun, { ...base, cursor_at: gate.cursor_at, status: "skipped", error: "the priorities feature is off here" });
    return { status: "skipped", reason: "feature_off" };
  }
  const held: Reservation = await ctx.runMutation(self.reserve, { ...base, cursor_at: gate.cursor_at, run_now: !!args.now, ...(args.catch_up !== undefined ? { catch_up: args.catch_up } : {}) });
  if ("refused" in held) {
    // The day's ceiling holds back the model, not letting go of sessions that left: that costs nothing.
    if (held.refused === "daily_ceiling") {
      try {
        const read: PassInputs = await ctx.runQuery(inputs.passInputs, { ...pair, window_start: gate.cursor_at });
        if (read.strays.length) await ctx.runMutation(self.releaseStrays, { ...pair, strays: read.strays });
      } catch (e) {
        const error = `letting go of sessions that left failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
        await ctx.runMutation(self.recordRun, { ...base, cursor_at: gate.cursor_at, status: "error", error });
      }
    }
    return { status: "skipped", reason: held.reason };
  }
  const run_id = held.run_id;

  let read: PassInputs;
  try {
    read = await ctx.runQuery(inputs.passInputs, { ...pair, window_start: gate.cursor_at });
  } catch (e) {
    // A read that keeps failing (a read limit) steps past a day of activity after FAILURES_BEFORE_STEP tries.
    const error = `reading the inputs failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    await ctx.runMutation(self.recordRun, { ...base, run_id, cursor_at: gate.cursor_at, status: "error", error, repeats: true, step_to: Math.min(gate.cursor_at + DAY, started_at - LATE_MARGIN_MS) });
    return { status: "error", reason: error };
  }
  const { cursor_at } = read;
  // A priority that needs a rewrite (it held a session since gone from here) is work too, and so is a correction no pass has read.
  if (!read.input.sessions.length && !read.input.calls.length && !args.force && !read.input.priorities.some((p) => p.needs_rewrite) && !read.corrections.length && !read.superseded.length) {
    // Nothing of this workspace's in what was read: the cursor moves past it, so other workspaces' activity is not read again.
    await ctx.runMutation(self.recordRun, { ...base, run_id, cursor_at, status: "skipped", error: "nothing touched since the last pass", step_to: read.read_to });
    const chained = read.more && (args.chain ?? 0) + 1 < MAX_CHAINED_RUNS;
    if (chained) await ctx.scheduler.runAfter(CHAIN_DELAY_MS, self.runPass, { ...pair, chain: (args.chain ?? 0) + 1, catch_up: held.catch_up });
    return { status: "skipped", reason: "nothing_new", ...(chained ? { chained } : {}) };
  }
  const { input, readTo, left } = runShare(read, read.input, fittingPrefix(read.input));
  const { req } = priorityPassRequest(input, gate.cards ? { why: true } : {});
  const spec = { model: req.model, max_tokens: req.max_tokens, system: req.system, prompt: req.prompt, output: "json" as const, output_schema: req.output_schema };
  const reply = await runModelCall(
    ctx,
    callScope(args.workspace),
    "grouping",
    spec,
    "Priority pass",
    PASS_TIMEOUT_MS,
    { budgeted: gate.budgeted },
  );
  const fail = async (error: string, repeats: boolean): Promise<PassResult> => {
    await ctx.runMutation(self.recordRun, { ...base, run_id, cursor_at, cost_usd: reply.cost_usd, status: "error", error, repeats, step_to: readTo });
    return { status: "error", reason: error, cost_usd: reply.cost_usd };
  };
  if (!reply.ok) {
    if (reply.reason === "budget") return fail(`budget: ${reply.error}`, false);
    return fail(reply.error, REPEATING_CALL_ERRORS.test(reply.error) || modelCallProblem(spec) !== null);
  }
  const { output, dropped } = parsePriorityPassOutput(reply.json, input);
  if (!output) return fail(`unreadable reply: ${dropped.join("; ")}`, true);
  const plan = mergePriorities(input, output);
  // Behind the priority cards experiment only the direct part is written; every other change goes on the card, posted in the same write.
  const split = gate.cards ? splitPlan(plan, input, output) : null;
  const card = split ? { card: cardDraft(split, plan, input, output) } : {};
  // A plan that fails to land still cost the call: record it (the day's ceiling counts it), and a repeat failure steps the cursor past after FAILURES_BEFORE_STEP.
  let counts: Counts | null;
  try {
    counts = await ctx.runMutation(self.applyPlan, { ...base, run_id, cursor_at: readTo, from_cursor: cursor_at, cost_usd: reply.cost_usd, plan: split ? split.direct : plan, conversations: read.conversations, strays: read.strays, corrections: read.corrections, superseded: read.superseded, ...card });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(`applying the plan failed: ${message}`.slice(0, 500), !TRANSIENT_APPLY_ERRORS.test(message));
  }
  if (!counts) return { status: "skipped", reason: "superseded", cost_usd: reply.cost_usd };
  const chain = (args.chain ?? 0) + 1;
  const chained = left && chain < MAX_CHAINED_RUNS;
  if (chained) await ctx.scheduler.runAfter(CHAIN_DELAY_MS, self.runPass, { ...pair, chain, catch_up: held.catch_up });
  return { status: "ok", counts, cost_usd: reply.cost_usd, dropped, notes: plan.notes, ...(chained ? { chained } : {}) };
}

/**
 * One pass for one person in one workspace. Skips (and records why) when the
 * feature is off, the pair spent its day's ceiling, or nothing moved and it is
 * not forced. `chain` counts the runs before it in one chain (MAX_CHAINED_RUNS).
 */
export const runPass = internalAction({
  args: { user_id: v.id("users"), workspace: v.string(), force: v.optional(v.boolean()), chain: v.optional(v.number()), catch_up: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<PassResult> => pass(ctx, args),
});

/** `cast priorities run`: a pass now, even when nothing moved since the last one; at most once in RUN_NOW_EVERY_MS, refused with a plain reason. */
export const runNow = internalAction({
  args: { user_id: v.id("users"), workspace: v.string() },
  handler: async (ctx, args): Promise<PassResult> => pass(ctx, { ...args, force: true, now: true }),
});
