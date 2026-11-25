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
import { modelCallProblem } from "@codecast/shared/contracts/modelCall";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { sessionVisibility, type SessionVisibility } from "./lib/prioritySessionVisibility";
import { isTeamMember } from "./privacy";
import { canReadCall } from "./transcripts";
import { isRestricted } from "./chatAccess";
import { isStandingSession } from "./lib/orgOwnership";
import { isRunLog, parseRoomKey } from "@codecast/shared/contracts";
import { teamHasFeature, workspaceHasFeature } from "./lib/teamFeatureGuard";
import { vendorRefusalFromDb } from "./lib/vendorGuard";
import {
  PRIORITY_PASS_CAPS,
  PRIORITY_PASS_MODEL,
  mergePriorities,
  parsePriorityPassOutput,
  priorityPassRequest,
  type MergePlan,
  type PassCall,
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
 * A typed message is stamped with its client time and can land minutes after
 * it: a pass reads only up to LATE_MARGIN_MS ago, and re-reads OVERLAP_MS below
 * its cursor for rows that landed since. A row that lands later than that
 * (an offline sync hours on) falls below the cursor and is not read.
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
/** The newest calls one pass looks through for the ones the person was in; the prompt keeps fewer (PRIORITY_PASS_CAPS.calls). */
const CALLS_READ = 30;
/** A call started this long before the cursor can still have ended after it. */
const CALL_LONGEST_MS = DAY;
/** A priority's sessions are counted from the index up to this many; past it the stored count goes on by the moves and is flagged. */
export const SESSION_COUNT_CAP = 500;
const INITIATIVES_READ = 200;
/** How long the model may take: a full prompt and a long reply run minutes. */
const PASS_TIMEOUT_MS = 5 * 60_000;
/** (person, workspace) pairs one sweep runs; the rest wait for the next sweep. */
export const SWEEP_MAX_PAIRS = 40;
/** A sweep looks for strays among a pair's newest priorities, a few sessions each (the pass reads as many), and among this many priorities in all. */
const SWEEP_STRAY_PRIORITIES = 30;
const SWEEP_STRAY_BUDGET = 200;
/** The most teams a sweep reads for the feature, and members per team. */
const SWEEP_TEAMS_READ = 2_000;
const SWEEP_MEMBERS_READ = 500;
/** The most runs of one pair in a day a reservation reads. */
const RUNS_OF_DAY_READ = 500;
const SWEEP_STAGGER_MS = 5_000;

/** Typed messages and pins a sweep reads per pair to see whether anything moved there. */
const SWEEP_ACTIVITY_READ = 300;
/** The newest runs read for the cursor and the failures in a row. */
const RECENT_RUNS = 30;
/** A reservation older than this belongs to a run that died (an action stops at 10 minutes). */
export const RESERVATION_TTL_MS = 15 * MINUTE;
// Codegen catches up on the next push.
const self = (internal as any).priorityPassRun;

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
  /** Sessions a priority here still holds that have left this workspace (made private, moved): applyPlan lets them go. */
  strays: Id<"conversations">[];
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
/** The person's own session, counting in this workspace (lib/prioritySessionVisibility: its team's only while listed there). */
const inWorkspace = async (vis: SessionVisibility, conv: Doc<"conversations">, userId: Id<"users">, workspace: string) =>
  String(conv.user_id) === String(userId) && (await vis.workspaceOf(conv)) === workspace;

/** The pair's newest runs by start, newest first. */
const recentRuns = (ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<Doc<"priority_pass_runs">[]> =>
  ctx.db
    .query("priority_pass_runs")
    .withIndex("by_user_workspace_started", (q: any) => q.eq("user_id", userId).eq("workspace", workspace))
    .order("desc")
    .take(RECENT_RUNS);

/**
 * The pair's cursor: the furthest any recent settled run read (runs finish out
 * of order, so the newest started is not always the furthest), and when the
 * last run to apply a plan there started (else the first to reach it): rows
 * that landed before then were read. A running reservation is no position.
 */
async function cursorState(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<{ cursor_at: number; set_at: number } | null> {
  const settled = (await recentRuns(ctx, userId, workspace)).filter((r) => r.status !== "running");
  if (!settled.length) return null;
  const cursor_at = Math.max(...settled.map((r) => r.cursor_at));
  const there = settled.filter((r) => r.cursor_at === cursor_at);
  const ok = there.filter((r) => r.status === "ok");
  const set_at = ok.length ? Math.max(...ok.map((r) => r.started_at)) : Math.min(...there.map((r) => r.started_at));
  return { cursor_at, set_at };
}

/** Where a session's activity in a read starts: its first row past the cursor (a late row below it counts as at the cursor). */
const firstAfter = (s: { typed: Array<{ at: number }>; pin_events: Array<{ at: number }> }, cursor: number): number =>
  Math.min(...[...s.typed, ...s.pin_events].map((r) => Math.max(r.at, cursor)));

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

/** A standing role's seat, a worker another session started (with its parent's id), or the person's own session. */
async function sessionKind(ctx: { db: any }, conv: Doc<"conversations">): Promise<Pick<PassSession, "kind" | "parent">> {
  if (isStandingSession(conv)) return { kind: "role" };
  // A fork (parent_message_uuid) is the person's own session from that point on, not a worker.
  if (!conv.parent_conversation_id || conv.parent_message_uuid) return { kind: "session" };
  const parent: Doc<"conversations"> | null = await ctx.db.get(conv.parent_conversation_id);
  return { kind: "worker", parent: parent ? sessionId(parent) : String(conv.parent_conversation_id) };
}

/**
 * Whether the whole team may read a call's record: not a private huddle, not
 * a people room, a channel room only for an open channel, a session room only
 * for a team-visible session, and a recording or meeting bot's call only once
 * its creator shared it with the team.
 */
async function teamWideCall(ctx: { db: any }, vis: SessionVisibility, t: Doc<"transcripts">): Promise<boolean> {
  if (t.private) return false;
  const room = parseRoomKey(t.room_key);
  if (!room) return false;
  if (room.kind === "rec" || room.kind === "meet") return !!t.rec_shared && !t.screen_recording;
  if (room.kind === "channel") {
    const channel: Doc<"chat_channels"> | null = await ctx.db.get(room.channelId as Id<"chat_channels">);
    return !!channel && !channel.archived_at && !isRestricted(channel);
  }
  if (room.kind === "session") {
    const conv: Doc<"conversations"> | null = await ctx.db.get(room.conversationId as Id<"conversations">);
    return !!conv && (await vis.listedTo(conv, t.team_id));
  }
  return false;
}

/**
 * The team's calls whose summary landed in (since, until] and that `fresh`
 * keeps (a summary below the cursor counts only if it landed after the run
 * that set it), which the person was in (spoke, was filmed, or ran the scribe)
 * and the whole team may read, oldest first. A call is a team's record: a
 * personal workspace has none.
 */
async function callsIn(ctx: { db: any }, vis: SessionVisibility, userId: Id<"users">, teamId: Id<"teams">, since: number, until: number, fresh: (landed: number) => boolean = () => true): Promise<PassCall[]> {
  const rows: Doc<"transcripts">[] = await ctx.db
    .query("transcripts")
    .withIndex("by_team_started", (q: any) => q.eq("team_id", teamId).gt("started_at", since - CALL_LONGEST_MS).lte("started_at", until))
    .order("desc")
    .take(CALLS_READ);
  const me = String(userId);
  const out: PassCall[] = [];
  for (const t of rows) {
    const landed = t.summary_at ?? t.ended_at;
    if (!t.ended_at || !landed || landed <= since || landed > until || !fresh(landed) || !(t.summary?.trim() || t.action_items?.length)) continue;
    const joined = (t.participants ?? []).some((p) => String(p.id) === me) || (t.recorded_people ?? []).some((id) => String(id) === me) || String(t.started_by) === me;
    if (!joined || !(await teamWideCall(ctx, vis, t)) || !(await canReadCall(ctx, userId, t))) continue;
    out.push({ id: t.short_id ?? String(t._id), title: t.title ?? "Call", at: landed, summary: t.summary ?? "", action_items: t.action_items ?? [] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * One person's priorities in one workspace the pass reads, newest first: every
 * active and set-aside one, and the done or quiet ones that moved within
 * PRIORITY_PASS_CAPS.finished_days (older ones the prompt hides are left out
 * whole), at most `limit` of each.
 */
async function livePriorities(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number, limit: number): Promise<Doc<"priorities">[]> {
  const open: Doc<"priorities">[] = [];
  for (const status of ["active", "set_aside"] as const) {
    open.push(...(await ctx.db
      .query("priorities")
      .withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).eq("status", status))
      .take(limit)));
  }
  const recent: Doc<"priorities">[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).gte("last_active_at", now - PRIORITY_PASS_CAPS.finished_days * DAY))
    .order("desc")
    .take(open.length + 2 * limit);
  const finished = recent.filter((p) => p.status === "done" || p.status === "quiet");
  const done = finished.filter((p) => p.status === "done").slice(0, limit);
  const quiet = finished.filter((p) => p.status === "quiet").slice(0, limit);
  return [...open, ...done, ...quiet].sort((a, b) => b.last_active_at - a.last_active_at);
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
    const vis = sessionVisibility(ctx);
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
        // A workflow's run log is machine output, not the person's work: never an input (and never a stray either).
        convs.set(key, conv && !isRunLog(conv) && (await inWorkspace(vis, conv, args.user_id, args.workspace)) && (await mayRead(conv)) ? conv : null);
      }
      return convs.get(key)!;
    };
    const touched = new Map<string, { conv: Doc<"conversations">; last: number; typed: PassSession["typed"]; pin_events: PassSession["pin_events"] }>();
    const touch = async (id: Id<"conversations">, at: number) => {
      const conv = await convOf(id);
      if (!conv) return null;
      const key = String(id);
      const t = touched.get(key) ?? { conv, last: 0, typed: [], pin_events: [] };
      t.last = Math.max(t.last, at);
      touched.set(key, t);
      return t;
    };
    for (const s of sends) (await touch(s.conversation_id, s.timestamp))?.typed.push({ at: s.timestamp, text: s.text });
    for (const p of pins) (await touch(p.conversation_id, p.at))?.pin_events.push({ at: p.at, text: p.text });

    // Earliest first activity first: a run that cannot read them all reads the
    // earliest and moves its cursor to just before the first it left out.
    const byFirst = [...touched.values()].sort((a, b) => firstAfter(a, cursor_at) - firstAfter(b, cursor_at));
    const oldestFirst = byFirst.slice(0, SESSIONS_READ);
    const truncated = byFirst.length > oldestFirst.length;
    const prBudget = { left: PR_ROWS_READ, seen: new Map<string, { ref: string; merged: boolean }>() };
    const sessions: PassSession[] = [];
    for (const t of oldestFirst) {
      const conv = t.conv;
      sessions.push({
        id: sessionId(conv),
        ...(await sessionKind(ctx, conv)),
        title: conv.title ?? "",
        first_prompt: conv.first_prompt ?? "",
        pin: conv.thread_state ? { text: conv.thread_state, ...(conv.thread_state_status ? { status: conv.thread_state_status } : {}) } : null,
        idle_summary: conv.idle_summary ?? null,
        last_active: t.last,
        tasks: await sessionTasks(ctx, conv, args.workspace),
        prs: await sessionPrs(ctx, conv, prBudget),
        pin_events: t.pin_events,
        typed: t.typed,
      });
    }

    // The person's priorities in this workspace, with their newest sessions.
    const rows = await livePriorities(ctx, args.user_id, args.workspace, now, PRIORITIES_READ);
    const priorities: PassPriority[] = [];
    const strays: Id<"conversations">[] = [];
    const stepTaskIds = new Set<string>();
    for (const p of rows) {
      const held: Doc<"conversations">[] = await ctx.db
        .query("conversations")
        .withIndex("by_priority", (q: any) => q.eq("priority_id", p._id))
        .order("desc")
        .take(PRIORITY_PASS_CAPS.sessions_per_priority);
      const readable: Doc<"conversations">[] = [];
      for (const c of held) {
        if (!(await inWorkspace(vis, c, args.user_id, args.workspace))) strays.push(c._id);
        else if (await mayRead(c)) readable.push(c);
      }
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
    const calls = team ? await callsIn(ctx, vis, args.user_id, team._id, overlap ? cursor_at - OVERLAP_MS : cursor_at, until, (landed) => fresh(landed, landed)) : [];
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
        calls,
      },
      cursor_at,
      more: read.more || truncated,
      read_to: truncated ? Math.max(cursor_at, firstAfter(byFirst[SESSIONS_READ], cursor_at) - 1) : read.read_to,
      strays,
    };
  },
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const minutes = (ms: number) => Math.max(1, Math.ceil(ms / MINUTE));

type BlockerKind = "busy" | "daily_ceiling" | "throttled";
type Reservation = { run_id: Id<"priority_pass_runs"> } | { refused: BlockerKind; reason: string };

const runsOfDay = (ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<Doc<"priority_pass_runs">[]> =>
  ctx.db
    .query("priority_pass_runs")
    .withIndex("by_user_workspace_started", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).gte("started_at", now - DAY))
    .order("desc")
    .take(RUNS_OF_DAY_READ);

/**
 * Why a run of the pair may not start now, in the words a person reads, or
 * null: another run holds it (a reservation under RESERVATION_TTL_MS old),
 * for `cast priorities run` (`runNow`) the last run that asked the model was
 * under RUN_NOW_EVERY_MS ago, or the day's runs cost PRIORITY_PASS_DAILY_USD.
 * Reads only: reserve acts on it, and the CLI asks it before scheduling.
 */
export async function runBlocker(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number, runNow: boolean): Promise<{ kind: BlockerKind; reason: string } | null> {
  const day = await runsOfDay(ctx, userId, workspace, now);
  if (day.some((r) => r.status === "running" && r.started_at > now - RESERVATION_TTL_MS)) return { kind: "busy", reason: "A pass is already running here." };
  const paid = day.filter((r) => r.status === "ok" || r.status === "error" || (r.cost_usd ?? 0) > 0).map((r) => r.started_at);
  const last = paid.length ? Math.max(...paid) : null;
  if (runNow && last !== null && now - last < RUN_NOW_EVERY_MS) {
    return { kind: "throttled", reason: `A pass ran here ${plural(minutes(now - last), "minute")} ago; run it again in ${plural(minutes(last + RUN_NOW_EVERY_MS - now), "minute")}.` };
  }
  if (day.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0) >= PRIORITY_PASS_DAILY_USD) {
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
  args: { user_id: v.id("users"), workspace: v.string(), started_at: v.number(), cursor_at: v.number(), model: v.string(), run_now: v.boolean() },
  handler: async (ctx, args): Promise<Reservation> => {
    const now = args.started_at;
    for (const r of await runsOfDay(ctx, args.user_id, args.workspace, now)) {
      if (r.status === "running" && r.started_at <= now - RESERVATION_TTL_MS) {
        await ctx.db.patch(r._id, { status: "error", error: "abandoned: the run stopped before it settled", finished_at: now });
      }
    }
    const { run_now, ...run } = args;
    const blocked = await runBlocker(ctx, args.user_id, args.workspace, now, run_now);
    if (blocked?.kind === "daily_ceiling") {
      await ctx.db.insert("priority_pass_runs", { ...run, finished_at: now, status: "skipped", error: "daily ceiling", counts: NO_COUNTS });
    }
    if (blocked) return { refused: blocked.kind, reason: blocked.reason };
    return { run_id: await ctx.db.insert("priority_pass_runs", { ...run, finished_at: now, status: "running", counts: NO_COUNTS }) };
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
 * Moves sessions between priorities and then counts again, from the index,
 * every priority a session moved to or from, so a count that drifted heals:
 * the person's own in any workspace (a session made private leaves a team
 * priority from the personal pass).
 */
function sessionMover(ctx: { db: any }) {
  const moved = new Map<Id<"priorities">, number>();
  const move = async (conv: Doc<"conversations">, to: Id<"priorities"> | undefined, step_key: string | undefined) => {
    if (conv.priority_id) moved.set(conv.priority_id, (moved.get(conv.priority_id) ?? 0) - 1);
    if (to) moved.set(to, (moved.get(to) ?? 0) + 1);
    await ctx.db.patch(conv._id, { priority_id: to, priority_step_key: step_key });
  };
  const recount = async (userId: Id<"users">) => {
    for (const [id, delta] of moved) {
      const row: Doc<"priorities"> | null = await ctx.db.get(id);
      if (!row || String(row.user_id) !== String(userId)) continue;
      const held = (await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", id)).take(SESSION_COUNT_CAP + 1)).length;
      const capped = held > SESSION_COUNT_CAP;
      const session_count = capped ? Math.max(SESSION_COUNT_CAP, (row.session_count ?? 0) + delta) : held;
      if (session_count !== row.session_count || capped !== !!row.session_count_capped) {
        await ctx.db.patch(id, { session_count, session_count_capped: capped || undefined });
      }
    }
  };
  return { move, recount };
}

/** A session that left this workspace lets go of the priority here, so its new workspace's pass can map it. Returns how many let go. */
async function letGoStrays(
  ctx: { db: any },
  vis: SessionVisibility,
  move: (conv: Doc<"conversations">, to: undefined, step_key: undefined) => Promise<void>,
  pair: { user_id: Id<"users">; workspace: string },
  strays: Id<"conversations">[],
): Promise<number> {
  let n = 0;
  for (const id of strays) {
    const conv: Doc<"conversations"> | null = await ctx.db.get(id);
    const held: Doc<"priorities"> | null = conv?.priority_id ? await ctx.db.get(conv.priority_id) : null;
    if (!conv || !held || (await inWorkspace(vis, conv, pair.user_id, pair.workspace)) || String(held.user_id) !== String(pair.user_id) || held.workspace !== pair.workspace) continue;
    await move(conv, undefined, undefined);
    n++;
  }
  return n;
}

/**
 * A pass with nothing new to read that still finds sessions which left the
 * workspace: lets them go without asking the model. Settles its run as
 * skipped (it asked no model, so it neither trips the runNow throttle nor
 * spends the day's ceiling) at `step_to`; with `record` false (a run already
 * settled, as by the daily ceiling) it writes no run row.
 */
export const releaseStrays = internalMutation({
  args: { ...runRowArgs, strays: v.array(v.id("conversations")), step_to: v.number(), record: v.boolean() },
  handler: async (ctx, args): Promise<number> => {
    const { strays, step_to, record, ...run } = args;
    const { move, recount } = sessionMover(ctx);
    const n = await letGoStrays(ctx, sessionVisibility(ctx), move, args, strays);
    await recount(args.user_id);
    if (record) await settleRun(ctx, { ...run, cursor_at: Math.max(run.cursor_at, step_to), status: "skipped", error: `nothing new; let go of ${plural(n, "session")} that left this workspace` });
    return n;
  },
});

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
  args: { ...runRowArgs, from_cursor: v.number(), plan: v.any(), strays: v.optional(v.array(v.id("conversations"))) },
  handler: async (ctx, args): Promise<Counts | null> => {
    const { plan: raw, from_cursor, strays, ...run } = args;
    const vis = sessionVisibility(ctx);
    const recent = await recentRuns(ctx, args.user_id, args.workspace);
    if (recent.some((r) => r.status === "ok" && r.finished_at > args.started_at)) {
      await settleRun(ctx, { ...run, cursor_at: from_cursor, status: "skipped", error: "superseded" });
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
        session_count: 0,
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

    const mergedInto = new Map<Id<"priorities">, Id<"priorities">>();
    for (const m of plan.merges) {
      const row = await mine(m.short_id);
      const into = await resolve(m.merged_into);
      if (!row || !into || row.status === "set_aside") continue;
      await ctx.db.patch(row._id, { status: "merged", merged_into: into, rank: undefined, updated_at: now });
      mergedInto.set(row._id, into);
      counts.merged++;
    }

    const { move, recount } = sessionMover(ctx);

    const conversationOf = async (ref: string): Promise<Doc<"conversations"> | null> => {
      const id = ctx.db.normalizeId("conversations", ref);
      const conv: Doc<"conversations"> | null = id
        ? await ctx.db.get(id)
        : await ctx.db.query("conversations").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
      return conv && (await inWorkspace(vis, conv, args.user_id, args.workspace)) ? conv : null;
    };
    for (const s of plan.sessions) {
      const conv = await conversationOf(s.session);
      const priority = await resolve(s.priority);
      if (!conv || !priority) continue;
      await move(conv, priority, s.step_key ?? undefined);
      counts.mapped_sessions++;
    }
    for (const ref of plan.unmap) {
      const conv = await conversationOf(ref);
      const held: Doc<"priorities"> | null = conv?.priority_id ? await ctx.db.get(conv.priority_id) : null;
      if (!conv || (held && (String(held.user_id) !== String(args.user_id) || held.workspace !== args.workspace))) continue;
      await move(conv, undefined, undefined);
    }
    await letGoStrays(ctx, vis, move, args, strays ?? []);
    // A merged priority's sessions the plan did not list (the input shows only its newest) go to the survivor, step unknown.
    for (const [from, into] of mergedInto) {
      const left: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", from)).take(SESSION_COUNT_CAP);
      for (const conv of left) if (await inWorkspace(vis, conv, args.user_id, args.workspace)) await move(conv, into, undefined);
    }

    await recount(args.user_id);

    await settleRun(ctx, { ...run, status: "ok", counts });
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

/**
 * One run's share of what it read: the first `included` sessions, the calls
 * up to where its cursor goes (a call goes to the one run whose window holds
 * it), and that cursor: read_to when every session fit, else just before the
 * first session left out, which the next run reads from its start.
 */
function runShare(read: PassInputs, input: PriorityPassInput, included: number): { input: PriorityPassInput; readTo: number; left: boolean } {
  const cut = included < input.sessions.length;
  const readTo = cut ? Math.max(read.cursor_at, firstAfter(input.sessions[included], read.cursor_at) - 1) : read.read_to;
  return { input: { ...input, sessions: input.sessions.slice(0, included), calls: input.calls.filter((c) => c.at <= readTo) }, readTo, left: read.more || cut };
}

type PassArgs = { user_id: Id<"users">; workspace: string; force?: boolean; chain?: number; now?: boolean };

/** Model-call failures that come back the same on the same input: a reply with no whole JSON, or a call the spec check refuses. */
const REPEATING_CALL_ERRORS = /^the answer (held no JSON|ran past max_tokens)/;

async function pass(ctx: any, args: PassArgs): Promise<PassResult> {
  const started_at = Date.now();
  const pair = { user_id: args.user_id, workspace: args.workspace };
  const base = { ...pair, started_at, model: PRIORITY_PASS_MODEL };
  const gate: Gate = await ctx.runQuery(self.passGate, pair);
  if (!gate.on) {
    await ctx.runMutation(self.recordRun, { ...base, cursor_at: gate.cursor_at, status: "skipped", error: "the priorities feature is off here" });
    return { status: "skipped", reason: "feature_off" };
  }
  const held: Reservation = await ctx.runMutation(self.reserve, { ...base, cursor_at: gate.cursor_at, run_now: !!args.now });
  if ("refused" in held) {
    // The day's ceiling holds back the model, not letting go of sessions that left: that costs nothing.
    if (held.refused === "daily_ceiling") {
      const read: PassInputs = await ctx.runQuery(self.passInputs, { ...pair, window_start: gate.cursor_at });
      if (read.strays.length) await ctx.runMutation(self.releaseStrays, { ...base, cursor_at: gate.cursor_at, strays: read.strays, step_to: gate.cursor_at, record: false });
    }
    return { status: "skipped", reason: held.reason };
  }
  const run_id = held.run_id;

  let read: PassInputs;
  try {
    read = await ctx.runQuery(self.passInputs, { ...pair, window_start: gate.cursor_at });
  } catch (e) {
    // A read that keeps failing (a read limit) steps past a day of activity after FAILURES_BEFORE_STEP tries.
    const error = `reading the inputs failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    await ctx.runMutation(self.recordRun, { ...base, run_id, cursor_at: gate.cursor_at, status: "error", error, repeats: true, step_to: Math.min(gate.cursor_at + DAY, started_at - LATE_MARGIN_MS) });
    return { status: "error", reason: error };
  }
  const { cursor_at } = read;
  if (!read.input.sessions.length && !read.input.calls.length && !args.force && read.strays.length) {
    // Nothing new, but sessions a priority here holds have left the workspace: let them go without asking the model.
    await ctx.runMutation(self.releaseStrays, { ...base, run_id, cursor_at, strays: read.strays, step_to: read.read_to, record: true });
    const chained = read.more && (args.chain ?? 0) + 1 < MAX_CHAINED_RUNS;
    if (chained) await ctx.scheduler.runAfter(CHAIN_DELAY_MS, self.runPass, { ...pair, chain: (args.chain ?? 0) + 1 });
    return { status: "skipped", reason: "nothing_new", ...(chained ? { chained } : {}) };
  }
  if (!read.input.sessions.length && !read.input.calls.length && !args.force) {
    // Nothing of this workspace's in what was read: the cursor moves past it, so other workspaces' activity is not read again.
    await ctx.runMutation(self.recordRun, { ...base, run_id, cursor_at, status: "skipped", error: "nothing touched since the last pass", step_to: read.read_to });
    const chained = read.more && (args.chain ?? 0) + 1 < MAX_CHAINED_RUNS;
    if (chained) await ctx.scheduler.runAfter(CHAIN_DELAY_MS, self.runPass, { ...pair, chain: (args.chain ?? 0) + 1 });
    return { status: "skipped", reason: "nothing_new", ...(chained ? { chained } : {}) };
  }
  const { input, readTo, left } = runShare(read, read.input, fittingPrefix(read.input));
  const { req } = priorityPassRequest(input);
  const spec = { model: req.model, max_tokens: req.max_tokens, system: req.system, prompt: req.prompt, output: "json" as const, output_schema: req.output_schema };
  const reply = await runModelCallOrOwn(
    ctx,
    callScope(args.workspace),
    gate.budgeted,
    "grouping",
    spec,
    "Priority pass",
    { ctx, scope: { workspace: args.workspace } },
    PASS_TIMEOUT_MS,
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
  const counts: Counts | null = await ctx.runMutation(self.applyPlan, { ...base, run_id, cursor_at: readTo, from_cursor: cursor_at, cost_usd: reply.cost_usd, plan, strays: read.strays });
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
 * the probe reads (the pass moves the cursor past what is not its own), or
 * whose priorities still hold a session that has left the workspace (the pass
 * lets it go). At most SWEEP_MAX_PAIRS.
 */
export const sweepCandidates = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ user_id: Id<"users">; workspace: string }>> => {
    const now = Date.now();
    const vis = sessionVisibility(ctx);
    const pairs = new Map<string, { user_id: Id<"users">; workspace: string }>();
    for (const team of await ctx.db.query("teams").take(SWEEP_TEAMS_READ)) {
      if (!team.features?.priorities || !(await teamHasFeature(ctx, team._id, "priorities"))) continue;
      const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team._id)).take(SWEEP_MEMBERS_READ);
      for (const m of members) {
        for (const workspace of [`team:${team._id}`, `user:${m.user_id}`]) pairs.set(`${m.user_id}|${workspace}`, { user_id: m.user_id, workspace });
      }
    }
    // Longest waiting first, so a capped sweep never starves the same pairs.
    const waiting = await Promise.all([...pairs.values()].map(async (p) => ({ ...p, cursor: await cursorFor(ctx, p.user_id, p.workspace, now) })));
    const strayBudget = { left: SWEEP_STRAY_BUDGET };
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
      let picked = false;
      for (const id of [...pins.map((p) => p.conversation_id), ...sends.map((s) => s.conversation_id)]) {
        if (seen.has(String(id))) continue;
        seen.add(String(id));
        const conv: Doc<"conversations"> | null = await ctx.db.get(id);
        if (conv && (await inWorkspace(vis, conv, pair.user_id, pair.workspace))) {
          picked = true;
          break;
        }
      }
      if (picked || (await holdsStray(ctx, vis, pair, now, strayBudget))) out.push(pair);
    }
    return out;
  },
});

/**
 * Whether one of the pair's newest priorities holds a session that has left
 * its workspace (passInputs' strays, read the same way), spending at most
 * `budget.left` priorities of the sweep's probe. A stray past the budget waits
 * for the pair's next pass.
 */
async function holdsStray(ctx: { db: any }, vis: SessionVisibility, pair: { user_id: Id<"users">; workspace: string }, now: number, budget: { left: number }): Promise<boolean> {
  if (budget.left <= 0) return false;
  for (const p of await livePriorities(ctx, pair.user_id, pair.workspace, now, Math.min(SWEEP_STRAY_PRIORITIES, budget.left))) {
    if (budget.left-- <= 0) return false;
    const held: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)).order("desc").take(PRIORITY_PASS_CAPS.sessions_per_priority);
    for (const c of held) if (!(await inWorkspace(vis, c, pair.user_id, pair.workspace))) return true;
  }
  return false;
}

/** Every few hours: a pass for each pair with new work, a few seconds apart. */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const pairs: Array<{ user_id: Id<"users">; workspace: string }> = await ctx.runQuery(self.sweepCandidates, {});
    for (const [i, pair] of pairs.entries()) await ctx.scheduler.runAfter(i * SWEEP_STAGGER_MS, self.runPass, pair);
    return pairs.length;
  },
});

// ---------------------------------------------------------------- calibration
//
// `evalPass` runs the pass from empty over a window for the calibration script
// (packages/evals/scripts/priorities-measure.ts) and returns what it would have
// written, writing nothing. It reads through passInputs and asks through the
// same request builder, parser and merge as `pass`, chunk after chunk oldest
// first, carrying each chunk's priorities into the next chunk's input in memory,
// so its end state is what a chain of first passes would leave. Calls go on
// codecast's own key; a team's vendor refusal and the regulated-team filter hold
// as for any pass. Internal, so staff run it (packages/convex/run.sh).

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
    byId.set(short_id, { short_id, title: c.title, summary: c.summary, status: c.status, rank: c.rank, rank_set_by: c.rank_set_by, serves: c.serves, steps: c.steps, last_active_at: c.last_active_at, sessions: [] });
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

/** The pass from empty over [window_start, window_end] for one person in one workspace, written nowhere. `chunk` caps the sessions one model call reads. */
export const evalPass = internalAction({
  args: { user_id: v.id("users"), workspace: v.string(), window_start: v.number(), window_end: v.number(), chunk: v.optional(v.number()), resume: v.optional(v.any()) },
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
      const read: PassInputs = await ctx.runQuery(self.passInputs, { user_id: args.user_id, workspace: args.workspace, now, window_start: state.cursor_at });
      if (!read.input.sessions.length && !read.input.calls.length) {
        if (!read.more || read.read_to <= state.cursor_at) return done();
        state = { ...state, cursor_at: read.read_to };
        continue;
      }
      const tasks = new Map(state.tasks.map((t) => [t.short_id, t]));
      for (const s of read.input.sessions) for (const t of s.tasks) tasks.set(t.short_id, t);
      const stepTaskIds = new Set(state.priorities.flatMap((p) => p.steps.flatMap((s) => s.refs.filter((r) => r.kind === "task").map((r) => r.id))));
      const full: PriorityPassInput = { ...read.input, priorities: state.priorities, step_tasks: [...stepTaskIds].flatMap((id) => tasks.get(id) ?? []) };
      const { input, readTo, left } = runShare(read, full, Math.min(fittingPrefix(full), args.chunk ?? Infinity));
      if (left && readTo <= state.cursor_at) throw new Error(`calibration stuck at cursor ${state.cursor_at}: the next chunk would read the same sessions`);
      for (const s of input.sessions) readIds.set(s.id, s.title);
      const { req, omitted: cut } = priorityPassRequest(input);
      omitted.push(...cut);
      const reply = await runModelCallOrOwn(
        ctx,
        callScope(args.workspace),
        false,
        "grouping",
        { model: req.model, max_tokens: req.max_tokens, system: req.system, prompt: req.prompt, output: "json", output_schema: req.output_schema },
        "Priority pass calibration",
        { ctx, scope: { workspace: args.workspace } },
        PASS_TIMEOUT_MS,
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
    const memberships: Doc<"team_memberships">[] = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", user._id)).take(SWEEP_MEMBERS_READ);
    const workspaces = [{ workspace: `user:${user._id}`, name: "personal" }];
    for (const m of memberships) {
      const team: Doc<"teams"> | null = await ctx.db.get(m.team_id);
      if (team) workspaces.push({ workspace: `team:${m.team_id}`, name: team.name });
    }
    return { user_id: user._id, workspaces };
  },
});
