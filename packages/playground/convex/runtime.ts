// The backend of the runtime SDK (/run/sdk, runtime/sdk.ts): an app's live
// data, its shared values, each person's private values, and who is in it. Every call proves a visitor in
// one app with a runtime token (requireRuntimeVisitor), every write is stamped
// with that visitor here, never by the caller, and every value passes
// lib/appData's checks and lib/limits' caps before it is stored.
import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { MINE_COLLECTION, SHARED_COLLECTION, checkDoc, checkPresenceState, checkShared, checkWhere, isCollectionName, isSharedKey, type Where } from "./lib/appData";
import { fail } from "./lib/errors";
import { COPY_DAILY_BYTES, COPY_INLINE_BYTES, COPY_PAGE_DOCS, DATA_LIST_MAX, DATA_REMOVE_PAGE, MAX_DATA_BYTES_PER_APP, MAX_DATA_DOCS_PER_APP, VISITOR_COPY_DAILY_BYTES } from "./lib/limits";
import { takeRate } from "./limits";
import { postSystemNote, requireApp, touchApp } from "./model";
import { TALLY, addTally, tally } from "./tallies";
import { hereRows, insertPresence, presenceRow } from "./presence";
import { publicVisitor, publicVisitors, requireRuntimeVisitor, type PublicVisitor, type RuntimeCredentials } from "./visitors";
import { runtimeArgs } from "./validators";

/** A collection doc as an app sees it: the stored object plus who wrote it and when. */
export type DataDoc = Record<string, unknown> & { _id: Id<"app_data">; _by: PublicVisitor | null; _at: number };

export type SharedView = { value: unknown; rev: number; by: PublicVisitor | null; at: number } | null;

export type PersonView = { visitor: PublicVisitor; state: Record<string, unknown> | null };

async function requireRuntime(ctx: QueryCtx, args: RuntimeCredentials & { app_id: Id<"apps"> }, access: "read" | "write") {
  const visitor = await requireRuntimeVisitor(ctx, args, access);
  return { visitor, app: await requireApp(ctx, args.app_id) };
}

/** Rate rules and app activity for one data write. */
async function writeGate(ctx: MutationCtx, app: Doc<"apps">, visitor: Doc<"visitors">): Promise<void> {
  await takeRate(ctx, "dataWrite", visitor._id);
  await takeRate(ctx, "appDataWrite", app._id);
  await touchApp(ctx, app);
}

function requireCollection(name: string): string {
  return isCollectionName(name) ? name : fail("invalid", `"${name}" is not a collection name; use letters, digits, _ . : -`);
}

function requireValid<T>(checked: { ok: true; value: T; size: number } | { ok: false; problem: string }) {
  return checked.ok ? checked : fail("invalid", checked.problem);
}

function usageRow(ctx: QueryCtx, appId: Id<"apps">) {
  return ctx.db.query("app_data_usage").withIndex("by_app", (q) => q.eq("app_id", appId)).unique();
}

/** Count docs and bytes into or out of an app's usage, refusing growth past
 *  the caps unless `capped` is false. Shrinking always succeeds. */
async function adjustUsage(ctx: MutationCtx, appId: Id<"apps">, docs: number, bytes: number, { capped = true } = {}): Promise<void> {
  const row = await usageRow(ctx, appId);
  const next = { docs: (row?.docs ?? 0) + docs, bytes: (row?.bytes ?? 0) + bytes };
  if (capped && docs > 0 && next.docs > MAX_DATA_DOCS_PER_APP) fail("invalid", `This app already holds ${MAX_DATA_DOCS_PER_APP} docs, the most it can.`);
  if (capped && bytes > 0 && next.bytes > MAX_DATA_BYTES_PER_APP) fail("invalid", "This app's data is full. Remove something first.");
  if (row) await ctx.db.patch(row._id, next);
  else await ctx.db.insert("app_data_usage", { app_id: appId, ...next });
}

/** An app's doc by an id the app handed back, or invalid when it is not one
 *  of this app's collection docs (keyed values live in "~" collections). */
async function requireDoc(ctx: QueryCtx, appId: Id<"apps">, rawId: string): Promise<Doc<"app_data">> {
  const id = ctx.db.normalizeId("app_data", rawId);
  const row = id ? await ctx.db.get(id) : null;
  return row && row.app_id === appId && !row.collection.startsWith("~") ? row : fail("not_found", "That doc does not exist anymore.");
}

