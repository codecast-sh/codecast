// Priorities (shared/contracts/priorities.ts): the reads behind /priorities,
// the pin line and `cast priorities`, and the person's own controls over them.
//
// Access follows the workspace's sharing settings: a priority is readable by
// its owner, and by a teammate holding its `workspace` key only while the owner
// lists their sessions to that team (privacy.listsSessionsToTeam); nothing is
// readable, writable or run while the `priorities` feature is off there. Only the owner
// changes a priority, and every change marks its field set by the person, so
// the pass (lib/priorityPass.ts) never overrides it.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./functions";
import { internal } from "./_generated/api";
import { verifyApiToken } from "./apiTokens";
import { accessStampFor, accessStampFromDoc, authorizedFor, heldKeysFor, parseWorkspaceKey } from "./lib/accessKeys";
import { teamFeatureOffMessage, teamHasFeature, workspaceHasFeature } from "./lib/teamFeatureGuard";
import { orderPriorities } from "./lib/priorityPass";
import { runBlocker } from "./priorityPassRun";
import { getOwnerMembership } from "./privacy";
import { sessionVisibility, type SessionVisibility } from "./lib/prioritySessionVisibility";
import { isSessionOwner } from "./sessionOwners";
import { TEAM_VISIBILITY_RANK, effectiveMembershipVisibility } from "./teamVisibility";
import type {
  PriorityDetail, PriorityHistory, PriorityHistoryLane, PriorityPinLine, PriorityRef, PriorityRow, PrioritySession, PriorityStatus, PriorityStep,
} from "@codecast/shared/contracts/priorities";
import type { Doc, Id } from "./_generated/dataModel";

const FEATURE = "priorities" as const;
const DAY = 86_400_000;
/** Sessions a list shows per priority, and how many of the owner's mapped sessions it reads to count them before the pass stored a count ("50+" past that). */
const LIST_SESSIONS = 3;
const LIST_COUNT_CAP = 50;
/**
 * A teammate's priority: the newest sessions read to decide whether they may
 * read it (none of these listed to the team: hidden, failing closed) and the
 * ones its row counts ("4+" past that).
 */
const TEAMMATE_SESSIONS = 4;
/** The most teammates' priorities one list judges, the most recently active first (more with `all` or a status); past that it says `teammates_truncated`. */
export const TEAMMATE_PRIORITIES_CAP = 60;
export const TEAMMATE_ALL_CAP = 200;
/** The most of one person's priorities of one status in one workspace any read takes (the active ones a rank orders, a list's own). */
const OWN_PRIORITIES_READ = 200;
/** The most of the viewer's own priorities a list reads in one workspace, newest first, before splitting them by status. */
const OWN_SCAN_READ = 1_000;
/** The most mapped sessions `show` reads. */
const SHOW_SESSIONS = 200;
const MAX_HISTORY_DAYS = 30;
/**
 * The most typed messages, and the most sessions, one history reads in all
 * (newest first). The viewer's own read takes at most half when teammates'
 * lanes share it (all of it otherwise); the teammates covered split the rest
 * evenly.
 */
export const HISTORY_SENDS_CAP = 3_000;
export const HISTORY_CONVERSATION_CAP = 500;
/** Without --all or a status, a list leaves out what finished or went quiet longer ago than this. */
const FINISHED_WINDOW_DAYS = 60;

type Ctx = { db: any };
type Priority = Doc<"priorities">;
type Result<T> = T | { error: string };

async function tokenUser(ctx: any, api_token: string): Promise<Id<"users"> | null> {
  const result = await verifyApiToken(ctx, api_token);
  return result ? (result.userId as Id<"users">) : null;
}

/** Is the feature on for the workspace a key names? Unknown keys are off. Memoized per call. */
function featureCheck(ctx: Ctx): (key: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (key) => {
    if (!seen.has(key)) {
      const ws = parseWorkspaceKey(key);
      seen.set(key, !ws ? Promise.resolve(false)
        : ws.type === "team" ? teamHasFeature(ctx, ws.teamId, FEATURE)
        : workspaceHasFeature(ctx, { user_id: ws.userId }, FEATURE));
    }
    return seen.get(key)!;
  };
}

/**
 * Everything one call decides about who sees what, read once per call. Team
 * questions all go through lib/prioritySessionVisibility (`vis`), the one
 * predicate the pass uses too.
 */
type Reader = {
  viewer: Id<"users">;
  held: Set<string>;
  vis: SessionVisibility;
  /** The newest `n` sessions mapped to a priority (by_priority), one read per priority per call. */
  sessionsOf: (p: Priority, n: number) => Promise<Doc<"conversations">[]>;
  /**
   * Whether a session is listed to the viewer (its title, its chip, a count):
   * their own, one they co-own, or one listed to a team of theirs. Nothing
   * here opens a transcript, so nothing needs the content level.
   */
  listed: (c: Doc<"conversations">) => Promise<boolean>;
  /**
   * Who may read a priority (the feature check is the caller's): its owner;
   * a teammate holding its workspace key only while at least one of its
   * newest TEAMMATE_SESSIONS sessions is listed to that team.
   */
  canRead: (p: Priority) => Promise<boolean>;
  /** The priority's steps as the viewer may see them (stepsFor). */
  stepsFor: (p: Priority) => Promise<PriorityStep[]>;
};

