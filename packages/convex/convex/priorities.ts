// Priorities (shared/contracts/priorities.ts): the reads behind /priorities,
// the pin line and `cast priorities`, and the person's own controls over them.
//
// Access follows the workspace's sharing settings (lib/priorityAccess.ts): a
// priority is readable by its owner, and by a teammate holding its `workspace`
// key only while the owner lists their sessions to that team; nothing is
// readable, writable or run while the `priorities` feature is off there. Only the owner
// changes a priority, and every change marks its field set by the person, so
// the pass (lib/priorityPass.ts, priorityPassRun applyPlan) never overrides it:
// a placed rank; a milestone's tier, done state, title and drop (steps are milestones);
// set aside, done and merge; a session's move and "not this". Corrections are
// the person's words to the pass, read by every later pass until deleted.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import { verifyApiToken } from "./apiTokens";
import { accessStampFor, accessStampFromDoc, authorizedFor, heldKeysFor, parseWorkspaceKey } from "./lib/accessKeys";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import { lastPriorityKey, placePriority, priorityPositions, rankSourceOf } from "@codecast/shared/contracts/priorities";
import { FEATURE, TEAMMATE_SESSIONS, featureCheck, readerFor, type Reader } from "./lib/priorityAccess";
import { hasOkRun, moveCorrections, runBlocker, sessionMover, SESSION_COUNT_CAP } from "./priorityPassRun";
import { backfillGroup, legacy } from "./priorityRankBackfill";
import { activeGroup } from "./lib/priorityGroup";
import { inWorkspace } from "./priorityPassInputs";
import { passTiming } from "./priorityPassSweep";
import { passActivity } from "./lib/priorityPassSchedule";
import { getOwnerMembership } from "./privacy";
import { isSessionOwner } from "./sessionOwners";
import { sessionVisibility } from "./lib/prioritySessionVisibility";
import { TEAM_VISIBILITY_RANK, effectiveMembershipVisibility } from "./teamVisibility";
import { rowPinPredatesTurn } from "@codecast/shared/contracts/inboxPlacement";
import { attributePlans, isWorkflowSession, orderSessions, type PlanFacts } from "@codecast/shared/contracts/priorityDerive";
import type {
  PriorityCorrection, PriorityDetail, PriorityHistory, PriorityHistoryLane, PriorityLinkedSession, PriorityLinkWhy, PriorityList, PriorityLooseSession, PriorityMilestoneLinks,
  PriorityPinLine, PriorityPlanRef, PriorityRow, PrioritySession, PrioritySessionState, PriorityStatus, PriorityStep,
} from "@codecast/shared/contracts/priorities";
import type { Doc, Id } from "./_generated/dataModel";
import { planFactsOf } from "./lib/priorityLinks";

const DAY = 86_400_000;
/** Sessions a list shows per priority, and how many of the owner's mapped sessions it reads to count them before the pass stored a count ("50+" past that). */
const LIST_SESSIONS = 3;
const LIST_COUNT_CAP = 50;
/** The most teammates' priorities one list judges, the most recently active first (more with `all` or a status); past that it says `teammates_truncated`. */
export const TEAMMATE_PRIORITIES_CAP = 60;
export const TEAMMATE_ALL_CAP = 200;
/** The most of one person's priorities of one status in one workspace any read takes (the active ones a rank orders, a list's own). */
const OWN_PRIORITIES_READ = 200;
/** The most of the viewer's own priorities a list reads in one workspace, newest first, before splitting them by status. */
const OWN_SCAN_READ = 1_000;
/** The most mapped sessions `show` reads. */
const SHOW_SESSIONS = 200;
/** A list's links: the newest mapped sessions it reads per priority, a task's newest sessions, and how many a step shows. */
const LINK_MAPPED_READ = 10;
const LINK_TASK_SESSIONS = 2;
const LINK_STEP_SESSIONS = 6;
/** A linked session's last activity, to the 10 minutes: a heartbeat or a streamed message re-runs the list but leaves its answer as it was. */
const LINK_ACTIVE_ROUND_MS = 10 * 60_000;
/** The most of today's unassigned sessions a history names. */
const LOOSE_SESSIONS = 30;
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
 * workspace (shared/contracts/priorities effectivePriorityOrder). `rows` must
 * hold every active priority of each owner and workspace it covers.
 */
const positionsOf = (rows: Priority[]): Map<string, number> => priorityPositions(rows, (r) => String(r._id));

/** One priority's position, read from its owner's active priorities in its workspace (lib/priorityGroup, the group every rank read orders). */
async function positionOf(ctx: Ctx, p: Priority): Promise<number | null> {
  if (p.status !== "active") return null;
  return positionsOf(await activeGroup(ctx, p.user_id, p.workspace)).get(String(p._id)) ?? null;
}

function criticalCounts(p: Priority): { critical_done: number; critical_total: number } {
  const critical = p.steps.filter((s) => s.tier === "critical" && !s.dropped);
  return { critical_done: critical.filter((s) => s.done).length, critical_total: critical.length };
}

/** Mapped sessions, newest started first (by_priority); null where one is not listed to the viewer. */
type Mapped = Array<PrioritySession | null>;