/** A keyed value's place: a useShared key, or a useMine key, which the
 *  caller's own visitor id scopes so nobody else's token reaches it. */
type Slot = { collection: string; key: string };
function slotFor(visitor: Doc<"visitors">, key: string, mine: boolean | undefined): Slot {
  if (!isSharedKey(key)) fail("invalid", "A key must be 1 to 64 characters.");
  return mine ? { collection: MINE_COLLECTION, key: `${visitor._id}:${key}` } : { collection: SHARED_COLLECTION, key };
}

function keyedRow(ctx: QueryCtx, appId: Id<"apps">, slot: Slot) {
  return ctx.db
    .query("app_data")
    .withIndex("by_app_collection_key", (q) => q.eq("app_id", appId).eq("collection", slot.collection).eq("key", slot.key))
    .unique();
}

/** A collection's docs matching `where`, newest first. */
function matching(ctx: QueryCtx, appId: Id<"apps">, collection: string, where: Where | null) {
  const rows = ctx.db
    .query("app_data")
    .withIndex("by_app_collection_key", (q) => q.eq("app_id", appId).eq("collection", collection))
    .order("desc");
  const fields = Object.entries(where ?? {});
  // Doc values are untyped (v.any()), so their field paths are too.
  return fields.length ? rows.filter((q) => q.and(...fields.map(([k, v]) => q.eq(q.field(`value.${k}` as "value"), v)))) : rows;
}

/** `me`: the visitor this app speaks for, live as they rename or change face. */
export const me = query({
  args: runtimeArgs,
  handler: async (ctx, args): Promise<PublicVisitor> => publicVisitor((await requireRuntime(ctx, args, "read")).visitor),
});

/** usePresence: who is in the app now with their app state, earliest first. */
export const people = query({
  args: runtimeArgs,
  handler: async (ctx, args): Promise<PersonView[]> => {
    const { app } = await requireRuntime(ctx, args, "read");
    const rows = await hereRows(ctx, app._id);
    const visitors = await publicVisitors(ctx, rows.map((r) => r.visitor_id));
    return rows.flatMap((r) => {
      const visitor = visitors.get(r.visitor_id);
      return visitor ? [{ visitor, state: (r.state as Record<string, unknown> | undefined) ?? null }] : [];
    });
  },
});

/** setMyState: replace this visitor's app state. Arriving counts as being here. */
export const setState = mutation({
  args: { ...runtimeArgs, state: v.any() },
  handler: async (ctx, args) => {
    const { visitor, app } = await requireRuntime(ctx, args, "write");
    const state = requireValid(checkPresenceState(args.state)).value;
    await takeRate(ctx, "presenceState", visitor._id);
    const row = await presenceRow(ctx, app._id, visitor._id);
    if (row) await ctx.db.patch(row._id, { state });
    else await insertPresence(ctx, app._id, visitor._id, Date.now(), { state });
    return null;
  },
});

/** useCollection: the latest DATA_LIST_MAX docs of a collection that match
 *  `where`, oldest first. */
export const list = query({
  args: { ...runtimeArgs, collection: v.string(), where: v.optional(v.any()) },
  handler: async (ctx, args): Promise<DataDoc[]> => {
    const { app } = await requireRuntime(ctx, args, "read");
    const collection = requireCollection(args.collection);
    const where = args.where === undefined ? null : requireValid(checkWhere(args.where)).value;
    const rows = (await matching(ctx, app._id, collection, where).take(DATA_LIST_MAX)).reverse();
    const authors = await publicVisitors(ctx, rows.map((r) => r.created_by));
    return rows.map((r) => ({ ...r.value, _id: r._id, _by: authors.get(r.created_by) ?? null, _at: r.updated_at }));
  },
});

export const insert = mutation({
  args: { ...runtimeArgs, collection: v.string(), value: v.any() },
  handler: async (ctx, args): Promise<Id<"app_data">> => {
    const { visitor, app } = await requireRuntime(ctx, args, "write");
    const collection = requireCollection(args.collection);
    const doc = requireValid(checkDoc(args.value));
    await writeGate(ctx, app, visitor);
    await adjustUsage(ctx, app._id, 1, doc.size);
    return ctx.db.insert("app_data", {
      app_id: app._id,
      collection,
      value: doc.value,
      size: doc.size,
      rev: 1,
      created_by: visitor._id,
      updated_by: visitor._id,
      updated_at: Date.now(),
    });
  },
});

