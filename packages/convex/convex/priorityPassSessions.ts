// Moving and clearing a priority's sessions in bounded pages (the pass's
// merges and removed milestones, and the person's merges and drops): the
// first page in the caller's transaction, the rest by scheduled runs, and
// sessionMover, which moves sessions and counts again what they left and joined.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { sessionVisibility } from "./lib/prioritySessionVisibility";
import { replayDonePin } from "./lib/priorityLinks";
import { stepKeyMark } from "./lib/priorityGroup";
import { priorityStep } from "./prioritiesSchema";
import { repeatsDropped, stepKeyMax } from "./lib/priorityPassSteps";
import { inWorkspace } from "./priorityPassInputs";

const self = (internal as any).priorityPassSessions;
/** A priority's sessions are counted from the index up to this many; past it the stored count goes on by the moves and is flagged. */
export const SESSION_COUNT_CAP = 500;

type Step = Doc<"priorities">["steps"][number];
const lastOf = <T,>(xs: readonly T[], p: (x: T) => boolean): T | undefined => {
  for (let i = xs.length - 1; i >= 0; i--) if (p(xs[i])) return xs[i];
  return undefined;
};

/** The most sessions of one priority one transaction moves or clears; a scheduled run takes the next page, and the next, until none is left. */
export const SESSION_PAGE = 200;

/** One page of a priority's sessions created after `after`, oldest first: the cursor is the last one's _creationTime. */
const sessionPage = (ctx: { db: any }, priorityId: Id<"priorities">, after: number): Promise<Doc<"conversations">[]> =>
  ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", priorityId).gt("_creationTime", after)).take(SESSION_PAGE);

/** A session the person placed, or a known link mapped: the milestone it sits on stays (the anchor). */
const anchors = (conv: Doc<"conversations">) => !!conv.priority_step_key && (conv.priority_set_by === "person" || conv.priority_set_by === "link");

type MergePage = { next: number | null; into: Id<"priorities">; step_keys: Record<string, string> };

/** How many merges a page follows from the survivor it was given to the one that is live now. */
const MERGE_HOPS = 5;

/**
 * The priority `into` was merged into since, followed to the live one (at
 * most MERGE_HOPS hops), and `step_keys` mapped onto it: each key goes to the
 * live milestone of the same title there, as a merge carries milestones, and
 * is left out when there is none (the session keeps the priority, step unknown).
 */
async function liveSurvivor(ctx: { db: any }, into: Id<"priorities">, step_keys: Record<string, string>): Promise<{ row: Doc<"priorities"> | null; step_keys: Record<string, string> }> {
  let row: Doc<"priorities"> | null = await ctx.db.get(into);
  let keys = step_keys;
  for (let hop = 0; row?.status === "merged" && row.merged_into && hop < MERGE_HOPS; hop++) {
    const next: Doc<"priorities"> | null = await ctx.db.get(row.merged_into);
    if (!next) break;
    const from = row;
    keys = Object.fromEntries(Object.entries(keys).flatMap(([k, key]) => {
      const title = from.steps.find((st) => st.key === key && !st.dropped)?.title;
      // The newest of that title: a merge adds the milestones it carries at the end.
      const to = title ? lastOf(next.steps, (st) => !st.dropped && st.title === title) : undefined;
      return to ? [[k, to.key]] : [];
    }));
    row = next;
  }
  return { row, step_keys: keys };
}

/**
 * One page of a merge: each session still on `from` goes to `into`, onto the
 * milestone `step_keys` maps its own to when that is live there (step
 * unknown otherwise), keeping who placed it; one the person said is not
 * part of `into` lets go. A session the person placed (or a link mapped) on
 * a live milestone of `from` the map does not take to a live one brings that
 * milestone to `into` under a new key, as the first page's newest sessions
 * do (applyPlan's merges), however old the session: onto `into`'s own of that
 * title when it has one, and never where the person dropped it (the map's
 * key, or a milestone its title repeats). `scope` keeps only
 * sessions of that person in that workspace (the pass's). Returns where the
 * next page starts (or null) and the map, with what this page carried.
 */