async function mappedSessions(r: Reader, p: Priority, read: number): Promise<Mapped> {
  const out: Mapped = [];
  for (const c of await r.sessionsOf(p, read)) {
    out.push((await r.listed(c)) ? {
      short_id: c.short_id ?? String(c._id), title: c.title ?? "", step_key: c.priority_step_key ?? null, updated_at: c.updated_at,
      ...(c.priority_set_by === "person" ? { set_by_person: true } : {}),
    } : null);
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

/** The owner's corrections on a priority, newest first (none for anyone else). */
const CORRECTIONS_READ = 50;
async function correctionsOf(ctx: Ctx, viewer: Id<"users">, p: Priority, limit = CORRECTIONS_READ): Promise<Doc<"priority_corrections">[]> {
  if (!isOwner(viewer, p)) return [];
  return await ctx.db.query("priority_corrections").withIndex("by_priority_created", (q: any) => q.eq("priority_id", p._id)).order("desc").filter((q: any) => q.eq(q.field("deleted_at"), undefined)).take(limit);
}

const correctionOut = (c: Doc<"priority_corrections">): PriorityCorrection => ({ _id: c._id, step_key: c.step_key ?? null, text: c.text, status: c.status, created_at: c.created_at });

/** Whether the owner has a correction on it no pass has read: one indexed read. */
async function correctionPending(ctx: Ctx, viewer: Id<"users">, p: Priority): Promise<boolean> {
  if (!isOwner(viewer, p)) return false;
  return !!(await ctx.db.query("priority_corrections").withIndex("by_priority_status", (q: any) => q.eq("priority_id", p._id).eq("status", "pending")).filter((q: any) => q.eq(q.field("deleted_at"), undefined)).first());
}

/**
 * `position` is where it shows among the owner's active priorities (null when
 * not active); `steps` are the ones the viewer may see (Reader.stepsFor); the
 * row lists at most `limit` sessions. The critical-path counts are the
 * priority's own, over every step.
 */
function rowFor(viewer: Id<"users">, p: Priority, owner: string, position: number | null, steps: PriorityStep[], mapped: Mapped, pending: boolean, limit = Infinity): PriorityRow {
  const { count, more } = sessionCount(viewer, p, mapped);
  return {
    _id: p._id,
    short_id: p.short_id,
    title: p.title,
    summary: p.summary,
    status: p.status,
    rank: position,
    person_pos: p.person_pos ?? null,
    ai_rank: p.ai_rank ?? null,
    rank_source: rankSourceOf(p),
    status_set_by: p.status_set_by ?? "pass",
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
    correction_pending: pending,
  };
}

/**
 * A session's state read off its conversation alone, conservatively: a client
 * holding its inbox row lays the inbox's live verdict over this. Without
 * liveness nothing can say "working", and a settled row with no verdict is
 * idle here, never "needs you" (only an explicit ask or failure is).
 */
export function linkedSessionState(c: Doc<"conversations">, now: number): PrioritySessionState {
  if (c.inbox_killed_at || c.inbox_dismissed_at) return "killed";
  const pin = rowPinPredatesTurn(c as any) ? undefined : c.thread_state_status;
  if (pin === "blocked" || c.pending_api_error || c.session_error) return "needs_you";
  if (pin === "dormant" || (c.inbox_snoozed_until ?? 0) > now || c.parked_wake_kind || c.armed_trigger_kind) return "dormant";
  if (pin === "done" || c.settle_verdict === "done") return "done";
  return "idle";
}

/** A plan as links read it: its facts, and the session it is bound to now. */
type LinkPlan = PlanFacts & { current: string | null };

type LinkReads = {
  conv: (id: string) => Promise<Doc<"conversations"> | null>;
  task: (shortId: string) => Promise<Doc<"tasks"> | null>;
  plan: (id: string) => Promise<LinkPlan | null>;
  listed: (c: Doc<"conversations">) => Promise<boolean>;
  /** The viewer's own session (theirs, or one they co-own): only these can ask the viewer anything. */
  mine: (c: Doc<"conversations">) => Promise<boolean>;
  /** The milestone keys of a priority's pending corrections ("" for one on the priority itself). */
  pending: (p: Priority) => Promise<Set<string>>;
};

/** The reads links make, each once per list call. A plan answers only when the viewer may read it. */
function linkReads(ctx: Ctx, r: Reader): LinkReads {
  const memo = <T>(fn: (k: string) => Promise<T>) => {
    const seen = new Map<string, Promise<T>>();
    return (k: string) => {
      if (!seen.has(k)) seen.set(k, fn(k));
      return seen.get(k)!;
    };
  };
  const listed = memo((id) => convs(id).then((c) => (c ? r.listed(c) : false)));
  const mine = memo(async (id) => {
    const c = await convs(id);
    if (!c) return false;
    const viewer = String(r.viewer);
    return String(c.user_id) === viewer || String(c.owner_user_id ?? "") === viewer || isSessionOwner(ctx, c._id, r.viewer);
  });
  const convs = memo(async (ref): Promise<Doc<"conversations"> | null> => {
    const id = ctx.db.normalizeId("conversations", ref);
    return id ? await ctx.db.get(id) : await ctx.db.query("conversations").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
  });
  return {
    conv: convs,
    task: memo((shortId) => ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first()),
    plan: memo(async (id): Promise<LinkPlan | null> => {
      const plan: Doc<"plans"> | null = await ctx.db.get(id as Id<"plans">);
      if (!plan || !authorizedFor(await accessStampFor(ctx, "plans", plan), String(r.viewer), r.held)) return null;
      return { ...planFactsOf(plan), current: plan.current_session_id ? String(plan.current_session_id) : null };
    }),
    listed: (c) => listed(String(c._id)),
    mine: (c) => mine(String(c._id)),
    // Corrections are their owner's alone: no one else learns one is waiting.
    pending: async (p) => {
      if (!isOwner(r.viewer, p)) return new Set();
      const rows = await ctx.db.query("priority_corrections").withIndex("by_priority_status", (q: any) => q.eq("priority_id", p._id).eq("status", "pending")).filter((q: any) => q.eq(q.field("deleted_at"), undefined)).take(50);
      return new Set(rows.map((c: any) => c.step_key ?? ""));
    },
  };
}

const planRef = ({ short_id, title, done, total, size }: PlanFacts): PriorityPlanRef => ({ short_id, title, done, total, size });

/**
 * Each step's links as a list row carries them, and the priority's plan: the
 * sessions working it (the pass mapped it among the newest LINK_MAPPED_READ, a
 * step ref names it, it is one of the newest LINK_TASK_SESSIONS of a task of
 * the step, or it is the step's own plan's current session), each listed to
 * the viewer, best first; the plans its tasks belong to, by the attribution
 * rules (priorityDerive); whether every task it names is done ("Looks
 * done?"); and whether a correction on it waits for a pass. Only for the
 * viewer's own active priorities (listFor). A session that is not the
 * viewer's never asks them anything: its needs-you reads idle.
 */
async function linksFor(r: Reader, reads: LinkReads, p: Priority, steps: PriorityStep[], now: number): Promise<{ links: PriorityMilestoneLinks[]; plan: PriorityPlanRef | null }> {
  const bySteps = new Map<string, Map<string, { c: Doc<"conversations">; why: PriorityLinkWhy[] }>>(steps.map((s) => [s.key, new Map()]));
  const add = async (key: string, c: Doc<"conversations"> | null, why: PriorityLinkWhy) => {
    const into = bySteps.get(key);
    if (!c || !into || !(await reads.listed(c))) return;
    const id = String(c._id);
    const had = into.get(id);
    if (!had) into.set(id, { c, why: [why] });
    else if (!had.why.includes(why)) had.why.push(why);
  };
  // The row's own read covers this window (listRead), so it slices that read rather than reading more.
  for (const c of (await r.sessionsOf(p, Math.max(LINK_MAPPED_READ, listRead(r.viewer, p)))).slice(0, LINK_MAPPED_READ)) if (c.priority_step_key) await add(c.priority_step_key, c, "mapped");
  const taskPlans = new Map<string, Array<string | null>>();
  const tasksDone = new Map<string, boolean>();
  for (const s of steps) {
    const plans: Array<string | null> = [];
    let allDone = true;
    for (const ref of s.refs) {
      if (ref.kind === "session") await add(s.key, await reads.conv(ref.id), "linked");
      if (ref.kind !== "task") continue;
      const task = await reads.task(ref.id);
      allDone &&= task?.status === "done";
      plans.push(task?.plan_id ? String(task.plan_id) : null);
      for (const cid of (task?.conversation_ids ?? []).slice(-LINK_TASK_SESSIONS)) await add(s.key, await reads.conv(String(cid)), `via ${ref.id}`);
    }
    taskPlans.set(s.key, plans);
    tasksDone.set(s.key, plans.length > 0 && allDone);
  }
  const pending = await reads.pending(p);
  const facts = new Map<string, LinkPlan>();
  for (const id of new Set([...taskPlans.values()].flat())) {
    const f = id ? await reads.plan(id) : null;
    if (f) facts.set(id!, f);
  }
  const attribution = attributePlans(steps.map((s) => ({ key: s.key, taskPlans: (taskPlans.get(s.key) ?? []).map((id) => (id && facts.has(id) ? id : null)) })), (id) => facts.get(id));
  const current = (f: PlanFacts | null | undefined) => (f ? facts.get(f.id)?.current ?? null : null);
  const links: PriorityMilestoneLinks[] = [];
  for (const s of steps) {
    const own = attribution.steps.get(s.key);
    const bound = current(own?.plan);
    if (bound) await add(s.key, await reads.conv(bound), "via plan");
    const sessions: PriorityLinkedSession[] = [];
    for (const { c, why } of bySteps.get(s.key)!.values()) {
      const mine = await reads.mine(c);
      const state = linkedSessionState(c, now);
      sessions.push({
        short_id: c.short_id ?? String(c._id),
        conversation_id: String(c._id),
        title: c.title ?? "",
        state: state === "needs_you" && !mine ? "idle" : state,
        mine,
        workflow: isWorkflowSession(c as any),
        why,
        last_active_at: Math.floor(c.updated_at / LINK_ACTIVE_ROUND_MS) * LINK_ACTIVE_ROUND_MS,
      });
    }
    const ordered = orderSessions(sessions);
    links.push({
      key: s.key,
      sessions: ordered.slice(0, LINK_STEP_SESSIONS),
      sessions_more: Math.max(0, ordered.length - LINK_STEP_SESSIONS),
      plan: own?.plan ? planRef(own.plan) : null,
      part_of: (own?.part_of ?? []).map(planRef),
      looks_done: !s.done && !!tasksDone.get(s.key),
      correction_pending: pending.has(s.key),
    });
  }
  return { links, plan: attribution.priority ? planRef(attribution.priority) : null };
}

/** One priority's row as a write echoes it. */
async function echo(ctx: Ctx, viewer: Id<"users">, id: Id<"priorities">): Promise<PriorityRow> {
  const p: Priority = await ctx.db.get(id);
  const names = await ownerNames(ctx, [p]);
  const r = await readerFor(ctx, viewer);
  const mapped = await mappedSessions(r, p, listRead(viewer, p));
  return rowFor(viewer, p, names.get(String(p.user_id)) ?? "", await positionOf(ctx, p), await r.stepsFor(p), mapped, await correctionPending(ctx, viewer, p), LIST_SESSIONS);
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
async function listFor(ctx: Ctx, viewer: Id<"users">, args: { workspace?: string; status?: PriorityStatus; all?: boolean }): Promise<PriorityList> {
  const r = await readerFor(ctx, viewer);
  const { rows, own_truncated, teammates_truncated } = await visiblePriorities(ctx, r, args.workspace, args.status, !!args.all);
  const names = await ownerNames(ctx, rows);
  // The viewer's own positions come from the whole group, as positionOf, the pin line and a move read them; a teammate's from what was read.
  const positions = positionsOf(rows);
  for (const key of new Set(rows.filter((p) => isOwner(viewer, p) && p.status === "active").map((p) => p.workspace))) {
    for (const [id, at] of positionsOf(await activeGroup(ctx, viewer, key))) positions.set(id, at);
  }
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
  const reads = linkReads(ctx, r);
  const now = Date.now();
  for (const p of rows) {
    const steps = await r.stepsFor(p);
    // Links only on the viewer's own active priorities: the rows a next action is drawn on.
    const linked = isOwner(viewer, p) && p.status === "active" ? await linksFor(r, reads, p, steps, now) : null;
    const row = rowFor(viewer, p, names.get(String(p.user_id)) ?? "", positions.get(String(p._id)) ?? null, steps, await mappedSessions(r, p, listRead(viewer, p)), await correctionPending(ctx, viewer, p), LIST_SESSIONS);
    out.push(linked ? { ...row, ...linked } : row);
  }
  return { priorities: out, own_truncated, teammates_truncated, ...(args.workspace ? await passTiming(ctx, viewer, args.workspace, Date.now()) : { behind_by_ms: null, next_pass_at: null }) };
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
  const corrections = await correctionsOf(ctx, viewer, p);
  const row = rowFor(viewer, p, names.get(String(p.user_id)) ?? "", await positionOf(ctx, p), steps, mapped, corrections.some((c) => c.status === "pending"));
  const sessions = row.sessions;
  // The page and the reference card draw each step's sessions and plans as the list does, for any priority the viewer can read.
  const linked = await linksFor(r, linkReads(ctx, r), p, steps, Date.now());
  return {
    ...row,
    ...linked,
    steps: steps.map((s) => ({ ...s, sessions: sessions.filter((c) => c.step_key === s.key) })),
    other_sessions: sessions.filter((c) => !steps.some((s) => s.key === c.step_key)),
    corrections: corrections.map(correctionOut),
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
  /** Today's unassigned sessions, by conversation; typed newest first, so the first send seen is the session's last. */
  const loose = new Map<string, PriorityLooseSession>();
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
    if (day !== days - 1) continue;
    const cid = String(conv._id);
    const had = loose.get(cid);
    if (had) had.count++;
    else loose.set(cid, { short_id: conv.short_id ?? cid, conversation_id: cid, title: conv.title ?? "", last_active_at: send.timestamp, count: 1 });
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
    unassigned_today: [...loose.values()].sort((a, b) => b.last_active_at - a.last_active_at).slice(0, LOOSE_SESSIONS),
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

/** Where the person moves a priority: a position (1 = first), or one up or down from where it shows. */
type MoveTo = number | "up" | "down";

/**
 * The person places one of their active priorities at a position among their
 * active ones in its workspace (shared/contracts/priorities placePriority):
 * its person_pos goes between its new neighbours', so every other priority
 * keeps its place, and the pass never moves it after.
 */
async function doMove(ctx: Ctx, viewer: Id<"users">, shortId: string, to: MoveTo): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  if (p.status !== "active") return { error: `${p.short_id} is ${p.status.replace("_", " ")}; only active priorities are ranked (restore it first)` };
  if (typeof to === "number" && (!Number.isInteger(to) || to < 1)) return { error: "a rank is a whole number from 1" };
  // Every status, so a renumber keeps a quiet or done priority's place for when it comes back.
  // The active group every rank read orders (lib/priorityGroup), and the others that hold a place.
  const read = async (): Promise<Priority[]> => {
    const others: Priority[] = (await ctx.db
      .query("priorities")
      .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", viewer).eq("workspace", p.workspace))
      .order("desc")
      .take(OWN_SCAN_READ)).filter((r: Priority) => r.status !== "merged" && r.status !== "active");
    return [...(await activeGroup(ctx, viewer, p.workspace)), ...others];
  };
  let rows = await read();
  // A group the rank backfill has not reached yet is rewritten as it would rewrite it, so the move starts from the order the person set.
  if (rows.some((r) => r.status === "active" && legacy(r))) {
    await backfillGroup(ctx, rows.filter((r) => r.status === "active"));
    rows = await read();
  }
  const row = rows.find((r) => String(r._id) === String(p._id))!;
  const at = positionsOf(rows).get(String(p._id))!;
  const now = Date.now();
  for (const w of placePriority(rows, row, to === "up" ? at - 1 : to === "down" ? at + 1 : to)) {
    // The absolute rank relative rank replaced goes with the rewrite (priorityRankBackfill).
    await ctx.db.patch(w.row._id, { ...(w.person_pos !== undefined ? { person_pos: w.person_pos } : { ai_rank: w.ai_rank }), rank: undefined, rank_set_by: undefined, updated_at: now });
  }
  return echo(ctx, viewer, p._id);
}

/** A milestone the person changes: its tier, its done state, its title, or a drop. */
type MilestoneChange = { tier: "critical" | "polish" } | { done: boolean } | { title: string } | { drop: true };
const MAX_TITLE = 200;

/** A live (not dropped) milestone of `p` by key, or the plain reason there is none. */
function milestoneOf(p: Priority, stepKey: string): Result<PriorityStep> {
  const key = stepKey.trim().toLowerCase();
  const live = p.steps.filter((s) => !s.dropped);
  return live.find((s) => s.key === key) ?? { error: `${p.short_id} has no milestone ${stepKey}; its milestones: ${live.map((s) => s.key).join(", ") || "none"}` };
}

async function doMilestone(ctx: Ctx, viewer: Id<"users">, shortId: string, stepKey: string, change: MilestoneChange): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  const step = milestoneOf(p, stepKey);
  if ("error" in step) return step;
  const now = Date.now();
  let next: PriorityStep;
  if ("tier" in change) next = { ...step, tier: change.tier, tier_set_by: "person" };
  else if ("drop" in change) next = { ...step, dropped: true };
  else if ("title" in change) {
    const title = change.title.trim();
    if (!title || title.length > MAX_TITLE) return { error: `a milestone title is 1 to ${MAX_TITLE} characters` };
    next = { ...step, title, title_set_by: "person" };
  } else if (change.done) next = { ...step, done: true, done_at: step.done ? step.done_at ?? now : now, done_set_by: "person" };
  else {
    const { done_at: _, ...rest } = step;
    next = { ...rest, done: false, done_set_by: "person" };
  }
  await ctx.db.patch(p._id, { steps: p.steps.map((s) => (s.key === step.key ? next : s)), updated_at: now });
  // A drop takes the milestone off the sessions on it; they keep the priority.
  if ("drop" in change) {
    for (const conv of await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)).take(SESSION_COUNT_CAP)) {
      if (conv.priority_step_key === step.key) await ctx.db.patch(conv._id, { priority_step_key: undefined });
    }
  }
  return echo(ctx, viewer, p._id);
}

/** Leaving the ranking ends both places, the person's and the pass's. */
const UNRANKED = { person_pos: undefined, ai_rank: undefined };

/**
 * Set aside leaves the ranking. Restore brings a set-aside or done priority
 * back active, last, as the pass's (lastPriorityKey): undoing the person's own done hands
 * the status back to the pass; reopening one the pass marked done is the
 * person's call, which the pass then keeps.
 */
async function doSetAside(ctx: Ctx, viewer: Id<"users">, shortId: string, aside: boolean): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  const now = Date.now();
  if (aside) {
    if (p.status !== "set_aside") await ctx.db.patch(p._id, { status: "set_aside", status_set_by: undefined, ...UNRANKED, updated_at: now });
    return echo(ctx, viewer, p._id);
  }
  if (p.status !== "set_aside" && p.status !== "done") return { error: `${p.short_id} is ${p.status.replace("_", " ")}; only a set-aside or done priority is restored` };
  const status_set_by = p.status === "done" && p.status_set_by !== "person" ? ("person" as const) : undefined;
  await ctx.db.patch(p._id, { status: "active", status_set_by, done_at: undefined, person_pos: undefined, ai_rank: lastPriorityKey(await activeGroup(ctx, viewer, p.workspace)), updated_at: now });
  return echo(ctx, viewer, p._id);
}

