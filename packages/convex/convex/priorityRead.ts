// The reads behind priorities.ts: rows, milestone links, lists and a
// priority's detail, under the access rules lib/priorityAccess.ts sets, and
// `owned`, the check every write starts from. No Convex functions here.

import { verifyApiToken } from "./apiTokens";
import { accessStampFor, authorizedFor } from "./lib/accessKeys";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import { rankSourceOf } from "@codecast/shared/contracts/priorities";
import { FEATURE, TEAMMATE_SESSIONS, featureCheck, readerFor, type Reader } from "./lib/priorityAccess";
import { activeGroup, positionOf, positionsOf } from "./lib/priorityGroup";
import { passTiming } from "./priorityPassSweep";
import { isSessionOwner } from "./sessionOwners";
import { rowPinPredatesTurn } from "@codecast/shared/contracts/inboxPlacement";
import { attributePlans, isWorkflowSession, orderSessions, type PlanFacts } from "@codecast/shared/contracts/priorityDerive";
import type { PriorityCorrection, PriorityDetail, PriorityLinkedSession, PriorityLinkWhy, PriorityList, PriorityMilestoneLinks, PriorityPlanRef, PriorityRow, PrioritySession, PrioritySessionState, PriorityStatus, PriorityStep } from "@codecast/shared/contracts/priorities";
import type { Doc, Id } from "./_generated/dataModel";
import { planFactsOf } from "./lib/priorityLinks";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";

export const DAY = 86_400_000;
/** Sessions a list shows per priority, and how many of the owner's mapped sessions it reads to count them before the pass stored a count ("50+" past that). */
const LIST_SESSIONS = 3;
const LIST_COUNT_CAP = 50;
/** The most teammates' priorities one list judges, the most recently active first (more with `all` or a status); past that it says `teammates_truncated`. */
export const TEAMMATE_PRIORITIES_CAP = 60;
export const TEAMMATE_ALL_CAP = 200;
/** The most of one person's priorities of one status in one workspace any read takes (the active ones a rank orders, a list's own). */
const OWN_PRIORITIES_READ = 200;
/** The most of the viewer's own priorities a list reads in one workspace, newest first, before splitting them by status. */
export const OWN_SCAN_READ = 1_000;
/** The most mapped sessions `show` reads. */
const SHOW_SESSIONS = 200;
/** A list's links: the newest mapped sessions it reads per priority, a task's newest sessions, and how many a step shows. */
const LINK_MAPPED_READ = 10;
const LINK_TASK_SESSIONS = 2;
const LINK_STEP_SESSIONS = 6;
/** A linked session's last activity, to the 10 minutes: a heartbeat or a streamed message re-runs the list but leaves its answer as it was. */
const LINK_ACTIVE_ROUND_MS = 10 * 60_000;
/** The most of today's unassigned sessions a history names. */
export const LOOSE_SESSIONS = 30;
export const MAX_HISTORY_DAYS = 30;
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

export type Ctx = { db: any };
export type Priority = Doc<"priorities">;
export type Result<T> = T | { error: string };

export async function tokenUser(ctx: any, api_token: string): Promise<Id<"users"> | null> {
  const result = await verifyApiToken(ctx, api_token);
  return result ? (result.userId as Id<"users">) : null;
}

/** The workspace a CLI call names: a team, the personal one, or none (every workspace). */
export function cliWorkspace(viewer: Id<"users">, args: { team_id?: Id<"teams">; personal?: boolean }): string | undefined {
  if (args.team_id) return `team:${args.team_id}`;
  if (args.personal) return `user:${viewer}`;
  return undefined;
}

export const STATUS_ORDER: Record<PriorityStatus, number> = { active: 0, done: 1, quiet: 2, set_aside: 3, merged: 4 };
/** What a list shows without a status: everything but merged, read status by status so merged rows are never read. */
const LISTED_STATUSES: PriorityStatus[] = ["active", "done", "quiet", "set_aside"];

