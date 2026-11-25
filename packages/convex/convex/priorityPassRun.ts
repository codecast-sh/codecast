// The priorities pass, run (lib/priorityPass.ts is its pure core): for one
// person in one workspace, read what they touched since the last pass, ask the
// model once, and write the plan. passInputs gathers, runPass asks, applyPlan
// writes atomically. A cron sweeps every few hours; `cast priorities run`
// calls runNow.
//
// Every run leaves one priority_pass_runs row, and the furthest cursor_at
// among the recent rows is where the next run starts (runs finish out of
// order). Sessions are read oldest first: when more moved than one prompt
// holds, the run reads as many as fit, moves the cursor to the last of them,
// and chains another run for the rest. A run that finds nothing of this
// workspace's moves the cursor past what it read; one that keeps failing on a
// cursor steps past it. Each pair spends at most PRIORITY_PASS_DAILY_USD a day.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { nextShortId } from "./counters";
import { runModelCallOrOwn, type CallScope } from "./modelCalls";
import { workspaceForConversation } from "./lib/access";
import { parseWorkspaceKey, workspaceKey } from "./lib/accessKeys";
import { isTeamMember } from "./privacy";
import { teamHasFeature, workspaceHasFeature } from "./lib/teamFeatureGuard";
import { vendorRefusalFromDb } from "./lib/vendorGuard";
import {
  PRIORITY_PASS_CAPS,
  PRIORITY_PASS_MODEL,
  mergePriorities,
  parsePriorityPassOutput,
  priorityPassRequest,
  type MergePlan,
  type PassPriority,
  type PassSession,
  type PassTask,
  type PriorityPassInput,
  type PriorityWrite,
} from "./lib/priorityPass";

const DAY = 86_400_000;
const MINUTE = 60_000;
/** A first pass reads this far back. */
export const FIRST_PASS_WINDOW_MS = 14 * DAY;
/**
 * A typed message is stamped with its client time and can land minutes later
 * (or hours, after an offline sync): a pass reads only up to this long ago, and
 * re-reads this far below its cursor for rows that landed since.
 */
export const LATE_MARGIN_MS = 5 * MINUTE;
export const OVERLAP_MS = 10 * MINUTE;
/** The oldest typed messages and pin events one pass reads (each). A typed message holds up to 8 KB: this keeps a pass far under the read limit. */
const ACTIVITY_READ = 1_000;
/** The sessions touched earliest that one pass reads; the prompt may fit fewer. */
const SESSIONS_READ = 120;
/** Runs one pass chains for work that did not fit, the first included: the rest waits for the next sweep. */
export const MAX_CHAINED_RUNS = 6;
const CHAIN_DELAY_MS = 2_000;
/** After this many failed runs in a row on one cursor, the last one steps the cursor past what failed. */
export const FAILURES_BEFORE_STEP = 3;
/** What one (person, workspace) may spend on passes in a day; past it, passes skip until older runs age out. */
export const PRIORITY_PASS_DAILY_USD = 1.5;
/** `cast priorities run` runs at most once in this long per (person, workspace). */
export const RUN_NOW_EVERY_MS = 10 * MINUTE;
const TASKS_PER_SESSION = 12;
const PR_LINKS_PER_SESSION = 10;
/** Pull request rows one pass loads beyond what sessions fold: a row carries its files and can reach 1 MB. */
const PR_ROWS_READ = 8;
const PRIORITIES_READ = 200;
const INITIATIVES_READ = 200;
/** How long the model may take: a full prompt and a long reply run minutes. */
const PASS_TIMEOUT_MS = 5 * 60_000;
/** (person, workspace) pairs one sweep runs; the rest wait for the next sweep. */
export const SWEEP_MAX_PAIRS = 40;
const SWEEP_STAGGER_MS = 5_000;

/** Typed messages and pins a sweep reads per pair to see whether anything moved there. */
const SWEEP_ACTIVITY_READ = 300;
/** The newest runs read for the cursor, failures and the day's spend's recent end. */
const RECENT_RUNS = 30;
// Codegen catches up on the next push.
const self = (internal as any).priorityPassRun;

const LIVE_STATUSES = ["active", "done", "quiet", "set_aside"] as const;

type Counts = { created: number; updated: number; merged: number; mapped_sessions: number };
const NO_COUNTS: Counts = { created: 0, updated: 0, merged: 0, mapped_sessions: 0 };