/** Shallow-merge `patch` into a doc. */
export const update = mutation({
  args: { ...runtimeArgs, id: v.string(), patch: v.any() },
  handler: async (ctx, args) => {
    const { visitor, app } = await requireRuntime(ctx, args, "write");
    const row = await requireDoc(ctx, app._id, args.id);
    const patch = requireValid(checkDoc(args.patch)).value;
    const doc = requireValid(checkDoc({ ...row.value, ...patch }));
    await writeGate(ctx, app, visitor);
    await adjustUsage(ctx, app._id, 0, doc.size - row.size);
    await ctx.db.patch(row._id, { value: doc.value, size: doc.size, rev: row.rev + 1, updated_by: visitor._id, updated_at: Date.now() });
    return null;
  },
});

export const remove = mutation({
  args: { ...runtimeArgs, id: v.string() },
  handler: async (ctx, args) => {
    const { visitor, app } = await requireRuntime(ctx, args, "write");
    const row = await requireDoc(ctx, app._id, args.id);
    await writeGate(ctx, app, visitor);
    await adjustUsage(ctx, app._id, -1, -row.size);
    await ctx.db.delete(row._id);
    return null;
  },
});

/** removeWhere: delete a collection's docs that match `where` ({} matches
 *  all), up to DATA_REMOVE_PAGE a call; `more` says some are left. */
export const removeWhere = mutation({
  args: { ...runtimeArgs, collection: v.string(), where: v.any() },
  handler: async (ctx, args): Promise<{ removed: number; more: boolean }> => {
    const { visitor, app } = await requireRuntime(ctx, args, "write");
    const collection = requireCollection(args.collection);
    const where = requireValid(checkWhere(args.where)).value;
    await writeGate(ctx, app, visitor);
    const rows = await matching(ctx, app._id, collection, where).take(DATA_REMOVE_PAGE + 1);
    const gone = rows.slice(0, DATA_REMOVE_PAGE);
    for (const row of gone) await ctx.db.delete(row._id);
    await adjustUsage(ctx, app._id, -gone.length, -gone.reduce((n, r) => n + r.size, 0));
    return { removed: gone.length, more: rows.length > gone.length };
  },
});