/** The person marks a priority done: it leaves the ranking, and the pass keeps it done. */
async function doPriorityDone(ctx: Ctx, viewer: Id<"users">, shortId: string): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  if (p.status !== "done" || p.status_set_by !== "person") {
    const now = Date.now();
    await ctx.db.patch(p._id, { status: "done", status_set_by: "person", done_at: p.status === "done" ? p.done_at ?? now : now, ...UNRANKED, updated_at: now });
  }
  return echo(ctx, viewer, p._id);
}

const keyNumber = (key: string | null | undefined) => {
  const m = key ? /^s(\d+)$/.exec(key) : null;
  return m ? Number(m[1]) : 0;
};

/**
 * The person merges one priority into another of theirs in the same
 * workspace: its milestones (dropped ones too, so the pass still sees them)
 * join the survivor under new keys, its sessions and corrections follow with
 * their milestone, and it is marked merged by the person.
 */
async function doMerge(ctx: Ctx, viewer: Id<"users">, shortId: string, intoId: string): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  const into = await owned(ctx, viewer, intoId);
  if ("error" in into) return into;
  if (String(p._id) === String(into._id)) return { error: "a priority cannot be merged into itself" };
  if (p.workspace !== into.workspace) return { error: `${p.short_id} and ${into.short_id} are in different workspaces` };
  const now = Date.now();
  const sessions: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)).take(SESSION_COUNT_CAP);
  const intoSessions: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", into._id)).take(SESSION_COUNT_CAP);
  let next = Math.max(into.step_key_max ?? 0, ...into.steps.map((s) => keyNumber(s.key)), ...intoSessions.map((c) => keyNumber(c.priority_step_key)));
  const remap = new Map<string, string>();
  const carried = p.steps.map((s) => {
    const key = `s${++next}`;
    remap.set(s.key, key);
    return { ...s, key };
  });
  await ctx.db.patch(into._id, { steps: [...into.steps, ...carried], step_key_max: next, updated_at: now });
  await ctx.db.patch(p._id, { status: "merged", merged_into: into._id, status_set_by: "person", ...UNRANKED, updated_at: now });
  const { move, recount } = sessionMover(ctx);
  for (const conv of sessions) {
    const not = (conv.priority_not ?? []).some((id) => String(id) === String(into._id));
    await move(conv, not ? undefined : into._id, conv.priority_step_key ? remap.get(conv.priority_step_key) : undefined, conv.priority_set_by);
  }
  await recount(viewer);
  await moveCorrections(ctx, p._id, into._id, (key) => (key ? remap.get(key) : undefined));
  return echo(ctx, viewer, into._id);
}

