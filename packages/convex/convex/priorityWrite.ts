// The person's own changes to their priorities, behind priorities.ts's
// mutations: each marks its field set by the person, so the pass never
// overrides it. No Convex functions here.

import { lastPriorityKey, placePriority } from "@codecast/shared/contracts/priorities";
import { readerFor } from "./lib/priorityAccess";
import { moveCorrections } from "./priorityPassRun";
import { clearDeadStepKeysNow, moveMergedSessionsNow, sessionMover } from "./priorityPassSessions";
import { backfillGroup, legacy } from "./priorityRankBackfill";
import { activeGroup, stepKeyMark } from "./lib/priorityGroup";
import { inWorkspace } from "./priorityPassInputs";
import { passActivity } from "./lib/priorityPassSchedule";
import type { PriorDone, PriorityCorrection, PriorityRow, PriorityStep } from "@codecast/shared/contracts/priorities";
import type { Doc, Id } from "./_generated/dataModel";
import { type Ctx, OWN_SCAN_READ, type Priority, type Result, correctionOut, echo, owned, positionsOf } from "./priorityRead";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";

/** Where the person moves a priority: a position (1 = first), or one up or down from where it shows. */
type MoveTo = number | "up" | "down";

/**
 * The person places one of their active priorities at a position among their
 * active ones in its workspace (shared/contracts/priorities placePriority):
 * its person_pos goes between its new neighbours', so every other priority
 * keeps its place, and the pass never moves it after.
 */