export async function moveMergedPage(ctx: { db: any }, from: Id<"priorities">, to: Id<"priorities">, step_keys: Record<string, string>, after: number, scope?: { user_id: Id<"users">; workspace: string }): Promise<MergePage> {
  // A survivor merged away since the merge began: the pages go on to the one it went to.
  const survivor = await liveSurvivor(ctx, to, step_keys);
  const intoRow = survivor.row;
  const into = intoRow?._id ?? to;
  const keys = { ...survivor.step_keys };
  const fromRow: Doc<"priorities"> | null = await ctx.db.get(from);
  const live = new Set((intoRow?.steps ?? []).filter((st) => !st.dropped).map((st) => st.key));
  const page = await sessionPage(ctx, from, after);
  const { move, recount } = sessionMover(ctx);
  const vis = sessionVisibility(ctx);
  let steps = intoRow?.steps ?? [];
  let mark: number | null = null;
  for (const conv of page) {
    if (scope && !(await inWorkspace(vis, conv, scope.user_id, scope.workspace))) continue;
    const key = conv.priority_step_key;
    if (intoRow && key && anchors(conv) && !(keys[key] && live.has(keys[key]))) {
      const st = fromRow?.steps.find((x) => x.key === key && !x.dropped);
      // The person dropped where the map points, or a milestone it repeats: it never comes back, and the session's step is unknown.
      const dropped = st && steps.some((x) => x.dropped && (x.key === keys[key] || repeatsDropped(x.title, st.title)));
      const same = st && !dropped ? lastOf(steps, (x) => !x.dropped && x.title === st.title) : undefined;
      if (same) keys[key] = same.key;
      else if (st && !dropped) {
        mark ??= stepKeyMax(steps, await stepKeyMark(ctx, intoRow));
        keys[key] = `s${++mark}`;
        steps = [...steps, { ...st, key: keys[key] }];
        live.add(keys[key]);
      }
    }
    const not = (conv.priority_not ?? []).some((id) => String(id) === String(into));
    const to = key ? keys[key] : undefined;
    await move(conv, not ? undefined : into, to && live.has(to) ? to : undefined, conv.priority_set_by);
  }
  if (intoRow && mark !== null) await ctx.db.patch(into, { steps, step_key_max: mark, updated_at: Date.now() });
  if (intoRow) await recount(intoRow.user_id);
  return { next: page.length === SESSION_PAGE ? page[page.length - 1]._creationTime : null, into, step_keys: keys };
}

/** The milestones of `removed` a page of sessions anchors (a session the person placed, or a link mapped, sits on one), and where the next page starts. */
async function anchoredPage(ctx: { db: any }, priorityId: Id<"priorities">, after: number, removed: Step[]): Promise<{ next: number | null; anchored: string[] }> {
  const page = await sessionPage(ctx, priorityId, after);
  const anchored = page.filter((c) => anchors(c) && removed.some((st) => st.key === c.priority_step_key)).map((c) => c.priority_step_key!);
  return { next: page.length === SESSION_PAGE ? page[page.length - 1]._creationTime : null, anchored };
}

/** Puts back the removed milestones a session anchors, unless the key is on the row again (a drop is the person's) or a live milestone of that title is. */
async function restoreAnchored(ctx: { db: any }, priorityId: Id<"priorities">, removed: Step[], anchored: ReadonlyArray<string>): Promise<void> {
  const row: Doc<"priorities"> | null = await ctx.db.get(priorityId);
  if (!row) return;
  const back = removed.filter((st) => anchored.includes(st.key) && !row.steps.some((x) => x.key === st.key || (!x.dropped && x.title === st.title)));
  if (back.length) await ctx.db.patch(row._id, { steps: [...row.steps, ...back], updated_at: Date.now() });
}

/** One page of a priority's sessions on a key that is no live milestone of it now: each keeps the priority, step unknown. Returns where the next page starts, or null. */
export async function clearDeadKeysPage(ctx: { db: any }, priorityId: Id<"priorities">, after: number): Promise<number | null> {
  const row: Doc<"priorities"> | null = await ctx.db.get(priorityId);
  if (!row) return null;
  const live = new Set(row.steps.filter((st) => !st.dropped).map((st) => st.key));
  const page = await sessionPage(ctx, priorityId, after);
  for (const conv of page) if (conv.priority_step_key && !live.has(conv.priority_step_key)) await ctx.db.patch(conv._id, { priority_step_key: undefined });
  return page.length === SESSION_PAGE ? page[page.length - 1]._creationTime : null;
}

/** The rest of a merge past its first page, a page a run (moveMergedPage): idempotent, it touches only sessions still on `from`, and each run hands the next the map with what it carried. */
export const moveMergedSessions = internalMutation({
  args: { from: v.id("priorities"), into: v.id("priorities"), step_keys: v.record(v.string(), v.string()), after: v.number(), scope: v.optional(v.object({ user_id: v.id("users"), workspace: v.string() })) },
  handler: async (ctx, args): Promise<void> => {
    const { next, into, step_keys } = await moveMergedPage(ctx, args.from, args.into, args.step_keys, args.after, args.scope);
    if (next !== null) await ctx.scheduler.runAfter(0, self.moveMergedSessions, { ...args, into, step_keys, after: next });
  },
});