/** useShared, or with `mine` useMine: one key's value, or null before it was set. */
export const shared = query({
  args: { ...runtimeArgs, key: v.string(), mine: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<SharedView> => {
    const { visitor, app } = await requireRuntime(ctx, args, "read");
    const row = await keyedRow(ctx, app._id, slotFor(visitor, args.key, args.mine));
    if (!row) return null;
    const by = await publicVisitors(ctx, [row.updated_by]);
    return { value: row.value, rev: row.rev, by: by.get(row.updated_by) ?? null, at: row.updated_at };
  },
});

export type SetSharedResult = { ok: true; rev: number } | { ok: false; value: unknown; rev: number };

/** Set a shared value (with `mine`, the caller's own). With `base_rev` (0
 *  for "nobody set it yet") the write only lands if nobody wrote since;
 *  otherwise it answers with the current value so the SDK can run the
 *  updater again. Without it, last write wins. */
export const setShared = mutation({
  args: { ...runtimeArgs, key: v.string(), mine: v.optional(v.boolean()), value: v.any(), base_rev: v.optional(v.number()) },
  handler: async (ctx, args): Promise<SetSharedResult> => {
    const { visitor, app } = await requireRuntime(ctx, args, "write");
    const slot = slotFor(visitor, args.key, args.mine);
    const value = requireValid(checkShared(args.value));
    const row = await keyedRow(ctx, app._id, slot);
    const rev = row?.rev ?? 0;
    if (args.base_rev !== undefined && args.base_rev !== rev) return { ok: false, value: row?.value ?? null, rev };
    await writeGate(ctx, app, visitor);
    await adjustUsage(ctx, app._id, row ? 0 : 1, value.size - (row?.size ?? 0));
    const fields = { value: value.value, size: value.size, rev: rev + 1, updated_by: visitor._id, updated_at: Date.now() };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("app_data", { app_id: app._id, ...slot, created_by: visitor._id, ...fields });
    return { ok: true, rev: rev + 1 };
  },
});

/** Start copying one app's docs and shared values into its new fork, as they
 *  stood when the fork was made. A small app copies here, inside the fork's own
 *  transaction; a bigger one copies in pages after it while the fork is
 *  already open, so a page skips rows made after the fork and never
 *  overwrites a shared value the fork set first. When a copy budget is spent
 *  the fork starts empty and its room says so. */
export async function startDataCopy(ctx: MutationCtx, from: Id<"apps">, fork: Id<"apps">, by: Id<"visitors">): Promise<void> {
  const usage = await usageRow(ctx, from);
  if (!usage?.docs) return;
  const [all, mine] = await Promise.all([tally(ctx, TALLY.copied), tally(ctx, TALLY.visitorCopied(by))]);
  if (all + usage.bytes > COPY_DAILY_BYTES || mine + usage.bytes > VISITOR_COPY_DAILY_BYTES) {
    await postSystemNote(ctx, fork, { type: "data", outcome: "skipped" }, "This fork started with no data: today's copying is used up.");
    return;
  }
  await addTally(ctx, [TALLY.copied, TALLY.visitorCopied(by)], usage.bytes);
  // The snapshot's edge: rows made before the fork itself was.
  const until = (await ctx.db.get(fork))!._creationTime;
  if (usage.docs <= COPY_PAGE_DOCS && usage.bytes <= COPY_INLINE_BYTES) {
    const rows = await ctx.db.query("app_data").withIndex("by_app_collection_key", (q) => q.eq("app_id", from)).take(COPY_PAGE_DOCS);
    await copyRows(ctx, rows, fork, until);
    return;
  }
  await ctx.scheduler.runAfter(0, internal.runtime.copyData, { from, fork, until, phase: "shared", cursor: null });
}

/** Insert `rows` into the fork: those made by `until`, and of keyed values
 *  only keys the fork has not set itself. Counted into the fork's usage
 *  without its caps: the source already fit them, and the fork's own later
 *  writes are what the caps refuse. */
async function copyRows(ctx: MutationCtx, rows: Doc<"app_data">[], fork: Id<"apps">, until: number): Promise<void> {
  let docs = 0;
  let bytes = 0;
  for (const { _id, _creationTime, app_id, ...row } of rows) {
    if (_creationTime > until) continue;
    if (row.key !== undefined && (await keyedRow(ctx, fork, { collection: row.collection, key: row.key }))) continue;
    await ctx.db.insert("app_data", { ...row, app_id: fork });
    docs += 1;
    bytes += row.size;
  }
  if (docs) await adjustUsage(ctx, fork, docs, bytes, { capped: false });
}

type CopyStep = { from: Id<"apps">; fork: Id<"apps">; until: number; phase: "shared" | "docs"; cursor: string | null };

/** Copy one page of a phase, shared values first so the fork's app sees
 *  them soonest, then collection docs; the next step, or null when done. */
async function copyPage(ctx: MutationCtx, step: CopyStep): Promise<CopyStep | null> {
  const page = await ctx.db
    .query("app_data")
    .withIndex("by_app_collection_key", (q) => (step.phase === "shared" ? q.eq("app_id", step.from).eq("collection", SHARED_COLLECTION) : q.eq("app_id", step.from)))
    .paginate({ cursor: step.cursor, numItems: COPY_PAGE_DOCS });
  const rows = step.phase === "shared" ? page.page : page.page.filter((r) => r.collection !== SHARED_COLLECTION);
  await copyRows(ctx, rows, step.fork, step.until);
  if (!page.isDone) return { ...step, cursor: page.continueCursor };
  return step.phase === "shared" ? { ...step, phase: "docs", cursor: null } : null;
}

const copyStep = {
  from: v.id("apps"),
  fork: v.id("apps"),
  until: v.number(),
  phase: v.union(v.literal("shared"), v.literal("docs")),
  cursor: v.union(v.string(), v.null()),
};

/** One page of a paged copy, then the next. A page that throws ends the
 *  copy where it stood, and the fork's room hears that it stopped short. */
export const copyData = internalMutation({
  args: copyStep,
  handler: async (ctx, step) => {
    let next: CopyStep | null;
    try {
      next = await copyPage(ctx, step);
    } catch (e) {
      console.error(`fork data copy into ${step.fork} stopped:`, e);
      await postSystemNote(ctx, step.fork, { type: "data", outcome: "partial" }, "Some of the data didn't copy over to this fork.");
      return;
    }
    if (next) await ctx.scheduler.runAfter(0, internal.runtime.copyData, next);
  },
});