async function readerFor(ctx: Ctx, viewer: Id<"users">): Promise<Reader> {
  const held = await heldKeysFor(ctx, viewer);
  const vis = sessionVisibility(ctx);
  const reads = new Map<string, { n: number; rows: Promise<Doc<"conversations">[]> }>();
  const sessionsOf = async (p: Priority, n: number) => {
    const key = String(p._id);
    const had = reads.get(key);
    if (had && had.n >= n) return (await had.rows).slice(0, n);
    const rows: Promise<Doc<"conversations">[]> = ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)).order("desc").take(n);
    reads.set(key, { n, rows });
    return rows;
  };
  const listed = async (c: Doc<"conversations">) => {
    if (String(c.user_id) === String(viewer) || String(c.owner_user_id ?? "") === String(viewer)) return true;
    if (c.team_id && held.has(`team:${c.team_id}`) && (await vis.listedTo(c, c.team_id))) return true;
    return isSessionOwner(ctx, c._id, viewer);
  };
  const canRead = async (p: Priority) => {
    if (String(p.user_id) === String(viewer)) return true;
    if (!authorizedFor(accessStampFromDoc("priorities", p), String(viewer), held)) return false;
    const ws = parseWorkspaceKey(p.workspace);
    if (ws?.type !== "team") return false;
    for (const c of (await sessionsOf(p, TEAMMATE_SESSIONS + 1)).slice(0, TEAMMATE_SESSIONS)) if (await vis.listedTo(c, ws.teamId)) return true;
    return false;
  };

  // A step ref shown to a teammate: a session listed to them, a task they can read, a pull request or commit in a repository of the team's.
  const shown = new Map<string, Promise<boolean>>();
  const refShown = (ref: PriorityRef, teamId: string | null) => {
    const key = `${ref.kind}:${ref.id}`;
    if (!shown.has(key)) {
      shown.set(key, (async () => {
        if (ref.kind === "session") {
          const id = ctx.db.normalizeId("conversations", ref.id);
          const conv: Doc<"conversations"> | null = id ? await ctx.db.get(id) : await ctx.db.query("conversations").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.id)).first();
          return !!conv && (await listed(conv));
        }
        if (ref.kind === "task") {
          const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.id)).first();
          return !!task && authorizedFor(await accessStampFor(ctx, "tasks", task), String(viewer), held);
        }
        const repository = ref.id.split(ref.kind === "pr" ? "#" : "@")[0];
        if (!teamId || !repository) return false;
        for (const table of ["pull_requests", "commits"]) {
          if (await ctx.db.query(table).withIndex("by_team_repository", (q: any) => q.eq("team_id", teamId).eq("repository", repository)).first()) return true;
        }
        return false;
      })());
    }
    return shown.get(key)!;
  };
  /**
   * The owner sees every step whole. A teammate sees each step's refs they may
   * read, and not at all a step whose refs were all sessions none of which is
   * listed to them (its title came from work they cannot see).
   */
  const stepsFor = async (p: Priority): Promise<PriorityStep[]> => {
    if (String(p.user_id) === String(viewer)) return p.steps;
    const ws = parseWorkspaceKey(p.workspace);
    const teamId = ws?.type === "team" ? String(ws.teamId) : null;
    const out: PriorityStep[] = [];
    for (const step of p.steps) {
      const refs: PriorityRef[] = [];
      for (const ref of step.refs) if (await refShown(ref, teamId)) refs.push(ref);
      if (!refs.length && step.refs.length && step.refs.every((ref) => ref.kind === "session")) continue;
      out.push({ ...step, refs });
    }
    return out;
  };
  return { viewer, held, vis, sessionsOf, listed, canRead, stepsFor };
}

/** The workspace a CLI call names: a team, the personal one, or none (every workspace). */
function cliWorkspace(viewer: Id<"users">, args: { team_id?: Id<"teams">; personal?: boolean }): string | undefined {
  if (args.team_id) return `team:${args.team_id}`;
  if (args.personal) return `user:${viewer}`;
  return undefined;
}

const STATUS_ORDER: Record<PriorityStatus, number> = { active: 0, done: 1, quiet: 2, set_aside: 3, merged: 4 };
/** What a list shows without a status: everything but merged, read status by status so merged rows are never read. */
const LISTED_STATUSES: PriorityStatus[] = ["active", "done", "quiet", "set_aside"];