/** One of the viewer's own sessions, by short id or id, or the plain reason it is not. */
async function ownSession(ctx: Ctx, viewer: Id<"users">, ref: string): Promise<Result<Doc<"conversations">>> {
  const id = ctx.db.normalizeId("conversations", ref.trim());
  const conv: Doc<"conversations"> | null = id
    ? await ctx.db.get(id)
    : await ctx.db.query("conversations").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.trim())).first();
  if (!conv || String(conv.user_id) !== String(viewer)) return { error: `no session ${ref} of yours` };
  return conv;
}

/** The person puts one of their sessions on a priority (and a milestone of it): the pass never moves it. */
async function doSessionMove(ctx: Ctx, viewer: Id<"users">, sessionRef: string, shortId: string, stepKey: string | undefined): Promise<Result<PriorityRow>> {
  const conv = await ownSession(ctx, viewer, sessionRef);
  if ("error" in conv) return conv;
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  if (!(await inWorkspace((await readerFor(ctx, viewer)).vis, conv, viewer, p.workspace))) return { error: `${sessionRef} is not in ${p.short_id}'s workspace` };
  let key: string | undefined;
  if (stepKey) {
    const step = milestoneOf(p, stepKey);
    if ("error" in step) return step;
    key = step.key;
  }
  const { move, recount } = sessionMover(ctx);
  await move(conv, p._id, key, "person");
  const not = (conv.priority_not ?? []).filter((id) => String(id) !== String(p._id));
  if (not.length !== (conv.priority_not ?? []).length) await ctx.db.patch(conv._id, { priority_not: not.length ? not : undefined });
  await recount(viewer);
  return echo(ctx, viewer, p._id);
}