/**
 * The rest of a removed or dropped milestone's sessions, a page a run. While
 * `removed` is given it scans (anchoredPage), gathering `anchored`; past the
 * last page it puts those milestones back and starts clearing from the first
 * page (clearDeadKeysPage). Idempotent: each run reads the milestones as they are then.
 */
export const clearDeadStepKeys = internalMutation({
  args: { priority_id: v.id("priorities"), after: v.number(), removed: v.optional(v.array(priorityStep)), anchored: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<void> => {
    if (args.removed?.length) {
      const scan = await anchoredPage(ctx, args.priority_id, args.after, args.removed);
      const anchored = [...new Set([...(args.anchored ?? []), ...scan.anchored])];
      if (scan.next !== null) return void (await ctx.scheduler.runAfter(0, self.clearDeadStepKeys, { ...args, after: scan.next, anchored }));
      await restoreAnchored(ctx, args.priority_id, args.removed, anchored);
      return clearDeadStepKeysFrom(ctx, args.priority_id);
    }
    const next = await clearDeadKeysPage(ctx, args.priority_id, args.after);
    if (next !== null) await ctx.scheduler.runAfter(0, self.clearDeadStepKeys, { priority_id: args.priority_id, after: next });
  },
});

/** Clears a priority's dead keys: the first page now, the rest by scheduled runs. */
async function clearDeadStepKeysFrom(ctx: { db: any; scheduler: any }, priorityId: Id<"priorities">): Promise<void> {
  const next = await clearDeadKeysPage(ctx, priorityId, 0);
  if (next !== null) await ctx.scheduler.runAfter(0, self.clearDeadStepKeys, { priority_id: priorityId, after: next });
}

/** A merge's sessions: the first page now, the rest by scheduled runs. */
export async function moveMergedSessionsNow(ctx: { db: any; scheduler: any }, from: Id<"priorities">, into: Id<"priorities">, step_keys: Record<string, string>, scope?: { user_id: Id<"users">; workspace: string }): Promise<void> {
  const page = await moveMergedPage(ctx, from, into, step_keys, 0, scope);
  if (page.next !== null) await ctx.scheduler.runAfter(0, self.moveMergedSessions, { from, into: page.into, step_keys: page.step_keys, after: page.next, ...(scope ? { scope } : {}) });
}

/**
 * A priority's sessions on dead keys, step unknown after. `removed`: the
 * milestones the pass took off, as they were. One a session the person
 * placed, or a link mapped, sits on comes back with every session on it, so
 * every page is read for those before any key is cleared (in one transaction
 * when the priority's sessions fit a page, else by scheduled runs). A drop
 * (no `removed`) is the person's and is never undone: clearing starts now.
 */
export async function clearDeadStepKeysNow(ctx: { db: any; scheduler: any }, priorityId: Id<"priorities">, removed: Step[] = []): Promise<void> {
  if (removed.length) {
    const scan = await anchoredPage(ctx, priorityId, 0, removed);
    if (scan.next !== null) return void (await ctx.scheduler.runAfter(0, self.clearDeadStepKeys, { priority_id: priorityId, after: scan.next, removed, anchored: scan.anchored }));
    await restoreAnchored(ctx, priorityId, removed, scan.anchored);
  }
  await clearDeadStepKeysFrom(ctx, priorityId);
}

/**
 * Moves sessions between priorities and then counts again, from the index,
 * every priority a session moved to or from, so a count that drifted heals:
 * the person's own in any workspace (a session made private leaves a team
 * priority from the personal pass). A move is the pass's unless `set_by`
 * says who else made it (a merge carries the session's own).
 */
export function sessionMover(ctx: { db: any }) {
  const moved = new Map<Id<"priorities">, number>();
  const move = async (conv: Doc<"conversations">, to: Id<"priorities"> | undefined, step_key: string | undefined, set_by?: Doc<"conversations">["priority_set_by"]) => {
    if (conv.priority_id) moved.set(conv.priority_id, (moved.get(conv.priority_id) ?? 0) - 1);
    if (to) moved.set(to, (moved.get(to) ?? 0) + 1);
    await ctx.db.patch(conv._id, { priority_id: to, priority_step_key: step_key, priority_set_by: to ? set_by : undefined });
    // A done pin that named this milestone before the session was on it counts now.
    if (to && step_key && (to !== conv.priority_id || step_key !== conv.priority_step_key)) await replayDonePin(ctx, conv, to, step_key);
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