export type PassInputs = {
  input: PriorityPassInput;
  /** Where this run started reading. */
  cursor_at: number;
  /** More moved since the cursor than was read: another run picks it up. */
  more: boolean;
  /** Where the cursor goes when every returned session is read. */
  read_to: number;
};

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

const sessionId = (conv: Doc<"conversations">) => conv.short_id ?? String(conv._id);
const inWorkspace = (conv: Doc<"conversations">, userId: Id<"users">, workspace: string) =>
  String(conv.user_id) === String(userId) && workspaceKey(workspaceForConversation(conv)) === workspace;

/** The pair's newest runs by start, newest first. */
const recentRuns = (ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<Doc<"priority_pass_runs">[]> =>
  ctx.db
    .query("priority_pass_runs")
    .withIndex("by_user_workspace_started", (q: any) => q.eq("user_id", userId).eq("workspace", workspace))
    .order("desc")
    .take(RECENT_RUNS);

/**
 * The pair's cursor: the furthest any recent run read (runs finish out of
 * order, so the newest started is not always the furthest), and when the
 * first run to reach it started: rows that landed before then were read.
 */
async function cursorState(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<{ cursor_at: number; set_at: number } | null> {
  let best: { cursor_at: number; set_at: number } | null = null;
  for (const r of await recentRuns(ctx, userId, workspace)) {
    if (!best || r.cursor_at > best.cursor_at) best = { cursor_at: r.cursor_at, set_at: r.started_at };
    else if (r.cursor_at === best.cursor_at) best.set_at = Math.min(best.set_at, r.started_at);
  }
  return best;
}

async function cursorFor(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<number> {
  return (await cursorState(ctx, userId, workspace))?.cursor_at ?? now - FIRST_PASS_WINDOW_MS;
}

/**
 * The person's typed messages and pin events in (since, until], oldest first,
 * and how far that read is complete (`read_to`). When either list fills its
 * limit, both stop short of where it stopped.
 */
async function activitySince(ctx: { db: any }, userId: Id<"users">, since: number, until: number, limit = ACTIVITY_READ) {
  let sends: Doc<"user_sends">[] = await ctx.db
    .query("user_sends")
    .withIndex("by_user_timestamp", (q: any) => q.eq("user_id", userId).gt("timestamp", since).lte("timestamp", until))
    .take(limit);
  let pins: Doc<"thread_state_events">[] = await ctx.db
    .query("thread_state_events")
    .withIndex("by_user_at", (q: any) => q.eq("user_id", userId).gt("at", since).lte("at", until))
    .take(limit);
  const horizon = Math.min(sends.length === limit ? sends[limit - 1].timestamp : Infinity, pins.length === limit ? pins[limit - 1].at : Infinity);
  if (horizon !== Infinity) {
    sends = sends.filter((s) => s.timestamp < horizon);
    pins = pins.filter((p) => p.at < horizon);
  }
  return { sends, pins, more: horizon !== Infinity, read_to: horizon !== Infinity ? horizon - 1 : until };
}

/** The tasks a session links (the association rail, the tasks it filed, its active task), in this workspace. */
async function sessionTasks(ctx: { db: any }, conv: Doc<"conversations">, workspace: string): Promise<PassTask[]> {
  const ids = new Set<string>();
  const rail = await ctx.db.query("entity_conversations").withIndex("by_conversation", (q: any) => q.eq("conversation_id", conv._id)).take(50);
  for (const row of rail) if (row.entity_type === "task") ids.add(String(row.entity_id));
  const filed = await ctx.db.query("tasks").withIndex("by_created_from_conversation", (q: any) => q.eq("created_from_conversation", conv._id)).take(TASKS_PER_SESSION);
  for (const t of filed) ids.add(String(t._id));
  if (conv.active_task_id) ids.add(String(conv.active_task_id));
  const out: PassTask[] = [];
  for (const raw of ids) {
    if (out.length >= TASKS_PER_SESSION) break;
    const id = ctx.db.normalizeId("tasks", raw);
    const t: Doc<"tasks"> | null = id ? await ctx.db.get(id) : null;
    if (t && t.workspace === workspace) out.push({ short_id: t.short_id, title: t.title, status: t.status });
  }
  return out;
}

/**
 * The pull requests a session links: the one it shepherds (folded on the row,
 * no read), then its linked rows, its own commits first, while the pass's
 * row budget lasts.
 */
async function sessionPrs(ctx: { db: any }, conv: Doc<"conversations">, budget: { left: number; seen: Map<string, { ref: string; merged: boolean }> }) {
  const out = new Map<string, { ref: string; merged: boolean }>();
  if (conv.pr_status) out.set(String(conv.pr_status.pr_id), { ref: `${conv.pr_status.repository}#${conv.pr_status.number}`, merged: conv.pr_status.state === "merged" });
  const links = await ctx.db.query("pull_request_sessions").withIndex("by_conversation", (q: any) => q.eq("conversation_id", conv._id)).take(PR_LINKS_PER_SESSION);
  links.sort((a: any, b: any) => Number(b.tier === "committed") - Number(a.tier === "committed"));
  for (const link of links) {
    const key = String(link.pull_request_id);
    if (out.has(key)) continue;
    let pr = budget.seen.get(key);
    if (!pr) {
      if (budget.left <= 0) break;
      budget.left--;
      const row: Doc<"pull_requests"> | null = await ctx.db.get(link.pull_request_id);
      if (!row) continue;
      pr = { ref: `${row.repository}#${row.number}`, merged: row.state === "merged" };
      budget.seen.set(key, pr);
    }
    out.set(key, pr);
  }
  return [...out.values()];
}

/**
 * Assembles the pass's input for one person in one workspace: what they
 * touched since the cursor, and their priorities now. A session filed under a
 * team whose data may not go to the model vendor is left out, whichever
 * workspace it reads in.
 */
export const passInputs = internalQuery({
  args: { user_id: v.id("users"), workspace: v.string(), now: v.optional(v.number()), window_start: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PassInputs> => {
    const now = args.now ?? Date.now();
    const state = await cursorState(ctx, args.user_id, args.workspace);
    const cursor_at = args.window_start ?? state?.cursor_at ?? now - FIRST_PASS_WINDOW_MS;
    // Below a run's cursor, only rows that landed after that run started are new.
    const overlap = state && state.cursor_at === cursor_at ? state : null;
    const until = Math.max(cursor_at, now - LATE_MARGIN_MS);
    const read = await activitySince(ctx, args.user_id, overlap ? cursor_at - OVERLAP_MS : cursor_at, until);
    const fresh = (at: number, landed: number) => !overlap || at > cursor_at || landed > overlap.set_at;
    const sends = read.sends.filter((s) => fresh(s.timestamp, s._creationTime));
    const pins = read.pins.filter((p) => fresh(p.at, p._creationTime));

    // A session may go to the model unless its team's data may not; one read per team.
    const refusals = new Map<string, boolean>();
    const mayRead = async (conv: Doc<"conversations">) => {
      const key = String(conv.team_id ?? "");
      if (!refusals.has(key)) refusals.set(key, (await vendorRefusalFromDb(ctx, { workspace: args.workspace, conversationId: conv._id }, "anthropic")) !== null);
      return !refusals.get(key);
    };

    // Touched sessions: the person's own, in this workspace.
    const convs = new Map<string, Doc<"conversations"> | null>();
    const convOf = async (id: Id<"conversations">) => {
      const key = String(id);
      if (!convs.has(key)) {
        const conv: Doc<"conversations"> | null = await ctx.db.get(id);
        convs.set(key, conv && inWorkspace(conv, args.user_id, args.workspace) && (await mayRead(conv)) ? conv : null);
      }
      return convs.get(key)!;
    };
    const touched = new Map<string, { conv: Doc<"conversations">; last: number; typed: PassSession["typed"]; pins: PassSession["pin_events"] }>();
    const touch = async (id: Id<"conversations">, at: number) => {
      const conv = await convOf(id);
      if (!conv) return null;
      const key = String(id);
      const t = touched.get(key) ?? { conv, last: 0, typed: [], pins: [] };
      t.last = Math.max(t.last, at);
      touched.set(key, t);
      return t;
    };
    for (const s of sends) (await touch(s.conversation_id, s.timestamp))?.typed.push({ at: s.timestamp, text: s.text });
    for (const p of pins) (await touch(p.conversation_id, p.at))?.pins.push({ at: p.at, text: p.text });

    // Oldest last activity first: a run that cannot read them all reads the earliest and leaves the rest past its cursor.
    const byLast = [...touched.values()].sort((a, b) => a.last - b.last);
    const oldestFirst = byLast.slice(0, SESSIONS_READ);
    const truncated = byLast.length > oldestFirst.length;
    const prBudget = { left: PR_ROWS_READ, seen: new Map<string, { ref: string; merged: boolean }>() };
    const sessions: PassSession[] = [];
    for (const t of oldestFirst) {
      const conv = t.conv;
      sessions.push({
        id: sessionId(conv),
        title: conv.title ?? "",
        first_prompt: conv.first_prompt ?? "",
        pin: conv.thread_state ? { text: conv.thread_state, ...(conv.thread_state_status ? { status: conv.thread_state_status } : {}) } : null,
        idle_summary: conv.idle_summary ?? null,
        last_active: t.last,
        tasks: await sessionTasks(ctx, conv, args.workspace),
        prs: await sessionPrs(ctx, conv, prBudget),
        pin_events: t.pins,
        typed: t.typed,
      });
    }

    // The person's priorities in this workspace, with their newest sessions;
    // one the prompt hides (done or quiet for a month) is left out whole.
    const hiddenBefore = now - PRIORITY_PASS_CAPS.finished_days * DAY;
    const rows: Doc<"priorities">[] = [];
    for (const status of LIVE_STATUSES) {
      const found: Doc<"priorities">[] = await ctx.db
        .query("priorities")
        .withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", args.user_id).eq("workspace", args.workspace).eq("status", status))
        .take(PRIORITIES_READ);
      rows.push(...found.filter((p) => !((p.status === "done" || p.status === "quiet") && p.last_active_at < hiddenBefore)));
    }
    const priorities: PassPriority[] = [];
    const stepTaskIds = new Set<string>();
    for (const p of rows) {
      const held: Doc<"conversations">[] = await ctx.db
        .query("conversations")
        .withIndex("by_priority", (q: any) => q.eq("priority_id", p._id))
        .order("desc")
        .take(PRIORITY_PASS_CAPS.sessions_per_priority);
      const readable: Doc<"conversations">[] = [];
      for (const c of held) if (inWorkspace(c, args.user_id, args.workspace) && (await mayRead(c))) readable.push(c);
      priorities.push({
        short_id: p.short_id,
        title: p.title,
        summary: p.summary,
        status: p.status as PassPriority["status"],
        rank: p.rank ?? null,
        rank_set_by: p.rank_set_by,
        serves: p.serves ?? null,
        steps: p.steps,
        last_active_at: p.last_active_at,
        sessions: readable.map((c) => ({ id: sessionId(c), title: c.title ?? "", step_key: c.priority_step_key ?? null, last_active: c.thread_state_at ?? c.updated_at })),
      });
      for (const s of p.steps) for (const r of s.refs) if (r.kind === "task") stepTaskIds.add(r.id);
    }
    const step_tasks: PassTask[] = [];
    for (const short_id of stepTaskIds) {
      const t: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", short_id)).first();
      if (t && t.workspace === args.workspace) step_tasks.push({ short_id: t.short_id, title: t.title, status: t.status });
    }

    const goals: Doc<"initiatives">[] = await ctx.db.query("initiatives").withIndex("by_workspace", (q: any) => q.eq("workspace", args.workspace)).take(INITIATIVES_READ);
    const initiatives = goals.filter((g) => g.status === "active" || g.status === "planned").map((g) => ({ short_id: g.short_id, title: g.title }));

    const user: Doc<"users"> | null = await ctx.db.get(args.user_id);
    const ws = parseWorkspaceKey(args.workspace);
    const team: Doc<"teams"> | null = ws?.type === "team" ? await ctx.db.get(ws.teamId) : null;
    return {
      input: {
        person: user?.name ?? "this person",
        workspace: team ? team.name : "their personal workspace",
        now,
        window_start: cursor_at,
        priorities,
        initiatives,
        step_tasks,
        sessions,
      },
      cursor_at,
      more: read.more || truncated,
      read_to: truncated ? oldestFirst[oldestFirst.length - 1].last : read.read_to,
    };
  },
});

/** The pair's spend over the last day, and when its last paid run (ok or failed) started. */
export const passLimits = internalQuery({
  args: { user_id: v.id("users"), workspace: v.string() },
  handler: async (ctx, args): Promise<{ spent_usd: number; last_paid_at: number | null }> => {
    const since = Date.now() - DAY;
    const day: Doc<"priority_pass_runs">[] = await ctx.db
      .query("priority_pass_runs")
      .withIndex("by_user_workspace_started", (q: any) => q.eq("user_id", args.user_id).eq("workspace", args.workspace).gte("started_at", since))
      .collect();
    const paid = day.filter((r) => r.status !== "skipped" || (r.cost_usd ?? 0) > 0);
    return {
      spent_usd: day.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0),
      last_paid_at: paid.length ? Math.max(...paid.map((r) => r.started_at)) : null,
    };
  },
});

type Gate = { on: boolean; cursor_at: number; budgeted: boolean };

/** Whether the priorities feature is on where the pass would write (a team key only for a member, a personal key only for its own person), the cursor, and whether the workspace pays for model calls. */
export const passGate = internalQuery({
  args: { user_id: v.id("users"), workspace: v.string() },
  handler: async (ctx, args): Promise<Gate> => {
    const ws = parseWorkspaceKey(args.workspace);
    const on = !ws
      ? false
      : ws.type === "team"
        ? (await isTeamMember(ctx, args.user_id, ws.teamId)) && (await workspaceHasFeature(ctx, { team_id: ws.teamId }, "priorities"))
        : String(ws.userId) === String(args.user_id) && (await workspaceHasFeature(ctx, { user_id: args.user_id }, "priorities"));
    const budget = await ctx.db.query("team_budgets").withIndex("by_workspace", (q: any) => q.eq("workspace", args.workspace)).first();
    return { on, cursor_at: await cursorFor(ctx, args.user_id, args.workspace, Date.now()), budgeted: (budget?.cap_usd ?? 0) > 0 };
  },
});

const runRowArgs = {
  user_id: v.id("users"),
  workspace: v.string(),
  started_at: v.number(),
  cursor_at: v.number(),
  model: v.string(),
  cost_usd: v.optional(v.number()),
};

type NothingRun = { user_id: Id<"users">; workspace: string; started_at: number; cursor_at: number; model: string; cost_usd?: number; status: "error" | "skipped"; error?: string };

const insertNothingRun = (ctx: { db: any }, args: NothingRun) =>
  ctx.db.insert("priority_pass_runs", { ...args, finished_at: Date.now(), counts: NO_COUNTS });

/**
 * A run that wrote no plan: skipped or failed, at the cursor it started from
 * (a skip that read everything up to `step_to` and found nothing here moves
 * it there). A failure that is the FAILURES_BEFORE_STEP-th in a row on one
 * cursor steps it to `step_to`, past what keeps failing, and says so.
 */
export const recordRun = internalMutation({
  args: { ...runRowArgs, status: v.union(v.literal("error"), v.literal("skipped")), error: v.optional(v.string()), step_to: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Id<"priority_pass_runs">> => {
    const { step_to, ...run } = args;
    if (step_to === undefined || step_to <= run.cursor_at) return insertNothingRun(ctx, run);
    if (run.status === "skipped") return insertNothingRun(ctx, { ...run, cursor_at: step_to });
    let failures = 1;
    for (const r of await recentRuns(ctx, run.user_id, run.workspace)) {
      if (r.status === "skipped") continue;
      if (r.status !== "error" || r.cursor_at !== run.cursor_at) break;
      failures++;
    }
    if (failures < FAILURES_BEFORE_STEP) return insertNothingRun(ctx, run);
    return insertNothingRun(ctx, { ...run, cursor_at: step_to, error: `${run.error ?? "failed"} (failed ${failures} times here: stepped past)` });
  },
});

/** Plan fields as row fields: null clears a field on a patch and is left out of an insert. */
function rowFields(w: Record<string, unknown>, insert = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(w)) {
    if (val === null && insert) continue;
    out[k] = val === null ? undefined : val;
  }
  return out;
}

/**
 * Writes one pass's plan, atomically, with its run row at `cursor_at`. Re-checks
 * what the plan cannot know: a priority belongs to this person and workspace,
 * a session is theirs and in this workspace, and anything the person set while
 * the model was reading (a rank, a step's tier, a set-aside) still stands. A
 * run that another ok run finished under since it started writes nothing
 * (null) and records the cursor it started from: its plan was made from what
 * that run has since changed.
 */
export const applyPlan = internalMutation({
  args: { ...runRowArgs, from_cursor: v.number(), plan: v.any() },
  handler: async (ctx, args): Promise<Counts | null> => {
    const { plan: raw, from_cursor, ...run } = args;
    const recent = await recentRuns(ctx, args.user_id, args.workspace);
    if (recent.some((r) => r.status === "ok" && r.finished_at > args.started_at)) {
      await insertNothingRun(ctx, { ...run, cursor_at: from_cursor, status: "skipped", error: "superseded" });
      return null;
    }
    const plan = raw as MergePlan;
    const now = Date.now();
    const counts: Counts = { ...NO_COUNTS };
    const ids = new Map<string, Id<"priorities">>();
    const mine = async (shortId: string): Promise<Doc<"priorities"> | null> => {
      const row: Doc<"priorities"> | null = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
      return row && String(row.user_id) === String(args.user_id) && row.workspace === args.workspace ? row : null;
    };
    const resolve = async (target: string): Promise<Id<"priorities"> | null> => ids.get(target) ?? (await mine(target))?._id ?? null;

    for (const c of plan.creates) {
      const { ref, ...w } = c;
      const short_id = await nextShortId(ctx.db, "pri");
      const id = await ctx.db.insert("priorities", {
        ...(rowFields(w, true) as any),
        user_id: args.user_id,
        workspace: args.workspace,
        short_id,
        created_at: now,
        updated_at: now,
      });
      ids.set(ref, id);
      counts.created++;
    }

    for (const u of plan.updates) {
      const row = await mine(u.short_id);
      if (!row) continue;
      const patch: Partial<PriorityWrite> = { ...u.patch };
      if (row.rank_set_by === "person") { delete patch.rank; delete patch.rank_set_by; }
      if (row.status === "set_aside") { delete patch.status; delete patch.done_at; }
      if (patch.steps) {
        const steps = patch.steps;
        for (const held of row.steps.filter((s) => s.tier_set_by === "person")) {
          const i = steps.findIndex((s) => s.key === held.key);
          if (i >= 0) steps[i] = { ...steps[i], tier: held.tier, tier_set_by: "person" };
          else steps.push(held);
        }
      }
      await ctx.db.patch(row._id, { ...(rowFields(patch) as any), updated_at: now });
      counts.updated++;
    }

    for (const m of plan.merges) {
      const row = await mine(m.short_id);
      const into = await resolve(m.merged_into);
      if (!row || !into || row.status === "set_aside") continue;
      await ctx.db.patch(row._id, { status: "merged", merged_into: into, rank: undefined, updated_at: now });
      counts.merged++;
    }

    const conversationOf = async (ref: string): Promise<Doc<"conversations"> | null> => {
      const id = ctx.db.normalizeId("conversations", ref);
      const conv: Doc<"conversations"> | null = id
        ? await ctx.db.get(id)
        : await ctx.db.query("conversations").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
      return conv && inWorkspace(conv, args.user_id, args.workspace) ? conv : null;
    };
    for (const s of plan.sessions) {
      const conv = await conversationOf(s.session);
      const priority = await resolve(s.priority);
      if (!conv || !priority) continue;
      await ctx.db.patch(conv._id, { priority_id: priority, priority_step_key: s.step_key ?? undefined });
      counts.mapped_sessions++;
    }
    for (const ref of plan.unmap) {
      const conv = await conversationOf(ref);
      const held: Doc<"priorities"> | null = conv?.priority_id ? await ctx.db.get(conv.priority_id) : null;
      if (!conv || (held && (String(held.user_id) !== String(args.user_id) || held.workspace !== args.workspace))) continue;
      await ctx.db.patch(conv._id, { priority_id: undefined, priority_step_key: undefined });
    }

    await ctx.db.insert("priority_pass_runs", { ...run, finished_at: now, status: "ok", counts });
    return counts;
  },
});

function callScope(workspace: string): CallScope {
  const ws = parseWorkspaceKey(workspace);
  return ws?.type === "team" ? { workspace, team_id: ws.teamId } : { workspace };
}

/** How many of the sessions (oldest first) one prompt holds whole: at least one, so a chain always moves. */
function fittingPrefix(input: PriorityPassInput): number {
  const fits = (k: number) => priorityPassRequest({ ...input, sessions: input.sessions.slice(0, k) }).omitted.length === 0;
  let lo = 0, hi = input.sessions.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(input.sessions.length, Math.max(1, lo));
}

type PassArgs = { user_id: Id<"users">; workspace: string; force?: boolean; chain?: number; now?: boolean };

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / MINUTE));

async function pass(ctx: any, args: PassArgs): Promise<PassResult> {
  const started_at = Date.now();
  const pair = { user_id: args.user_id, workspace: args.workspace };
  const base = { ...pair, started_at, model: PRIORITY_PASS_MODEL };
  const gate: Gate = await ctx.runQuery(self.passGate, pair);
  if (!gate.on) {
    await ctx.runMutation(self.recordRun, { ...base, cursor_at: gate.cursor_at, status: "skipped", error: "the priorities feature is off here" });
    return { status: "skipped", reason: "feature_off" };
  }
  const limits: { spent_usd: number; last_paid_at: number | null } = await ctx.runQuery(self.passLimits, pair);
  if (args.now && limits.last_paid_at !== null && started_at - limits.last_paid_at < RUN_NOW_EVERY_MS) {
    const ago = minutes(started_at - limits.last_paid_at), wait = minutes(limits.last_paid_at + RUN_NOW_EVERY_MS - started_at);
    return { status: "skipped", reason: `A pass ran here ${ago} minute${ago === 1 ? "" : "s"} ago; run it again in ${wait} minute${wait === 1 ? "" : "s"}.` };
  }
  if (limits.spent_usd >= PRIORITY_PASS_DAILY_USD) {
    await ctx.runMutation(self.recordRun, { ...base, cursor_at: gate.cursor_at, status: "skipped", error: "daily ceiling" });
    return { status: "skipped", reason: "daily_ceiling" };
  }

  let read: PassInputs;
  try {
    read = await ctx.runQuery(self.passInputs, { ...pair, window_start: gate.cursor_at });
  } catch (e) {
    // A read that keeps failing (a read limit) steps past a day of activity after FAILURES_BEFORE_STEP tries.
    const error = `reading the inputs failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    await ctx.runMutation(self.recordRun, { ...base, cursor_at: gate.cursor_at, status: "error", error, step_to: Math.min(gate.cursor_at + DAY, started_at - LATE_MARGIN_MS) });
    return { status: "error", reason: error };
  }
  const { cursor_at } = read;
  if (!read.input.sessions.length && !args.force) {
    // Nothing of this workspace's in what was read: the cursor moves past it, so other workspaces' activity is not read again.
    await ctx.runMutation(self.recordRun, { ...base, cursor_at, status: "skipped", error: "nothing touched since the last pass", step_to: read.read_to });
    const chained = read.more && (args.chain ?? 0) + 1 < MAX_CHAINED_RUNS;
    if (chained) await ctx.scheduler.runAfter(CHAIN_DELAY_MS, self.runPass, { ...pair, chain: (args.chain ?? 0) + 1 });
    return { status: "skipped", reason: "nothing_new", ...(chained ? { chained } : {}) };
  }
  const included = fittingPrefix(read.input);
  const input: PriorityPassInput = { ...read.input, sessions: read.input.sessions.slice(0, included) };
  const left = read.more || included < read.input.sessions.length;
  // Read whole to read_to; else to the last session read, whose later sessions the next run reads.
  const readTo = Math.max(cursor_at, included < read.input.sessions.length ? input.sessions[included - 1].last_active : read.read_to);
  const { req } = priorityPassRequest(input);
  const reply = await runModelCallOrOwn(
    ctx,
    callScope(args.workspace),
    gate.budgeted,
    "grouping",
    { model: req.model, max_tokens: req.max_tokens, system: req.system, prompt: req.prompt, output: "json", output_schema: req.output_schema },
    "Priority pass",
    { ctx, scope: { workspace: args.workspace } },
    PASS_TIMEOUT_MS,
  );
  const fail = async (error: string): Promise<PassResult> => {
    await ctx.runMutation(self.recordRun, { ...base, cursor_at, cost_usd: reply.cost_usd, status: "error", error, step_to: readTo });
    return { status: "error", reason: error, cost_usd: reply.cost_usd };
  };
  if (!reply.ok) return fail(reply.reason === "budget" ? `budget: ${reply.error}` : reply.error);
  const { output, dropped } = parsePriorityPassOutput(reply.json, input);
  if (!output) return fail(`unreadable reply: ${dropped.join("; ")}`);
  const plan = mergePriorities(input, output);
  const counts: Counts | null = await ctx.runMutation(self.applyPlan, { ...base, cursor_at: readTo, from_cursor: cursor_at, cost_usd: reply.cost_usd, plan });
  if (!counts) return { status: "skipped", reason: "superseded", cost_usd: reply.cost_usd };
  const chain = (args.chain ?? 0) + 1;
  const chained = left && chain < MAX_CHAINED_RUNS;
  if (chained) await ctx.scheduler.runAfter(CHAIN_DELAY_MS, self.runPass, { ...pair, chain });
  return { status: "ok", counts, cost_usd: reply.cost_usd, dropped, notes: plan.notes, ...(chained ? { chained } : {}) };
}

/**
 * One pass for one person in one workspace. Skips (and records why) when the
 * feature is off, the pair spent its day's ceiling, or nothing moved and it is
 * not forced. `chain` counts the runs before it in one chain (MAX_CHAINED_RUNS).
 */
export const runPass = internalAction({
  args: { user_id: v.id("users"), workspace: v.string(), force: v.optional(v.boolean()), chain: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PassResult> => pass(ctx, args),
});

/** `cast priorities run`: a pass now, even when nothing moved since the last one; at most once in RUN_NOW_EVERY_MS, refused with a plain reason. */
export const runNow = internalAction({
  args: { user_id: v.id("users"), workspace: v.string() },
  handler: async (ctx, args): Promise<PassResult> => pass(ctx, { ...args, force: true, now: true }),
});

/**
 * The (person, workspace) pairs a sweep runs: every member of a team with the
 * feature on, in that team and in their personal workspace, that has a typed
 * message or a pin in it since its cursor, or more activity since then than
 * the probe reads (the pass moves the cursor past what is not its own). At
 * most SWEEP_MAX_PAIRS.
 */
export const sweepCandidates = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ user_id: Id<"users">; workspace: string }>> => {
    const now = Date.now();
    const pairs = new Map<string, { user_id: Id<"users">; workspace: string }>();
    for (const team of await ctx.db.query("teams").collect()) {
      if (!team.features?.priorities || !(await teamHasFeature(ctx, team._id, "priorities"))) continue;
      const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team._id)).collect();
      for (const m of members) {
        for (const workspace of [`team:${team._id}`, `user:${m.user_id}`]) pairs.set(`${m.user_id}|${workspace}`, { user_id: m.user_id, workspace });
      }
    }
    // Longest waiting first, so a capped sweep never starves the same pairs.
    const waiting = await Promise.all([...pairs.values()].map(async (p) => ({ ...p, cursor: await cursorFor(ctx, p.user_id, p.workspace, now) })));
    waiting.sort((a, b) => a.cursor - b.cursor);
    const out: Array<{ user_id: Id<"users">; workspace: string }> = [];
    for (const { cursor, ...pair } of waiting) {
      if (out.length >= SWEEP_MAX_PAIRS) break;
      const { sends, pins, more } = await activitySince(ctx, pair.user_id, cursor, Math.max(cursor, now - LATE_MARGIN_MS), SWEEP_ACTIVITY_READ);
      if (more) {
        out.push(pair);
        continue;
      }
      const seen = new Set<string>();
      for (const id of [...pins.map((p) => p.conversation_id), ...sends.map((s) => s.conversation_id)]) {
        if (seen.has(String(id))) continue;
        seen.add(String(id));
        const conv: Doc<"conversations"> | null = await ctx.db.get(id);
        if (conv && inWorkspace(conv, pair.user_id, pair.workspace)) {
          out.push(pair);
          break;
        }
      }
    }
    return out;
  },
});

/** Every few hours: a pass for each pair with new work, a few seconds apart. */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const pairs: Array<{ user_id: Id<"users">; workspace: string }> = await ctx.runQuery(self.sweepCandidates, {});
    for (const [i, pair] of pairs.entries()) await ctx.scheduler.runAfter(i * SWEEP_STAGGER_MS, self.runPass, pair);
    return pairs.length;
  },
});