/** The person says a session is not part of the priority it is on: it leaves, and the pass never maps it there again. */
async function doSessionNotThis(ctx: Ctx, viewer: Id<"users">, sessionRef: string): Promise<Result<PriorityRow>> {
  const conv = await ownSession(ctx, viewer, sessionRef);
  if ("error" in conv) return conv;
  const held: Priority | null = conv.priority_id ? await ctx.db.get(conv.priority_id) : null;
  if (!held) return { error: `${sessionRef} is not on any priority` };
  const p = await owned(ctx, viewer, held.short_id);
  if ("error" in p) return p;
  const { move, recount } = sessionMover(ctx);
  await move(conv, undefined, undefined);
  const not = conv.priority_not ?? [];
  if (!not.some((id) => String(id) === String(p._id))) await ctx.db.patch(conv._id, { priority_not: [...not, p._id] });
  await recount(viewer);
  return echo(ctx, viewer, p._id);
}

const MAX_CORRECTION = 2_000;

/**
 * The person tells the pass what it got wrong about a priority (or one of its
 * milestones); every later pass reads it until deleted, and the next one is
 * asked for now. `clientKey`: the writer's own key, so a retried write (the
 * web outbox re-drives it until acknowledged) answers with the correction it
 * already stored.
 */
async function doCorrect(ctx: Ctx & { scheduler: any }, viewer: Id<"users">, shortId: string, text: string, stepKey: string | undefined, clientKey?: string): Promise<Result<PriorityCorrection>> {
  const client_key = clientKey?.trim().slice(0, 100) || undefined;
  if (client_key) {
    const stored: Doc<"priority_corrections"> | null = await ctx.db
      .query("priority_corrections")
      .withIndex("by_user_client_key", (q: any) => q.eq("user_id", viewer).eq("client_key", client_key))
      .first();
    if (stored) return correctionOut(stored);
  }
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  const body = text.trim();
  if (!body || body.length > MAX_CORRECTION) return { error: `a correction is 1 to ${MAX_CORRECTION} characters` };
  let step_key: string | undefined;
  if (stepKey) {
    const step = milestoneOf(p, stepKey);
    if ("error" in step) return step;
    step_key = step.key;
  }
  const row = {
    user_id: viewer, workspace: p.workspace, priority_id: p._id, ...(step_key ? { step_key } : {}), text: body, status: "pending" as const, created_at: Date.now(),
    // Frozen as the person saw it: with the text, the eval case (exportCases).
    snapshot: { short_id: p.short_id, title: p.title, summary: p.summary, status: p.status, steps: p.steps },
    ...(client_key ? { client_key } : {}),
  };
  const id = await ctx.db.insert("priority_corrections", row);
  await passActivity(ctx, viewer, p.workspace);
  return correctionOut({ _id: id, _creationTime: 0, ...row });
}

