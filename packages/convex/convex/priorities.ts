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
import { canAccessConversation } from "./lib/access";
import { accessStampFromDoc, authorizedFor, heldKeysFor, parseWorkspaceKey } from "./lib/accessKeys";
import { teamFeatureOffMessage, teamHasFeature, workspaceHasFeature } from "./lib/teamFeatureGuard";
import { orderPriorities } from "./lib/priorityPass";
import { runBlocker } from "./priorityPassRun";
import { getOwnerMembership, listsSessionsToTeam, teamReadLevelSync, teamVisibleConvTeam } from "./privacy";
import { isSessionOwner } from "./sessionOwners";
import { TEAM_VISIBILITY_RANK, currentMembershipVisibility, effectiveMembershipVisibility } from "./teamVisibility";
import type {
  PriorityDetail, PriorityHistory, PriorityHistoryLane, PriorityPinLine, PriorityRow, PrioritySession, PriorityStatus,
} from "@codecast/shared/contracts/priorities";
import type { Doc, Id } from "./_generated/dataModel";

const FEATURE = "priorities" as const;
const DAY = 86_400_000;
/** Sessions a list shows per priority, and how many mapped sessions it reads to count them ("50+" past that). */
const LIST_SESSIONS = 3;
const LIST_COUNT_CAP = 50;
/** The most mapped sessions `show` reads. */
const SHOW_SESSIONS = 200;
const MAX_HISTORY_DAYS = 30;
/**
 * The most typed messages, and the most sessions, one history reads in all
 * (newest first). The viewer's own read takes at most half; the teammates it
 * covers split the rest evenly.
 */
export const HISTORY_SENDS_CAP = 3_000;
export const HISTORY_CONVERSATION_CAP = 500;
/** The sessions of a teammate's priority read to find one they list to the viewer. */
const JUDGE_SESSIONS = 20;
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

type Judge = (p: Priority) => Promise<boolean>;

/**
 * Who may read a priority, the workspace's sharing settings (the feature check
 * is the caller's): its owner; a teammate holding its workspace key only while
 * the owner, still on that team, lists their sessions to it
 * (privacy.listsSessionsToTeam, the team session list's rule) and at least one
 * of its newest JUDGE_SESSIONS sessions is listed to that team at the level it
 * started under. Each owner's account and membership are read once per judge.
 */
function priorityJudge(ctx: Ctx, viewer: Id<"users">, held: Set<string>): Judge {
  const shares = new Map<string, Promise<any | null>>();
  return async (p) => {
    if (String(p.user_id) === String(viewer)) return true;
    if (!authorizedFor(accessStampFromDoc("priorities", p), String(viewer), held)) return false;
    const ws = parseWorkspaceKey(p.workspace);
    if (ws?.type !== "team") return false;
    const key = `${p.user_id}|${ws.teamId}`;
    if (!shares.has(key)) {
      shares.set(key, (async () => {
        const membership = await getOwnerMembership(ctx, p.user_id, ws.teamId);
        return membership && listsSessionsToTeam(await ctx.db.get(p.user_id), currentMembershipVisibility(membership)) ? membership : null;
      })());
    }
    const membership = await shares.get(key);
    if (!membership) return false;
    const convs: Doc<"conversations">[] = await ctx.db
      .query("conversations")
      .withIndex("by_priority", (q: any) => q.eq("priority_id", p._id))
      .order("desc")
      .take(JUDGE_SESSIONS);
    return convs.some((c) => String(c.team_id) === String(ws.teamId) && teamReadLevelSync(c, effectiveMembershipVisibility(membership, c.started_at)) !== "none");
  };
}

/** The workspace a CLI call names: a team, the personal one, or none (every workspace). */
function cliWorkspace(viewer: Id<"users">, args: { team_id?: Id<"teams">; personal?: boolean }): string | undefined {
  if (args.team_id) return `team:${args.team_id}`;
  if (args.personal) return `user:${viewer}`;
  return undefined;
}

