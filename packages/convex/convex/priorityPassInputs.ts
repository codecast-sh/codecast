// What one priorities pass reads (priorityPassRun.ts runs it): for one person
// in one workspace, where their cursor stands and what they touched since.
//
// Every run leaves one priority_pass_runs row, and the furthest cursor_at
// among the recent rows is where the next run starts (runs finish out of
// order). Sessions are read oldest first: when more moved than one prompt
// holds, the run reads as many as fit and the next run reads the rest.

import { v } from "convex/values";
import { internalQuery } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { sessionVisibility, type SessionVisibility } from "./lib/prioritySessionVisibility";
import { canReadCall } from "./transcripts";
import { isRestricted } from "./chatAccess";
import { isStandingSession } from "./lib/orgOwnership";
import { isRunLog, parseRoomKey } from "@codecast/shared/contracts";
import { vendorRefusalFromDb } from "./lib/vendorGuard";
import { PRIORITY_PASS_CAPS, type PassCall, type PassPriority, type PassSession, type PassTask, type PriorityPassInput } from "./lib/priorityPass";

export const DAY = 86_400_000;
export const MINUTE = 60_000;
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
/** The oldest typed messages and pin events a probe reads (each). A typed message holds up to 8 KB: this keeps it far under the read limit. */
const ACTIVITY_READ = 1_000;
/** The sessions touched earliest that one pass reads; the prompt may fit fewer. A pass reads activity until this many sessions, not a count of rows. */
const SESSIONS_READ = 50; // 88 in one chunk overflowed the reply's 16k-token limit in calibration (Nov 25)
/** The most typed messages and pin events one pass scans, together, while it collects its sessions: a guard on the read limit. */
const ACTIVITY_SCAN = 2_000;
const TASKS_PER_SESSION = 12;
const PR_LINKS_PER_SESSION = 10;
/** Pull request rows one pass loads beyond what sessions fold: a row carries its files and can reach 1 MB. */
const PR_ROWS_READ = 8;
const PRIORITIES_READ = 200;
/** The newest calls one pass looks through for the ones the person was in; the prompt keeps fewer (PRIORITY_PASS_CAPS.calls). */
const CALLS_READ = 30;
/** A call started this long before the cursor can still have ended after it. */
const CALL_LONGEST_MS = DAY;
const INITIATIVES_READ = 200;
/** The newest runs read for the cursor and the failures in a row. */
const RECENT_RUNS = 30;
/** A reservation older than this belongs to a run that died (an action stops at 10 minutes). */
export const RESERVATION_TTL_MS = 15 * MINUTE;

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

const sessionId = (conv: Doc<"conversations">) => conv.short_id ?? String(conv._id);
/** The person's own session, counting in this workspace (lib/prioritySessionVisibility: its team's only while listed there). */
export const inWorkspace = async (vis: SessionVisibility, conv: Doc<"conversations">, userId: Id<"users">, workspace: string) =>
  String(conv.user_id) === String(userId) && (await vis.workspaceOf(conv)) === workspace;