/** A web correction's id before the server acknowledged it: the writer's own client key behind this prefix (web prioritiesSlice correctPriority). */
const LOCAL_CORRECTION = "local-correction-";

/**
 * Deletes one of the viewer's corrections, by id or, for one the web painted
 * before the server acknowledged it, by `local-correction-<clientKey>`: the
 * outbox sends the create first, so the delete finds it and wins.
 */
async function doCorrectionDelete(ctx: Ctx, viewer: Id<"users">, ref: string): Promise<Result<{ deleted: string }>> {
  const r = ref.trim();
  const id = ctx.db.normalizeId("priority_corrections", r);
  const clientKey = r.startsWith(LOCAL_CORRECTION) ? r.slice(LOCAL_CORRECTION.length).slice(0, 100) : null;
  const c: Doc<"priority_corrections"> | null = id
    ? await ctx.db.get(id)
    : clientKey
      ? await ctx.db.query("priority_corrections").withIndex("by_user_client_key", (q: any) => q.eq("user_id", viewer).eq("client_key", clientKey)).first()
      : null;
  if (!c || String(c.user_id) !== String(viewer)) return { error: `no correction ${ref} of yours` };
  // Kept, marked: a correction a pass applied stays an eval case (exportCases).
  if (!c.deleted_at) await ctx.db.patch(c._id, { deleted_at: Date.now() });
  return { deleted: c._id };
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
  handler: async (ctx, args): Promise<PriorityList | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
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

/**
 * The line under a mapped session's pinned state: for the priority's owner,
 * and for a teammate holding its workspace key when this open session is
 * listed to that team and the priority needs no rewrite (summary level is
 * enough: the line names the priority, not the transcript). No scan of the
 * priority's other sessions: one conversation read, one priority read, the
 * owner's membership, and the owner's active priorities for its position.
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
      if (p.needs_rewrite || ws?.type !== "team" || !authorizedFor(accessStampFromDoc("priorities", p), String(viewer), await heldKeysFor(ctx, viewer))) return null;
      if (!(await sessionVisibility(ctx).listedTo(conv, ws.teamId))) return null;
    }
    if (!(await featureCheck(ctx)(p.workspace))) return null;
    const step = p.steps.find((s) => s.key === conv.priority_step_key && !s.dropped);
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

export const moveTo = mutation({
  args: { short_id: v.string(), to: v.number() },
  handler: async (ctx, args) => orThrow(await doMove(ctx, await authed(ctx), args.short_id, args.to)),
});

export const moveUp = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doMove(ctx, await authed(ctx), args.short_id, "up")),
});

export const moveDown = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doMove(ctx, await authed(ctx), args.short_id, "down")),
});

export const setStepTier = mutation({
  args: { short_id: v.string(), step_key: v.string(), tier: tierArg },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { tier: args.tier })),
});

export const setStepDone = mutation({
  args: { short_id: v.string(), step_key: v.string(), done: v.boolean() },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { done: args.done })),
});

export const renameStep = mutation({
  args: { short_id: v.string(), step_key: v.string(), title: v.string() },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { title: args.title })),
});

export const dropStep = mutation({
  args: { short_id: v.string(), step_key: v.string() },
  handler: async (ctx, args) => orThrow(await doMilestone(ctx, await authed(ctx), args.short_id, args.step_key, { drop: true })),
});

export const markDone = mutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => orThrow(await doPriorityDone(ctx, await authed(ctx), args.short_id)),
});

export const merge = mutation({
  args: { short_id: v.string(), into: v.string() },
  handler: async (ctx, args) => orThrow(await doMerge(ctx, await authed(ctx), args.short_id, args.into)),
});

export const moveSession = mutation({
  args: { session: v.string(), short_id: v.string(), step_key: v.optional(v.string()) },
  handler: async (ctx, args) => orThrow(await doSessionMove(ctx, await authed(ctx), args.session, args.short_id, args.step_key)),
});

export const sessionNotThis = mutation({
  args: { session: v.string() },
  handler: async (ctx, args) => orThrow(await doSessionNotThis(ctx, await authed(ctx), args.session)),
});

export const correct = mutation({
  args: { short_id: v.string(), text: v.string(), step_key: v.optional(v.string()), client_key: v.optional(v.string()) },
  handler: async (ctx, args) => orThrow(await doCorrect(ctx, await authed(ctx), args.short_id, args.text, args.step_key, args.client_key)),
});

export const deleteCorrection = mutation({
  args: { correction_id: v.string() },
  handler: async (ctx, args) => orThrow(await doCorrectionDelete(ctx, await authed(ctx), args.correction_id)),
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

/** `cast priorities rank <id> <n>`: move to position n. */
export const cliMove = mutation({
  args: { api_token: v.string(), short_id: v.string(), to: v.number() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doMove(ctx, viewer, args.short_id, args.to);
  },
});

export const cliSetStepTier = mutation({
  args: { api_token: v.string(), short_id: v.string(), step_key: v.string(), tier: tierArg },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doMilestone(ctx, viewer, args.short_id, args.step_key, { tier: args.tier });
  },
});