const STATUS_ORDER: Record<PriorityStatus, number> = { active: 0, done: 1, quiet: 2, set_aside: 3, merged: 4 };

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
    .collect();
  return positionsOf(active).get(String(p._id)) ?? null;
}

function criticalCounts(p: Priority): { critical_done: number; critical_total: number } {
  const critical = p.steps.filter((s) => s.tier === "critical");
  return { critical_done: critical.filter((s) => s.done).length, critical_total: critical.length };
}

/**
 * Whether a session is listed to the viewer (its title, its chip, a count),
 * for one call over many sessions: their own, one they co-own, or a teammate's
 * the team may read at least the summary of (privacy.canTeamMemberReadSummary's
 * rule, `!== "none"`), with the owner's membership read once per owner and
 * team. Nothing here opens a transcript, so no read needs the content level.
 */
function sessionListed(ctx: Ctx, viewer: Id<"users">, held: Set<string>): (c: Doc<"conversations">) => Promise<boolean> {
  const memberships = new Map<string, Promise<any>>();
  return async (c) => {
    if (String(c.user_id) === String(viewer) || String(c.owner_user_id ?? "") === String(viewer)) return true;
    if (c.team_id && held.has(`team:${c.team_id}`)) {
      const k = `${c.user_id}|${c.team_id}`;
      if (!memberships.has(k)) memberships.set(k, getOwnerMembership(ctx, c.user_id, c.team_id));
      if (teamReadLevelSync(c, effectiveMembershipVisibility(await memberships.get(k), c.started_at)) !== "none") return true;
    }
    return isSessionOwner(ctx, c._id, viewer);
  };
}

/** Mapped sessions, newest started first (by_priority); null where one is not listed to the viewer. */
type Mapped = Array<PrioritySession | null>;

async function mappedSessions(ctx: Ctx, p: Priority, canOpen: (c: Doc<"conversations">) => Promise<boolean>, read: number): Promise<Mapped> {
  const convs: Doc<"conversations">[] = await ctx.db
    .query("conversations")
    .withIndex("by_priority", (q: any) => q.eq("priority_id", p._id))
    .order("desc")
    .take(read);
  const out: Mapped = [];
  for (const c of convs) {
    out.push((await canOpen(c)) ? { short_id: c.short_id ?? String(c._id), title: c.title ?? "", step_key: c.priority_step_key ?? null, updated_at: c.updated_at } : null);
  }
  return out;
}

/** The owner reads the pass's stored count, so a list reads only four sessions; anyone else counts what is listed to them. */
const usesStoredCount = (viewer: Id<"users">, p: Priority) => String(p.user_id) === String(viewer) && p.session_count !== undefined;

/** How many of the newest sessions a list reads: enough for its three, or to count up to LIST_COUNT_CAP. */
const listRead = (viewer: Id<"users">, p: Priority) => (usesStoredCount(viewer, p) ? LIST_SESSIONS + 1 : LIST_COUNT_CAP + 1);

/**
 * The session count a reader sees, the same in a list and in `show`: the
 * owner, the pass's stored count; anyone else (or before the pass stored one),
 * the sessions listed to them among the newest LIST_COUNT_CAP, "50+" past that.
 */
function sessionCount(viewer: Id<"users">, p: Priority, mapped: Mapped): { count: number; more: boolean } {
  if (usesStoredCount(viewer, p)) return { count: p.session_count!, more: false };
  return { count: mapped.slice(0, LIST_COUNT_CAP).filter(Boolean).length, more: mapped.length > LIST_COUNT_CAP };
}

async function ownerNames(ctx: Ctx, rows: Priority[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const r of rows) {
    const id = String(r.user_id);
    if (!names.has(id)) names.set(id, ((await ctx.db.get(r.user_id)) as any)?.name ?? "");
  }
  return names;
}