/**
 * Each active priority's position among its owner's active ones in its
 * workspace (orderPriorities: a person's rank is a fixed slot, the pass's fill
 * the rest). `rows` must hold every active priority of each owner and
 * workspace it covers.
 */
function positionsOf(rows: Priority[]): Map<string, number> {
  const groups = new Map<string, Priority[]>();
  for (const r of rows) {
    const k = `${r.user_id}|${r.workspace}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const g of groups.values()) for (const { row, position } of orderPriorities(g)) out.set(String(row._id), position);
  return out;
}

/** One priority's position, read from its owner's active priorities in its workspace. */
async function positionOf(ctx: Ctx, p: Priority): Promise<number | null> {
  if (p.status !== "active") return null;
  const active: Priority[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", p.user_id).eq("workspace", p.workspace).eq("status", "active"))
    .take(OWN_PRIORITIES_READ);
  return positionsOf(active).get(String(p._id)) ?? null;
}

function criticalCounts(p: Priority): { critical_done: number; critical_total: number } {
  const critical = p.steps.filter((s) => s.tier === "critical");
  return { critical_done: critical.filter((s) => s.done).length, critical_total: critical.length };
}

/** Mapped sessions, newest started first (by_priority); null where one is not listed to the viewer. */
type Mapped = Array<PrioritySession | null>;

async function mappedSessions(r: Reader, p: Priority, read: number): Promise<Mapped> {
  const out: Mapped = [];
  for (const c of await r.sessionsOf(p, read)) {
    out.push((await r.listed(c)) ? { short_id: c.short_id ?? String(c._id), title: c.title ?? "", step_key: c.priority_step_key ?? null, updated_at: c.updated_at } : null);
  }
  return out;
}

const isOwner = (viewer: Id<"users">, p: Priority) => String(p.user_id) === String(viewer);

/** How many mapped sessions the count reads: the owner's stored count needs none; else the owner's newest LIST_COUNT_CAP, a teammate's newest TEAMMATE_SESSIONS. */
const countWindow = (viewer: Id<"users">, p: Priority): number =>
  !isOwner(viewer, p) ? TEAMMATE_SESSIONS : p.session_count !== undefined ? 0 : LIST_COUNT_CAP;

/** How many of the newest sessions a list reads: its three (and one spare), or the count's window and one more to know there are more. */
const listRead = (viewer: Id<"users">, p: Priority) => Math.max(LIST_SESSIONS, countWindow(viewer, p)) + 1;

/**
 * The session count a reader sees, the same in a list and in `show`: the
 * owner, the pass's stored count (before it stored one, the newest
 * LIST_COUNT_CAP counted); a teammate, the sessions listed to them among the
 * newest TEAMMATE_SESSIONS; "n+" when more were mapped than counted.
 */
function sessionCount(viewer: Id<"users">, p: Priority, mapped: Mapped): { count: number; more: boolean } {
  const window = countWindow(viewer, p);
  if (!window) return { count: p.session_count!, more: false };
  return { count: mapped.slice(0, window).filter(Boolean).length, more: mapped.length > window };
}

async function ownerNames(ctx: Ctx, rows: Priority[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const r of rows) {
    const id = String(r.user_id);
    if (!names.has(id)) names.set(id, ((await ctx.db.get(r.user_id)) as any)?.name ?? "");
  }
  return names;
}

/**
 * `position` is where it shows among the owner's active priorities (null when
 * not active); `steps` are the ones the viewer may see (Reader.stepsFor); the
 * row lists at most `limit` sessions. The critical-path counts are the
 * priority's own, over every step.
 */
function rowFor(viewer: Id<"users">, p: Priority, owner: string, position: number | null, steps: PriorityStep[], mapped: Mapped, limit = Infinity): PriorityRow {
  const { count, more } = sessionCount(viewer, p, mapped);
  return {
    _id: p._id,
    short_id: p.short_id,
    title: p.title,
    summary: p.summary,
    status: p.status,
    rank: position,
    rank_set_by: p.rank_set_by,
    serves: p.serves ?? null,
    steps,
    counts: criticalCounts(p),
    workspace: p.workspace,
    user_id: p.user_id,
    owner,
    mine: String(p.user_id) === String(viewer),
    first_seen_at: p.first_seen_at,
    last_active_at: p.last_active_at,
    done_at: p.done_at ?? null,
    session_count: count,
    session_count_more: more,
    sessions: mapped.filter((c): c is PrioritySession => c !== null).slice(0, limit),
  };
}

/** One priority's row as a write echoes it. */
async function echo(ctx: Ctx, viewer: Id<"users">, id: Id<"priorities">): Promise<PriorityRow> {
  const p: Priority = await ctx.db.get(id);
  const names = await ownerNames(ctx, [p]);
  const r = await readerFor(ctx, viewer);
  const mapped = await mappedSessions(r, p, listRead(viewer, p));
  return rowFor(viewer, p, names.get(String(p.user_id)) ?? "", await positionOf(ctx, p), await r.stepsFor(p), mapped, LIST_SESSIONS);
}

/**
 * The priorities the viewer can read in one workspace (or all of theirs).
 * Merged ones only when asked for by status. Without a status or `all`, done
 * and quiet ones only from the last FINISHED_WINDOW_DAYS. The viewer's own are
 * read newest first (by_user_workspace_active, OWN_SCAN_READ rows a workspace,
 * at most OWN_PRIORITIES_READ a status), and `own_truncated` says when more
 * were there; teammates' newest first (by_workspace_status_active), at most
 * TEAMMATE_PRIORITIES_CAP judged (TEAMMATE_ALL_CAP with `all` or a status),
 * and `teammates_truncated` says when more were there.
 */
async function visiblePriorities(ctx: Ctx, r: Reader, workspace: string | undefined, status: PriorityStatus | undefined, all: boolean): Promise<{ rows: Priority[]; own_truncated: boolean; teammates_truncated: boolean }> {
  const since = Date.now() - FINISHED_WINDOW_DAYS * DAY;
  const windowed = (st: PriorityStatus) => !status && !all && (st === "done" || st === "quiet");
  const cap = status || all ? TEAMMATE_ALL_CAP : TEAMMATE_PRIORITIES_CAP;
  const featureOn = featureCheck(ctx);
  const keys = workspace ? (r.held.has(workspace) ? [workspace] : []) : [...r.held];
  const own: Priority[] = [];
  const theirs: Priority[] = [];
  let truncated = false;
  let ownTruncated = false;
  for (const key of keys) {
    if (!(await featureOn(key))) continue;
    // The viewer's own in this workspace, newest first, in one read split by status.
    const scan: Priority[] = await ctx.db
      .query("priorities")
      .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", r.viewer).eq("workspace", key))
      .order("desc")
      .take(OWN_SCAN_READ + 1);
    if (scan.length > OWN_SCAN_READ) ownTruncated = true;
    for (const st of status ? [status] : LISTED_STATUSES) {
      const ofStatus = scan.slice(0, OWN_SCAN_READ).filter((p) => p.status === st && (!windowed(st) || p.last_active_at >= since));
      if (ofStatus.length > OWN_PRIORITIES_READ) ownTruncated = true;
      const mine = ofStatus.slice(0, OWN_PRIORITIES_READ);
      own.push(...mine);
      if (!key.startsWith("team:")) continue;
      // Newest first; the viewer's own come back in this read too, so it reads that many more.
      const limit = cap + mine.length;
      const rows: Priority[] = await ctx.db
        .query("priorities")
        .withIndex("by_workspace_status_active", (q: any) => (windowed(st) ? q.eq("workspace", key).eq("status", st).gte("last_active_at", since) : q.eq("workspace", key).eq("status", st)))
        .order("desc")
        .take(limit + 1);
      if (rows.length > limit) truncated = true;
      for (const p of rows.slice(0, limit)) if (!isOwner(r.viewer, p)) theirs.push(p);
    }
  }
  theirs.sort((a, b) => b.last_active_at - a.last_active_at);
  const judged: Priority[] = [];
  for (const p of theirs.slice(0, cap)) if (await r.canRead(p)) judged.push(p);
  return { rows: [...own, ...judged], own_truncated: ownTruncated, teammates_truncated: truncated || theirs.length > cap };
}

/**
 * The viewer's own first, then each teammate's; within a person, active
 * before done, quiet and set aside, each in rank order.
 */
async function listFor(ctx: Ctx, viewer: Id<"users">, args: { workspace?: string; status?: PriorityStatus; all?: boolean }): Promise<{ priorities: PriorityRow[]; own_truncated: boolean; teammates_truncated: boolean }> {
  const r = await readerFor(ctx, viewer);
  const { rows, own_truncated, teammates_truncated } = await visiblePriorities(ctx, r, args.workspace, args.status, !!args.all);
  const names = await ownerNames(ctx, rows);
  const positions = positionsOf(rows);
  const at = (p: Priority) => positions.get(String(p._id)) ?? Infinity;
  const mine = (p: Priority) => (String(p.user_id) === String(viewer) ? 0 : 1);
  rows.sort((a, b) =>
    mine(a) - mine(b)
    || (names.get(String(a.user_id)) ?? "").localeCompare(names.get(String(b.user_id)) ?? "")
    || String(a.user_id).localeCompare(String(b.user_id))
    || a.workspace.localeCompare(b.workspace)
    || STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || at(a) - at(b)
    || b.last_active_at - a.last_active_at);
  const out: PriorityRow[] = [];
  for (const p of rows) out.push(rowFor(viewer, p, names.get(String(p.user_id)) ?? "", positions.get(String(p._id)) ?? null, await r.stepsFor(p), await mappedSessions(r, p, listRead(viewer, p)), LIST_SESSIONS));
  return { priorities: out, own_truncated, teammates_truncated };
}

async function byShortId(ctx: Ctx, shortId: string): Promise<Priority | null> {
  return await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId.trim().toLowerCase())).first();
}

/** A priority the viewer can read, or the plain reason they cannot. */
async function readable(ctx: Ctx, r: Reader, shortId: string): Promise<Result<Priority>> {
  const p = await byShortId(ctx, shortId);
  // Access first, so the feature message never tells someone a priority exists.
  if (!p || p.status === "merged" || !(await r.canRead(p))) return { error: `no priority ${shortId} you can see` };
  if (!(await featureCheck(ctx)(p.workspace))) return { error: teamFeatureOffMessage(FEATURE) };
  return p;
}

async function showFor(ctx: Ctx, viewer: Id<"users">, shortId: string): Promise<Result<PriorityDetail>> {
  const r = await readerFor(ctx, viewer);
  const p = await readable(ctx, r, shortId);
  if ("error" in p) return p;
  const names = await ownerNames(ctx, [p]);
  const mapped = await mappedSessions(r, p, SHOW_SESSIONS);
  const steps = await r.stepsFor(p);
  const row = rowFor(viewer, p, names.get(String(p.user_id)) ?? "", await positionOf(ctx, p), steps, mapped);
  const sessions = row.sessions;
  return {
    ...row,
    steps: steps.map((s) => ({ ...s, sessions: sessions.filter((c) => c.step_key === s.key) })),
    other_sessions: sessions.filter((c) => !steps.some((s) => s.key === c.step_key)),
  };
}

/**
 * Typed messages per local day: one lane per priority the viewer can read and
 * one ("unassigned") for the viewer's sessions no priority holds. A lane counts
 * its owner's typing: the viewer's own for their priorities; a teammate's for
 * theirs, each message only in a session listed to that team
 * (lib/prioritySessionVisibility) and only if the teammate shared at least
 * their activity with the team when they typed it. Option picks on a decision
 * card are not typing. `sessions` splits the same counts by session, for
 * sessions listed to the viewer. The reads share one budget (HISTORY_SENDS_CAP
 * messages, HISTORY_CONVERSATION_CAP sessions): the viewer's own takes at most
 * half when there are teammates' lanes, all of it when not; the teammates
 * split the rest. When a person's share runs out, every visible lane of theirs
 * (and the viewer's unassigned) says `truncated`.
 */
async function historyFor(ctx: Ctx, viewer: Id<"users">, args: { days?: number; workspace?: string; tz_offset_minutes?: number }): Promise<PriorityHistory> {
  const days = Math.min(MAX_HISTORY_DAYS, Math.max(1, Math.floor(args.days ?? 15)));
  const shift = (args.tz_offset_minutes ?? 0) * 60_000;
  const firstLocal = Math.floor((Date.now() - shift) / DAY) * DAY - (days - 1) * DAY;
  const dayKeys = Array.from({ length: days }, (_, i) => new Date(firstLocal + i * DAY).toISOString().slice(0, 10));
  const dayOf = (ts: number) => Math.floor((ts - shift - firstLocal) / DAY);

  const r = await readerFor(ctx, viewer);
  const featureOn = featureCheck(ctx);
  const { rows: visible } = await visiblePriorities(ctx, r, args.workspace, undefined, false);
  const own = new Map(visible.filter((p) => String(p.user_id) === String(viewer)).map((p) => [String(p._id), p]));
  const byOwner = new Map<string, Priority[]>();
  for (const p of visible) if (String(p.user_id) !== String(viewer)) byOwner.set(String(p.user_id), [...(byOwner.get(String(p.user_id)) ?? []), p]);

  const convs = new Map<string, Promise<Doc<"conversations"> | null>>();
  const shown = new Map<string, Promise<boolean>>();
  const sessions: Record<string, number[]> = {};
  const lanes = new Map<string, { p: Priority | null; owner: string | null; counts: number[]; truncated: boolean }>();
  const laneFor = (key: string, p: Priority | null, owner: string | null) => {
    if (!lanes.has(key)) lanes.set(key, { p, owner, counts: new Array(days).fill(0), truncated: false });
    return lanes.get(key)!;
  };

  let sendsLeft = HISTORY_SENDS_CAP;
  let convsLeft = HISTORY_CONVERSATION_CAP;
  /** One person's typed messages in the window, newest first, each with its session, within the share given. */
  const typedBy = async (user: Id<"users">, share: { sends: number; convs: number }) => {
    const rows: Doc<"user_sends">[] = share.sends > 0 ? await ctx.db
      .query("user_sends")
      .withIndex("by_user_timestamp", (q: any) => q.eq("user_id", user).gte("timestamp", firstLocal + shift))
      .order("desc")
      .take(share.sends) : [];
    let truncated = share.sends <= 0 || rows.length === share.sends;
    sendsLeft -= rows.length;
    const read = new Set<string>();
    const out: Array<{ send: Doc<"user_sends">; day: number; conv: Doc<"conversations"> }> = [];
    for (const send of rows) {
      const day = dayOf(send.timestamp);
      if (send.decision?.picked || day < 0 || day >= days) continue;
      const cid = String(send.conversation_id);
      if (!read.has(cid)) {
        if (read.size >= share.convs) { truncated = true; continue; }
        read.add(cid);
        convsLeft--;
      }
      if (!convs.has(cid)) convs.set(cid, ctx.db.get(send.conversation_id));
      const conv = await convs.get(cid);
      if (conv) out.push({ send, day, conv });
    }
    return { typed: out, truncated };
  };
  /** One message into a priority's lane, and into its session's row when the session is listed to the viewer. */
  const countInto = async (p: Priority, owner: string | null, conv: Doc<"conversations">, day: number) => {
    laneFor(p.short_id, p, owner).counts[day]++;
    const cid = String(conv._id);
    if (!shown.has(cid)) shown.set(cid, r.listed(conv));
    if (await shown.get(cid)) (sessions[conv.short_id ?? cid] ??= new Array(days).fill(0))[day]++;
  };

  // The viewer's own typing, at most half the budget when teammates' lanes share it: their priorities' lanes, and unassigned.
  const half = byOwner.size ? 2 : 1;
  const mine = await typedBy(viewer, { sends: HISTORY_SENDS_CAP / half, convs: HISTORY_CONVERSATION_CAP / half });
  for (const { send, day, conv } of mine.typed) {
    if (conv.priority_id) {
      const p = own.get(String(conv.priority_id));
      if (p) await countInto(p, null, conv, day);
      continue;
    }
    const key = await r.vis.workspaceOf(conv);
    if (!r.held.has(key) || (args.workspace && key !== args.workspace)) continue;
    if (!(await featureOn(key))) continue;
    laneFor("unassigned", null, null).counts[day]++;
  }
  if (mine.truncated) {
    for (const p of own.values()) laneFor(p.short_id, p, null).truncated = true;
    laneFor("unassigned", null, null).truncated = true;
  }

  // Teammates' priorities they let the viewer read, each owner's own typing in an even share of what is left.
  const names = await ownerNames(ctx, [...byOwner.values()].map((owned) => owned[0]));
  const share = { sends: Math.floor(sendsLeft / Math.max(1, byOwner.size)), convs: Math.floor(convsLeft / Math.max(1, byOwner.size)) };
  for (const [ownerId, owned] of byOwner) {
    const owner = names.get(ownerId) ?? "";
    const byId = new Map(owned.map((p) => [String(p._id), p]));
    const memberships = new Map<string, Promise<any>>();
    const typed = await typedBy(owned[0].user_id, share);
    for (const { send, day, conv } of typed.typed) {
      const p = conv.priority_id ? byId.get(String(conv.priority_id)) : undefined;
      const ws = p && parseWorkspaceKey(p.workspace);
      if (!p || ws?.type !== "team" || !(await r.vis.listedTo(conv, ws.teamId))) continue;
      if (!memberships.has(ws.teamId)) memberships.set(ws.teamId, getOwnerMembership(ctx, p.user_id, ws.teamId));
      const level = effectiveMembershipVisibility(await memberships.get(ws.teamId), send.timestamp);
      if (TEAM_VISIBILITY_RANK[level] >= TEAM_VISIBILITY_RANK.activity) await countInto(p, owner, conv, day);
    }
    if (typed.truncated) for (const p of owned) laneFor(p.short_id, p, owner).truncated = true;
  }

  const ordered = [...lanes.entries()].sort(([ka, a], [kb, b]) => {
    if (!a.p || !b.p) return a.p ? -1 : b.p ? 1 : 0;
    const mineFirst = (p: Priority) => (String(p.user_id) === String(viewer) ? 0 : 1);
    return mineFirst(a.p) - mineFirst(b.p) || STATUS_ORDER[a.p.status] - STATUS_ORDER[b.p.status] || b.p.last_active_at - a.p.last_active_at || ka.localeCompare(kb);
  });
  return {
    days: dayKeys,
    lanes: ordered.map(([key, { p, owner, counts, truncated }]): PriorityHistoryLane => ({
      key,
      short_id: p?.short_id ?? null,
      title: p?.title ?? "Unassigned",
      status: p?.status ?? null,
      counts,
      total: counts.reduce((a, b) => a + b, 0),
      ...(owner !== null ? { owner } : {}),
      ...(truncated ? { truncated: true } : {}),
    })),
    sessions,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────

/** A priority the viewer owns, or the plain reason they cannot change it. */
async function owned(ctx: Ctx, viewer: Id<"users">, shortId: string): Promise<Result<Priority>> {
  const p = await readable(ctx, await readerFor(ctx, viewer), shortId);
  if ("error" in p) return p;
  if (String(p.user_id) !== String(viewer)) {
    const name = ((await ctx.db.get(p.user_id)) as any)?.name;
    return { error: `${p.short_id} is ${name ? `${name}'s` : "someone else's"} priority; only they can change it` };
  }
  return p;
}

async function doRank(ctx: Ctx, viewer: Id<"users">, shortId: string, rank: number): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  if (p.status !== "active") return { error: `${p.short_id} is ${p.status.replace("_", " ")}; only active priorities are ranked (restore it first)` };
  if (!Number.isInteger(rank) || rank < 1) return { error: "a rank is a whole number from 1" };
  // `rank` is the position the person wants it shown at; it is stored as a slot
  // (orderPriorities fits the pass's priorities around the person's). First every
  // other slot the person set moves to where it shows now, so a slot past the end
  // or across a gap reads as its position; then the one at the wanted slot, and
  // any it lands on, moves down one, so the person's slots never collide.
  const now = Date.now();
  const active: Priority[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", viewer).eq("workspace", p.workspace).eq("status", "active"))
    .take(OWN_PRIORITIES_READ);
  const others = active.filter((r) => String(r._id) !== String(p._id));
  const to = Math.min(rank, active.length);
  let next = to;
  for (const { row, position } of orderPriorities(others)) {
    if (row.rank_set_by !== "person") continue;
    let slot = position;
    if (slot === next) slot = ++next;
    if (slot !== row.rank) await ctx.db.patch(row._id, { rank: slot, updated_at: now });
  }
  await ctx.db.patch(p._id, { rank: to, rank_set_by: "person", updated_at: now });
  return echo(ctx, viewer, p._id);
}

async function doStepTier(ctx: Ctx, viewer: Id<"users">, shortId: string, stepKey: string, tier: "critical" | "polish"): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  const key = stepKey.trim().toLowerCase();
  if (!p.steps.some((s) => s.key === key)) return { error: `${p.short_id} has no step ${stepKey}; its steps: ${p.steps.map((s) => s.key).join(", ") || "none"}` };
  const steps = p.steps.map((s) => (s.key === key ? { ...s, tier, tier_set_by: "person" as const } : s));
  await ctx.db.patch(p._id, { steps, updated_at: Date.now() });
  return echo(ctx, viewer, p._id);
}

/** Set aside leaves the ranking; restore brings a set-aside priority back active, last among the pass-ranked. */
async function doSetAside(ctx: Ctx, viewer: Id<"users">, shortId: string, aside: boolean): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  const now = Date.now();
  if (aside) {
    if (p.status !== "set_aside") await ctx.db.patch(p._id, { status: "set_aside", rank: undefined, rank_set_by: "pass", updated_at: now });
    return echo(ctx, viewer, p._id);
  }
  if (p.status !== "set_aside") return { error: `${p.short_id} is ${p.status.replace("_", " ")}, not set aside; only a set-aside priority is restored` };
  const active: Priority[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", viewer).eq("workspace", p.workspace).eq("status", "active"))
    .take(OWN_PRIORITIES_READ);
  const last = Math.max(0, ...active.filter((r) => r.rank_set_by === "pass").map((r) => r.rank ?? 0));
  await ctx.db.patch(p._id, { status: "active", rank: last + 1, rank_set_by: "pass", updated_at: now });
  return echo(ctx, viewer, p._id);
}

function orThrow<T>(res: Result<T>): T {
  if (res && typeof res === "object" && "error" in res) throw new Error(res.error);
  return res as T;
}

const statusArg = v.optional(v.union(v.literal("active"), v.literal("done"), v.literal("quiet"), v.literal("set_aside"), v.literal("merged")));
const tierArg = v.union(v.literal("critical"), v.literal("polish"));
const cliScope = { team_id: v.optional(v.id("teams")), personal: v.optional(v.boolean()) };

// ── Web (signed-in user) ─────────────────────────────────────────────────

export const list = query({
  args: { workspace: v.optional(v.string()), status: statusArg, all: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<PriorityRow[]> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return [];
    // The web reads the rows; own_truncated and teammates_truncated reach the CLI (cliList).
    return (await listFor(ctx, viewer, args)).priorities;
  },
});

export const show = query({
  args: { short_id: v.string() },
  handler: async (ctx, { short_id }): Promise<PriorityDetail | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    const res = await showFor(ctx, viewer, short_id);
    return "error" in res ? null : res;
  },
});

export const history = query({
  args: { days: v.optional(v.number()), workspace: v.optional(v.string()), tz_offset_minutes: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PriorityHistory> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return { days: [], lanes: [] };
    return historyFor(ctx, viewer, args);
  },
});

/**
 * The line under a mapped session's pinned state: for the priority's owner,
 * and for a teammate holding its workspace key when this open session is
 * listed to that team (summary level is enough: the line names the priority,
 * not the transcript). No scan of the priority's other sessions: one
 * conversation read, one priority read, the owner's membership, and the
 * owner's active priorities for its position.
 */
export const pinLine = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }): Promise<PriorityPinLine | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    const conv = await ctx.db.get(conversation_id);
    if (!conv?.priority_id) return null;
    const p = await ctx.db.get(conv.priority_id);
    if (!p || p.status === "merged") return null;
    // Only the open session is judged: the owner's, or a teammate's listed to the team that holds the priority.
    if (String(p.user_id) !== String(viewer)) {
      const ws = parseWorkspaceKey(p.workspace);
      if (ws?.type !== "team" || !authorizedFor(accessStampFromDoc("priorities", p), String(viewer), await heldKeysFor(ctx, viewer))) return null;
      if (!(await sessionVisibility(ctx).listedTo(conv, ws.teamId))) return null;
    }
    if (!(await featureCheck(ctx)(p.workspace))) return null;
    const step = p.steps.find((s) => s.key === conv.priority_step_key);
    return {
      short_id: p.short_id,
      title: p.title,
      rank: await positionOf(ctx, p),
      ...criticalCounts(p),
      ...(step ? { step_title: step.title } : {}),
    };
  },
});

async function authed(ctx: any): Promise<Id<"users">> {
  const viewer = await getAuthUserId(ctx);
  if (!viewer) throw new Error("Not signed in");
  return viewer;
}

export const rank = mutation({
  args: { short_id: v.string(), rank: v.number() },
  handler: async (ctx, args) => orThrow(await doRank(ctx, await authed(ctx), args.short_id, args.rank)),
});

export const setStepTier = mutation({
  args: { short_id: v.string(), step_key: v.string(), tier: tierArg },
  handler: async (ctx, args) => orThrow(await doStepTier(ctx, await authed(ctx), args.short_id, args.step_key, args.tier)),
});

export const setAside = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doSetAside(ctx, await authed(ctx), args.short_id, true)),
});

export const restore = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doSetAside(ctx, await authed(ctx), args.short_id, false)),
});

// ── CLI (api token) ──────────────────────────────────────────────────────

export const cliList = query({
  args: { api_token: v.string(), status: statusArg, all: v.optional(v.boolean()), ...cliScope },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return await listFor(ctx, viewer, { workspace: cliWorkspace(viewer, args), status: args.status, all: args.all });
  },
});

export const cliShow = query({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return await showFor(ctx, viewer, args.short_id);
  },
});

export const cliHistory = query({
  args: { api_token: v.string(), days: v.optional(v.number()), tz_offset_minutes: v.optional(v.number()), ...cliScope },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return historyFor(ctx, viewer, { days: args.days, tz_offset_minutes: args.tz_offset_minutes, workspace: cliWorkspace(viewer, args) });
  },
});

export const cliRank = mutation({
  args: { api_token: v.string(), short_id: v.string(), rank: v.number() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doRank(ctx, viewer, args.short_id, args.rank);
  },
});

export const cliSetStepTier = mutation({
  args: { api_token: v.string(), short_id: v.string(), step_key: v.string(), tier: tierArg },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doStepTier(ctx, viewer, args.short_id, args.step_key, args.tier);
  },
});

export const cliSetAside = mutation({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doSetAside(ctx, viewer, args.short_id, true);
  },
});

export const cliRestore = mutation({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doSetAside(ctx, viewer, args.short_id, false);
  },
});

/**
 * One pass now, for the caller, in the named workspace (one they belong to)
 * or in every workspace of theirs with the feature on. Returns at once with
 * what was scheduled and the plain reason runNow would refuse any other; the
 * pass writes in about a minute.
 */
export const cliRun = mutation({
  args: { api_token: v.string(), ...cliScope },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    const named = cliWorkspace(viewer, args);
    const held = await heldKeysFor(ctx, viewer);
    if (named && !held.has(named)) return { error: "you are not a member of that team" };
    const featureOn = featureCheck(ctx);
    const now = Date.now();
    const scheduled: string[] = [];
    const skipped: Array<{ workspace: string; reason: string }> = [];
    for (const workspace of named ? [named] : held) {
      if (!(await featureOn(workspace))) continue;
      // runNow's own checks, read-only: reserve decides for real when the pass starts.
      const blocked = await runBlocker(ctx, viewer, workspace, now, true);
      if (blocked) { skipped.push({ workspace, reason: blocked.reason }); continue; }
      await ctx.scheduler.runAfter(0, (internal as any).priorityPassRun.runNow, { user_id: viewer, workspace });
      scheduled.push(workspace);
    }
    if (!scheduled.length) return { error: skipped.length ? skipped.map((s) => s.reason).join(" ") : teamFeatureOffMessage(FEATURE) };
    return { scheduled, skipped, note: "A pass is running; its priorities land in about a minute (cast priorities)." };
  },
});