/** `cast priorities milestone done|undone|rename|drop`: one change to one milestone. */
export const cliMilestone = mutation({
  args: { api_token: v.string(), short_id: v.string(), step_key: v.string(), done: v.optional(v.boolean()), title: v.optional(v.string()), drop: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    const changes = [args.done !== undefined, args.title !== undefined, !!args.drop].filter(Boolean).length;
    if (changes !== 1) return { error: "name exactly one change: done, title or drop" };
    const change: MilestoneChange = args.done !== undefined ? { done: args.done } : args.title !== undefined ? { title: args.title } : { drop: true };
    return doMilestone(ctx, viewer, args.short_id, args.step_key, change);
  },
});

export const cliDone = mutation({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doPriorityDone(ctx, viewer, args.short_id);
  },
});

export const cliMerge = mutation({
  args: { api_token: v.string(), short_id: v.string(), into: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doMerge(ctx, viewer, args.short_id, args.into);
  },
});

export const cliMoveSession = mutation({
  args: { api_token: v.string(), session: v.string(), short_id: v.string(), step_key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doSessionMove(ctx, viewer, args.session, args.short_id, args.step_key);
  },
});

export const cliSessionNotThis = mutation({
  args: { api_token: v.string(), session: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doSessionNotThis(ctx, viewer, args.session);
  },
});