/** `position` is where it shows among the owner's active priorities (null when not active); the row lists at most `limit` sessions. */
function rowFor(viewer: Id<"users">, p: Priority, owner: string, position: number | null, mapped: Mapped, limit = Infinity): PriorityRow {
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
    steps: p.steps,
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
  const mapped = await mappedSessions(ctx, p, sessionListed(ctx, viewer, await heldKeysFor(ctx, viewer)), listRead(viewer, p));
  return rowFor(viewer, p, names.get(String(p.user_id)) ?? "", await positionOf(ctx, p), mapped, LIST_SESSIONS);
}

/**
 * The priorities the viewer can read in one workspace (or all of theirs).
 * Merged ones only when asked for by status; without a status or `all`, done
 * and quiet ones only from the last FINISHED_WINDOW_DAYS.
 */
async function visiblePriorities(ctx: Ctx, viewer: Id<"users">, held: Set<string>, workspace: string | undefined, status: PriorityStatus | undefined, all: boolean): Promise<Priority[]> {
  const since = Date.now() - FINISHED_WINDOW_DAYS * DAY;
  const recent = (r: Priority) => all || (r.status !== "done" && r.status !== "quiet") || (r.done_at ?? r.last_active_at) >= since;
  const featureOn = featureCheck(ctx);
  const canRead = priorityJudge(ctx, viewer, held);
  const keys = workspace ? (held.has(workspace) ? [workspace] : []) : [...held];
  const out: Priority[] = [];
  for (const key of keys) {
    if (!(await featureOn(key))) continue;
    const rows: Priority[] = await ctx.db
      .query("priorities")
      .withIndex("by_workspace_status", (q: any) => (status ? q.eq("workspace", key).eq("status", status) : q.eq("workspace", key)))
      .collect();
    for (const r of rows) if ((status || (r.status !== "merged" && recent(r))) && (await canRead(r))) out.push(r);
  }
  return out;
}

/**
 * The viewer's own first, then each teammate's; within a person, active
 * before done, quiet and set aside, each in rank order.
 */
async function listFor(ctx: Ctx, viewer: Id<"users">, args: { workspace?: string; status?: PriorityStatus; all?: boolean }): Promise<PriorityRow[]> {
  const held = await heldKeysFor(ctx, viewer);
  const rows = await visiblePriorities(ctx, viewer, held, args.workspace, args.status, !!args.all);
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
  const canOpen = sessionListed(ctx, viewer, held);
  const out: PriorityRow[] = [];
  for (const p of rows) out.push(rowFor(viewer, p, names.get(String(p.user_id)) ?? "", positions.get(String(p._id)) ?? null, await mappedSessions(ctx, p, canOpen, listRead(viewer, p)), LIST_SESSIONS));
  return out;
}

async function byShortId(ctx: Ctx, shortId: string): Promise<Priority | null> {
  return await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId.trim().toLowerCase())).first();
}

/** A priority the viewer can read, or the plain reason they cannot. */
async function readable(ctx: Ctx, viewer: Id<"users">, shortId: string): Promise<Result<Priority>> {
  const p = await byShortId(ctx, shortId);
  // Access first, so the feature message never tells someone a priority exists.
  if (!p || p.status === "merged" || !(await priorityJudge(ctx, viewer, await heldKeysFor(ctx, viewer))(p))) return { error: `no priority ${shortId} you can see` };
  if (!(await featureCheck(ctx)(p.workspace))) return { error: teamFeatureOffMessage(FEATURE) };
  return p;
}

async function showFor(ctx: Ctx, viewer: Id<"users">, shortId: string): Promise<Result<PriorityDetail>> {
  const p = await readable(ctx, viewer, shortId);
  if ("error" in p) return p;
  const names = await ownerNames(ctx, [p]);
  const mapped = await mappedSessions(ctx, p, sessionListed(ctx, viewer, await heldKeysFor(ctx, viewer)), SHOW_SESSIONS);
  const row = rowFor(viewer, p, names.get(String(p.user_id)) ?? "", await positionOf(ctx, p), mapped);
  const sessions = row.sessions;
  return {
    ...row,
    steps: p.steps.map((s) => ({ ...s, sessions: sessions.filter((c) => c.step_key === s.key) })),
    other_sessions: sessions.filter((c) => !p.steps.some((s) => s.key === c.step_key)),
  };
}