export function criticalCounts(p: Priority): { critical_done: number; critical_total: number } {
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

export const isOwner = (viewer: Id<"users">, p: Priority) => String(p.user_id) === String(viewer);

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

/** A priority's owner as a row names them: their name and their avatar (the photo they set, else GitHub's, as the web's memberAvatarUrl picks). */
export type Owner = { name: string; image: string | null };
const NO_OWNER: Owner = { name: "", image: null };

export async function owners(ctx: Ctx, rows: Priority[]): Promise<Map<string, Owner>> {
  const out = new Map<string, Owner>();
  for (const r of rows) {
    const id = String(r.user_id);
    if (out.has(id)) continue;
    const u: Doc<"users"> | null = await ctx.db.get(r.user_id);
    out.set(id, { name: u?.name ?? "", image: u?.image || u?.github_avatar_url || null });
  }
  return out;
}

const ownerOf = (all: Map<string, Owner>, p: Priority): Owner => all.get(String(p.user_id)) ?? NO_OWNER;

/** The owner's corrections on a priority, newest first (none for anyone else). */
const CORRECTIONS_READ = 50;
async function correctionsOf(ctx: Ctx, viewer: Id<"users">, p: Priority, limit = CORRECTIONS_READ): Promise<Doc<"priority_corrections">[]> {
  if (!isOwner(viewer, p)) return [];
  return await ctx.db.query("priority_corrections").withIndex("by_priority_created", (q: any) => q.eq("priority_id", p._id)).order("desc").filter((q: any) => q.eq(q.field("deleted_at"), undefined)).take(limit);
}

export const correctionOut = (c: Doc<"priority_corrections">): PriorityCorrection => ({ _id: c._id, step_key: c.step_key ?? null, text: c.text, status: c.status, created_at: c.created_at });

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
function rowFor(viewer: Id<"users">, p: Priority, owner: Owner, position: number | null, steps: PriorityStep[], mapped: Mapped, pending: boolean, limit = Infinity): PriorityRow {
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
    owner: owner.name,
    owner_image: owner.image,
    mine: String(p.user_id) === String(viewer),
    first_seen_at: p.first_seen_at,
    last_active_at: p.last_active_at,
    done_at: p.done_at ?? null,
    session_count: count,
    session_count_more: more,
    sessions: mapped.filter((c): c is PrioritySession => c !== null).slice(0, limit),
    correction_pending: pending,
    ...(p.from_call ? { from_call: String(p.from_call) } : {}),
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
  /** A step's session ref (a short id), as the priority owner's own conversation. */
  ownedConv: (ref: string, owner: string) => Promise<Doc<"conversations"> | null>;
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
  // A step's session ref is the priority owner's own conversation; it was stored unshared then (storedSessionId), so oldest first.
  const ownedConvs = memo((key): Promise<Doc<"conversations"> | null> => {
    const [owner, ref] = key.split(" ");
    return findConversationByAnyRefWhere(ctx, ref, (c) => String(c.user_id) === owner, (c) => c._creationTime);
  });
  return {
    conv: convs,
    ownedConv: (ref, owner) => ownedConvs(`${owner} ${ref}`),
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
      if (ref.kind === "session") await add(s.key, await reads.ownedConv(ref.id, String(p.user_id)), "linked");
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
export async function echo(ctx: Ctx, viewer: Id<"users">, id: Id<"priorities">): Promise<PriorityRow> {
  const p: Priority = await ctx.db.get(id);
  const r = await readerFor(ctx, viewer);
  const mapped = await mappedSessions(r, p, listRead(viewer, p));
  return rowFor(viewer, p, ownerOf(await owners(ctx, [p]), p), await positionOf(ctx, p), await r.stepsFor(p), mapped, await correctionPending(ctx, viewer, p), LIST_SESSIONS);
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
export async function visiblePriorities(ctx: Ctx, r: Reader, workspace: string | undefined, status: PriorityStatus | undefined, all: boolean): Promise<{ rows: Priority[]; own_truncated: boolean; teammates_truncated: boolean }> {
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
export async function listFor(ctx: Ctx, viewer: Id<"users">, args: { workspace?: string; status?: PriorityStatus; all?: boolean }): Promise<PriorityList> {
  const r = await readerFor(ctx, viewer);
  const { rows, own_truncated, teammates_truncated } = await visiblePriorities(ctx, r, args.workspace, args.status, !!args.all);
  const people = await owners(ctx, rows);
  // Every position is its owner's in their whole active group, as positionOf, the pin line and a move read it, whoever reads the list.
  const positions = new Map<string, number>();
  const groups = new Map(rows.filter((p) => p.status === "active").map((p) => [`${p.user_id} ${p.workspace}`, p] as const));
  for (const p of groups.values()) {
    for (const [id, at] of positionsOf(await activeGroup(ctx, p.user_id, p.workspace))) positions.set(id, at);
  }
  const at = (p: Priority) => positions.get(String(p._id)) ?? Infinity;
  const mine = (p: Priority) => (String(p.user_id) === String(viewer) ? 0 : 1);
  rows.sort((a, b) =>
    mine(a) - mine(b)
    || ownerOf(people, a).name.localeCompare(ownerOf(people, b).name)
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
    // Links only on the viewer's own active priorities: the rows whose milestones show a state.
    const linked = isOwner(viewer, p) && p.status === "active" ? await linksFor(r, reads, p, steps, now) : null;
    const row = rowFor(viewer, p, ownerOf(people, p), positions.get(String(p._id)) ?? null, steps, await mappedSessions(r, p, listRead(viewer, p)), await correctionPending(ctx, viewer, p), LIST_SESSIONS);
    out.push(linked ? { ...row, ...linked } : row);
  }
  return { priorities: out, own_truncated, teammates_truncated, ...(args.workspace ? await passTiming(ctx, viewer, args.workspace, Date.now()) : { behind_by_ms: null, next_pass_at: null }) };
}

async function byShortId(ctx: Ctx, shortId: string): Promise<Priority | null> {
  return await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId.trim().toLowerCase())).first();
}

/** A priority the viewer can read, or the plain reason they cannot: one that does not exist and one they cannot read get the same answer. */
export async function readable(ctx: Ctx, r: Reader, shortId: string): Promise<Result<Priority>> {
  const p = await byShortId(ctx, shortId);
  // Access first, so the feature message never tells someone a priority exists.
  if (!p || p.status === "merged" || !(await r.canRead(p))) return { error: `no priority ${shortId} you can see` };
  if (!(await featureCheck(ctx)(p.workspace))) return { error: teamFeatureOffMessage(FEATURE) };
  return p;
}

export async function showFor(ctx: Ctx, viewer: Id<"users">, shortId: string): Promise<Result<PriorityDetail>> {
  const r = await readerFor(ctx, viewer);
  const p = await readable(ctx, r, shortId);
  if ("error" in p) return p;
  const mapped = await mappedSessions(r, p, SHOW_SESSIONS);
  const steps = await r.stepsFor(p);
  const corrections = await correctionsOf(ctx, viewer, p);
  const row = rowFor(viewer, p, ownerOf(await owners(ctx, [p]), p), await positionOf(ctx, p), steps, mapped, corrections.some((c) => c.status === "pending"));
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


/** A priority the viewer owns, or the plain reason they cannot change it. */
export async function owned(ctx: Ctx, viewer: Id<"users">, shortId: string): Promise<Result<Priority>> {
  const p = await readable(ctx, await readerFor(ctx, viewer), shortId);
  if ("error" in p) return p;
  if (String(p.user_id) !== String(viewer)) {
    const name = ((await ctx.db.get(p.user_id)) as any)?.name;
    return { error: `${p.short_id} is ${name ? `${name}'s` : "someone else's"} priority; only they can change it` };
  }
  return p;
}