/** The pair's newest runs by start, newest first; runs started in one millisecond in creation order (the index's own tie-break). */
export const recentRuns = (ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<Doc<"priority_pass_runs">[]> =>
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
export async function cursorState(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<{ cursor_at: number; set_at: number } | null> {
  const settled = (await recentRuns(ctx, userId, workspace)).filter((r) => r.status !== "running");
  if (!settled.length) return null;
  const cursor_at = Math.max(...settled.map((r) => r.cursor_at));
  const there = settled.filter((r) => r.cursor_at === cursor_at);
  const ok = there.filter((r) => r.status === "ok");
  const set_at = ok.length ? Math.max(...ok.map((r) => r.started_at)) : Math.min(...there.map((r) => r.started_at));
  return { cursor_at, set_at };
}

/** Where a session's activity in a read starts: its first row past the cursor (a late row below it counts as at the cursor). */
export const firstAfter = (s: { typed: Array<{ at: number }>; pin_events: Array<{ at: number }> }, cursor: number): number =>
  Math.min(...[...s.typed, ...s.pin_events].map((r) => Math.max(r.at, cursor)));

export async function cursorFor(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<number> {
  return (await cursorState(ctx, userId, workspace))?.cursor_at ?? now - FIRST_PASS_WINDOW_MS;
}

/**
 * The person's typed messages and pin events in (since, until], oldest first,
 * and how far that read is complete (`read_to`). When either list fills its
 * limit, both stop short of where it stopped.
 */
export async function activitySince(ctx: { db: any }, userId: Id<"users">, since: number, until: number, limit = ACTIVITY_READ) {
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
 * One person's priorities in one workspace the pass reads, newest first (one
 * read of their newest 4 × `limit`): the active and set-aside ones, and the
 * done or quiet ones that moved within PRIORITY_PASS_CAPS.finished_days
 * (older ones the prompt hides are left out whole), at most `limit` of each,
 * and every one that needs a rewrite (up to `limit`), however old.
 */
export async function livePriorities(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number, limit: number): Promise<Doc<"priorities">[]> {
  const rows: Doc<"priorities">[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", userId).eq("workspace", workspace))
    .order("desc")
    .take(4 * limit);
  const hiddenBefore = now - PRIORITY_PASS_CAPS.finished_days * DAY;
  const of = (status: Doc<"priorities">["status"]) =>
    rows.filter((p) => p.status === status && (status === "active" || status === "set_aside" || p.last_active_at >= hiddenBefore)).slice(0, limit);
  const rewrite: Doc<"priorities">[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_rewrite", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).eq("needs_rewrite", true))
    .take(limit);
  const out = new Map([...of("active"), ...of("set_aside"), ...of("done"), ...of("quiet"), ...rewrite.filter((p) => p.status !== "merged")].map((p) => [String(p._id), p]));
  return [...out.values()].sort((a, b) => b.last_active_at - a.last_active_at);
}

/**
 * Assembles the pass's input for one person in one workspace: what they
 * touched since the cursor, and their priorities now. A session filed under a
 * team whose data may not go to the model vendor is left out, whichever
 * workspace it reads in.
 */
/**
 * A session's pin as it stood at `now`. A calibration replay of a past window
 * runs with `now` behind the clock: a pin written after it is the future and
 * is withheld, and the session's newest pin event in the window stands in. A
 * live pass's `now` is the clock, so it always sees the current pin.
 */
function pinAsOf(conv: Doc<"conversations">, events: PassSession["pin_events"], now: number): PassSession["pin"] {
  if (conv.thread_state && (conv.thread_state_at ?? 0) <= now) return { text: conv.thread_state, ...(conv.thread_state_status ? { status: conv.thread_state_status } : {}) };
  const last = events.at(-1);
  return last ? { text: last.text } : null;
}

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
    const since = overlap ? cursor_at - OVERLAP_MS : cursor_at;
    const fresh = (at: number, landed: number) => !overlap || at > cursor_at || landed > overlap.set_at;

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
    // The person's typed messages and pin events, oldest first, collapsed into
    // the sessions they touched: the read stops at the SESSIONS_READ-th session
    // (or ACTIVITY_SCAN rows) and the cursor moves to just before the first
    // session it left out. Each session keeps its newest pin events only.
    const touched = new Map<string, { conv: Doc<"conversations">; last: number; typed: PassSession["typed"]; pin_events: PassSession["pin_events"] }>();
    const sendRows = ctx.db.query("user_sends").withIndex("by_user_timestamp", (q: any) => q.eq("user_id", args.user_id).gt("timestamp", since).lte("timestamp", until))[Symbol.asyncIterator]();
    const pinRows = ctx.db.query("thread_state_events").withIndex("by_user_at", (q: any) => q.eq("user_id", args.user_id).gt("at", since).lte("at", until))[Symbol.asyncIterator]();
    let send = await sendRows.next();
    let pin = await pinRows.next();
    let scanned = 0;
    let stopAt: number | null = null;
    while (!send.done || !pin.done) {
      const isSend = !send.done && (pin.done || send.value.timestamp <= pin.value.at);
      const row = isSend ? send.value : pin.value;
      const at: number = isSend ? row.timestamp : row.at;
      if (++scanned > ACTIVITY_SCAN) { stopAt = at; break; }
      if (fresh(at, row._creationTime)) {
        const conv = await convOf(row.conversation_id);
        if (conv) {
          const key = String(conv._id);
          if (!touched.has(key) && touched.size >= SESSIONS_READ) { stopAt = at; break; }
          const t = touched.get(key) ?? { conv, last: 0, typed: [], pin_events: [] };
          t.last = Math.max(t.last, at);
          if (isSend) t.typed.push({ at, text: row.text });
          else {
            t.pin_events.push({ at, text: row.text });
            if (t.pin_events.length > PRIORITY_PASS_CAPS.pin_events) t.pin_events.shift();
          }
          touched.set(key, t);
        }
      }
      if (isSend) send = await sendRows.next();
      else pin = await pinRows.next();
    }

    // Earliest first activity first, as they were read.
    const oldestFirst = [...touched.values()].sort((a, b) => firstAfter(a, cursor_at) - firstAfter(b, cursor_at));
    const prBudget = { left: PR_ROWS_READ, seen: new Map<string, { ref: string; merged: boolean }>() };
    const sessions: PassSession[] = [];
    for (const t of oldestFirst) {
      const conv = t.conv;
      sessions.push({
        id: sessionId(conv),
        ...(await sessionKind(ctx, conv)),
        title: conv.title ?? "",
        first_prompt: conv.first_prompt ?? "",
        pin: pinAsOf(conv, t.pin_events, now),
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
      let left = false;
      for (const c of held) {
        if (!(await inWorkspace(vis, c, args.user_id, args.workspace))) {
          strays.push(c._id);
          left = true;
        } else if (await mayRead(c)) readable.push(c);
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
        // Its title and summary may come from a session it no longer holds: the pass writes them again.
        ...(p.needs_rewrite || left ? { needs_rewrite: true } : {}),
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
      more: stopAt !== null,
      read_to: stopAt !== null ? Math.max(cursor_at, Math.max(stopAt, cursor_at) - 1) : until,
      strays,
    };
  },
});