export async function doMove(ctx: Ctx, viewer: Id<"users">, shortId: string, to: MoveTo): Promise<Result<PriorityRow>> {
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

/**
 * A milestone the person changes: its tier, its done state, its title, a
 * drop, or the undo of their own done (`undoDone`: who held its done state
 * before, null for nobody).
 */
export type MilestoneChange = { tier: "critical" | "polish" } | { done: boolean } | { undoDone: PriorDone["status_set_by"] | null } | { title: string } | { drop: true };
const MAX_TITLE = 200;

/** A live (not dropped) milestone of `p` by key, or the plain reason there is none. */
function milestoneOf(p: Priority, stepKey: string): Result<PriorityStep> {
  const key = stepKey.trim().toLowerCase();
  const live = p.steps.filter((s) => !s.dropped);
  return live.find((s) => s.key === key) ?? { error: `${p.short_id} has no milestone ${stepKey}; its milestones: ${live.map((s) => s.key).join(", ") || "none"}` };
}

export async function doMilestone(ctx: Ctx & { scheduler: any }, viewer: Id<"users">, shortId: string, stepKey: string, change: MilestoneChange): Promise<Result<PriorityRow>> {
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
  } else if ("undoDone" in change) {
    if (!step.done || step.done_set_by !== "person") return { error: `${step.title} is no longer marked done by you` };
    const { done_at: _, done_set_by: __, ...rest } = step;
    next = { ...rest, done: false, ...(change.undoDone ? { done_set_by: change.undoDone } : {}) };
  } else if (change.done) next = { ...step, done: true, done_at: step.done ? step.done_at ?? now : now, done_set_by: "person" };
  else {
    const { done_at: _, ...rest } = step;
    next = { ...rest, done: false, done_set_by: "person" };
  }
  await ctx.db.patch(p._id, { steps: p.steps.map((s) => (s.key === step.key ? next : s)), updated_at: now });
  // A drop takes the milestone off the sessions on it (a page now, the rest by scheduled runs); they keep the priority.
  if ("drop" in change) await clearDeadStepKeysNow(ctx, p._id);
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
export async function doSetAside(ctx: Ctx, viewer: Id<"users">, shortId: string, aside: boolean): Promise<Result<PriorityRow>> {
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
export async function doPriorityDone(ctx: Ctx, viewer: Id<"users">, shortId: string): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  if (p.status !== "done" || p.status_set_by !== "person") {
    const now = Date.now();
    await ctx.db.patch(p._id, { status: "done", status_set_by: "person", done_at: p.status === "done" ? p.done_at ?? now : now, ...UNRANKED, updated_at: now });
  }
  return echo(ctx, viewer, p._id);
}

/**
 * The undo of the person's own done, moments after it: the priority goes back
 * to the status and place it had (`prior`, read when it was pressed), so it
 * keeps its rank, and a status the pass held is the pass's again. Refused once
 * it is no longer the person's done.
 */
export async function doUndoPriorityDone(ctx: Ctx, viewer: Id<"users">, shortId: string, prior: PriorDone): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  if (p.status !== "done" || p.status_set_by !== "person") return { error: `${p.short_id} is no longer marked done by you` };
  await ctx.db.patch(p._id, {
    status: prior.status,
    status_set_by: prior.status_set_by === "person" ? "person" : undefined,
    done_at: undefined,
    person_pos: prior.person_pos,
    ai_rank: prior.ai_rank,
    updated_at: Date.now(),
  });
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
export async function doMerge(ctx: Ctx & { scheduler: any }, viewer: Id<"users">, shortId: string, intoId: string): Promise<Result<PriorityRow>> {
  const p = await owned(ctx, viewer, shortId);
  if ("error" in p) return p;
  const into = await owned(ctx, viewer, intoId);
  if ("error" in into) return into;
  if (String(p._id) === String(into._id)) return { error: "a priority cannot be merged into itself" };
  if (p.workspace !== into.workspace) return { error: `${p.short_id} and ${into.short_id} are in different workspaces` };
  const now = Date.now();
  // New keys after every one the survivor has spent (its mark).
  let next = Math.max(await stepKeyMark(ctx, into), ...into.steps.map((s) => keyNumber(s.key)));
  const remap = new Map<string, string>();
  const carried = p.steps.map((s) => {
    const key = `s${++next}`;
    remap.set(s.key, key);
    return { ...s, key };
  });
  await ctx.db.patch(into._id, { steps: [...into.steps, ...carried], step_key_max: next, updated_at: now });
  await ctx.db.patch(p._id, { status: "merged", merged_into: into._id, status_set_by: "person", ...UNRANKED, updated_at: now });
  // Every session of it, however many: a page now, the rest by scheduled runs.
  await moveMergedSessionsNow(ctx, p._id, into._id, Object.fromEntries(remap));
  await moveCorrections(ctx, p._id, into._id, (key) => (key ? remap.get(key) : undefined));
  return echo(ctx, viewer, into._id);
}

/** One of the viewer's own sessions, by short id or id, or the plain reason it is not. */
async function ownSession(ctx: Ctx, viewer: Id<"users">, ref: string): Promise<Result<Doc<"conversations">>> {
  const conv: Doc<"conversations"> | null = await findConversationByAnyRefWhere(ctx, ref, (c) => String(c.user_id) === String(viewer));
  if (!conv) return { error: `no session ${ref} of yours` };
  return conv;
}

/** The person puts one of their sessions on a priority (and a milestone of it): the pass never moves it. */
export async function doSessionMove(ctx: Ctx, viewer: Id<"users">, sessionRef: string, shortId: string, stepKey: string | undefined): Promise<Result<PriorityRow>> {
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
export async function doSessionNotThis(ctx: Ctx, viewer: Id<"users">, sessionRef: string): Promise<Result<PriorityRow>> {
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
export async function doCorrect(ctx: Ctx & { scheduler: any }, viewer: Id<"users">, shortId: string, text: string, stepKey: string | undefined, clientKey?: string): Promise<Result<PriorityCorrection>> {
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
export async function doCorrectionDelete(ctx: Ctx, viewer: Id<"users">, ref: string): Promise<Result<{ deleted: string }>> {
  const r = ref.trim();
  const id = ctx.db.normalizeId("priority_corrections", r);
  const clientKey = r.startsWith(LOCAL_CORRECTION) ? r.slice(LOCAL_CORRECTION.length).slice(0, 100) : null;
  const c: Doc<"priority_corrections"> | null = id
    ? await ctx.db.get(id)
    : clientKey
      ? await ctx.db.query("priority_corrections").withIndex("by_user_client_key", (q: any) => q.eq("user_id", viewer).eq("client_key", clientKey)).first()
      : null;
  if (!c || String(c.user_id) !== String(viewer)) return { error: `no correction ${ref} of yours` };
  // Marked, not erased: every reader, the eval export included, skips it.
  if (!c.deleted_at) await ctx.db.patch(c._id, { deleted_at: Date.now() });
  return { deleted: c._id };
}