/**
 * Typed messages per local day: one lane per priority the viewer can read and
 * one ("unassigned") for the viewer's sessions no priority holds. A lane counts
 * its owner's typing: the viewer's own for their priorities; a teammate's for
 * theirs, each message only in a session still visible to that team and only
 * if the teammate shared at least their activity with the team when they typed
 * it (effectiveMembershipVisibility). Option picks on a decision card are not
 * typing. `sessions` splits the same counts by session, for sessions listed to
 * the viewer. The reads share one budget (HISTORY_SENDS_CAP messages,
 * HISTORY_CONVERSATION_CAP sessions): the viewer's own takes at most half, the
 * teammates covered split the rest evenly. When a person's share runs out,
 * every visible lane of theirs (and the viewer's unassigned) says `truncated`.
 */
async function historyFor(ctx: Ctx, viewer: Id<"users">, args: { days?: number; workspace?: string; tz_offset_minutes?: number }): Promise<PriorityHistory> {
  const days = Math.min(MAX_HISTORY_DAYS, Math.max(1, Math.floor(args.days ?? 15)));
  const shift = (args.tz_offset_minutes ?? 0) * 60_000;
  const firstLocal = Math.floor((Date.now() - shift) / DAY) * DAY - (days - 1) * DAY;
  const dayKeys = Array.from({ length: days }, (_, i) => new Date(firstLocal + i * DAY).toISOString().slice(0, 10));
  const dayOf = (ts: number) => Math.floor((ts - shift - firstLocal) / DAY);

  const held = await heldKeysFor(ctx, viewer);
  const featureOn = featureCheck(ctx);
  const listed = sessionListed(ctx, viewer, held);
  const visible = await visiblePriorities(ctx, viewer, held, args.workspace, undefined, false);
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
    if (!shown.has(cid)) shown.set(cid, listed(conv));
    if (await shown.get(cid)) (sessions[conv.short_id ?? cid] ??= new Array(days).fill(0))[day]++;
  };

  // The viewer's own typing, at most half the budget: their priorities' lanes, and unassigned.
  const mine = await typedBy(viewer, { sends: HISTORY_SENDS_CAP / 2, convs: HISTORY_CONVERSATION_CAP / 2 });
  for (const { send, day, conv } of mine.typed) {
    if (conv.priority_id) {
      const p = own.get(String(conv.priority_id));
      if (p) await countInto(p, null, conv, day);
      continue;
    }
    const key = send.team_id ? `team:${send.team_id}` : `user:${viewer}`;
    if (args.workspace && key !== args.workspace) continue;
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
      if (!p || ws?.type !== "team" || String(teamVisibleConvTeam(conv)) !== String(ws.teamId)) continue;
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
  const p = await readable(ctx, viewer, shortId);
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
    .collect();
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
    .collect();
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
    return listFor(ctx, viewer, args);
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

/** The line under a mapped session's pinned state: one conversation read, one priority read, the access checks, and the owner's active priorities for its position. */
export const pinLine = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }): Promise<PriorityPinLine | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    const conv = await ctx.db.get(conversation_id);
    if (!conv?.priority_id) return null;
    const p = await ctx.db.get(conv.priority_id);
    if (!p || p.status === "merged") return null;
    if (!(await canAccessConversation(ctx, viewer, conv)) || !(await priorityJudge(ctx, viewer, await heldKeysFor(ctx, viewer))(p)) || !(await featureCheck(ctx)(p.workspace))) return null;
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
    return { priorities: await listFor(ctx, viewer, { workspace: cliWorkspace(viewer, args), status: args.status, all: args.all }) };
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