export const cliCorrect = mutation({
  args: { api_token: v.string(), short_id: v.string(), text: v.string(), step_key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doCorrect(ctx, viewer, args.short_id, args.text, args.step_key);
  },
});

export const cliDeleteCorrection = mutation({
  args: { api_token: v.string(), correction_id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return doCorrectionDelete(ctx, viewer, args.correction_id);
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
 * what was scheduled and the plain reason runNow would refuse any other.
 */
async function runFor(ctx: any, viewer: Id<"users">, named: string | undefined): Promise<Result<{ scheduled: string[]; skipped: Array<{ workspace: string; reason: string }>; note: string }>> {
  const held = await heldKeysFor(ctx, viewer);
  if (named && !held.has(named)) return { error: "you are not a member of that team" };
  const featureOn = featureCheck(ctx);
  const now = Date.now();
  const scheduled: string[] = [];
  const skipped: Array<{ workspace: string; reason: string }> = [];
  let first = false;
  for (const workspace of named ? [named] : held) {
    if (!(await featureOn(workspace))) continue;
    // runNow's own checks, read-only: reserve decides for real when the pass starts.
    const catchUp = !(await hasOkRun(ctx, viewer, workspace));
    const blocked = await runBlocker(ctx, viewer, workspace, now, true, catchUp);
    if (blocked && "kind" in blocked) { skipped.push({ workspace, reason: blocked.reason }); continue; }
    first ||= catchUp;
    await ctx.scheduler.runAfter(0, (internal as any).priorityPassRun.runNow, { user_id: viewer, workspace });
    scheduled.push(workspace);
  }
  if (!scheduled.length) return { error: skipped.length ? skipped.map((s) => s.reason).join(" ") : teamFeatureOffMessage(FEATURE) };
  const note = first
    ? "A pass is running; results land in a few minutes. This first catch-up reads your last two weeks, oldest work first, over a few runs."
    : "A pass is running; results land in a few minutes.";
  return { scheduled, skipped, note };
}

/** `cast priorities run`. */
export const cliRun = mutation({
  args: { api_token: v.string(), ...cliScope },
  handler: async (ctx, args) => {
    const viewer = await tokenUser(ctx, args.api_token);
    if (!viewer) return { error: "Unauthorized" };
    return runFor(ctx, viewer, cliWorkspace(viewer, args));
  },
});

/** The web's Run now (dispatch runPriorities): one pass in a workspace, refused with the same plain reasons. */
export const run = mutation({
  args: { workspace: v.string() },
  handler: async (ctx, args) => orThrow(await runFor(ctx, await authed(ctx), args.workspace)),
});

/** The most correction cases one export returns, oldest applied first from `since`. */
const EXPORT_CASES = 200;

/**
 * Every correction a pass applied after `since` (its applied_at), oldest
 * first, as an eval case: the priority as the person saw it when they wrote
 * it (`before`, the snapshot), their words, the window the pass that applied
 * it read (`window`: replay it with priorityPassEval evalPass, window_start to
 * window.to), and the priority as it stands now (`after`). A correction no
 * pass has read yet is not a case: its after is its before. Staff read it
 * through packages/convex/run.sh; packages/evals/scripts/
 * priority-corrections-export.ts freezes each case under EVALS_HOME. Real
 * content: never written into the repo.
 */
export const exportCases = internalQuery({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows: Doc<"priority_corrections">[] = await ctx.db
      .query("priority_corrections")
      .withIndex("by_applied", (q: any) => q.gt("applied_at", args.since ?? 0))
      .take(EXPORT_CASES);
    const out = [];
    for (const c of rows) {
      const now: Priority | null = await ctx.db.get(c.priority_id);
      out.push({
        id: c._id, user_id: c.user_id, workspace: c.workspace, created_at: c.created_at, applied_at: c.applied_at!, window: c.applied_window ?? null,
        step_key: c.step_key ?? null, text: c.text, before: c.snapshot,
        after: now ? { short_id: now.short_id, title: now.title, summary: now.summary, status: now.status, steps: now.steps } : null,
      });
    }
    return { cases: out, more: rows.length === EXPORT_CASES };
  },
});
