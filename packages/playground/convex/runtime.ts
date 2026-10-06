// The backend of the runtime SDK (/run/sdk.js, runtime/sdk.ts): an app's live
// data, its shared values, and who is in it. Every call proves a visitor in
// one app with a runtime token (requireRuntimeVisitor), every write is stamped
// with that visitor here, never by the caller, and every value passes
// lib/appData's checks and lib/limits' caps before it is stored.
import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { SHARED_COLLECTION, checkDoc, checkPresenceState, checkShared, isCollectionName, isSharedKey } from "./lib/appData";
import { fail } from "./lib/errors";
import { DATA_LIST_MAX, MAX_DATA_BYTES_PER_APP, MAX_DATA_DOCS_PER_APP } from "./lib/limits";
import { takeRate } from "./limits";
import { requireApp, touchApp } from "./model";
import { hereRows, insertPresence, presenceRow } from "./presence";
import { publicVisitor, publicVisitors, requireRuntimeVisitor, type PublicVisitor, type RuntimeCredentials } from "./visitors";
import { runtimeArgs } from "./validators";

/** A collection doc as an app sees it: the stored object plus who wrote it and when. */
export type DataDoc = Record<string, unknown> & { _id: Id<"app_data">; _by: PublicVisitor | null; _at: number };

export type SharedView = { value: unknown; rev: number; by: PublicVisitor | null; at: number } | null;

export type PersonView = { visitor: PublicVisitor; state: Record<string, unknown> | null };

async function requireRuntime(ctx: QueryCtx, args: RuntimeCredentials & { app_id: Id<"apps"> }) {
  const visitor = await requireRuntimeVisitor(ctx, args);
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
 *  the caps. Shrinking always succeeds. */
async function adjustUsage(ctx: MutationCtx, appId: Id<"apps">, docs: number, bytes: number): Promise<void> {
  const row = await usageRow(ctx, appId);
  const next = { docs: (row?.docs ?? 0) + docs, bytes: (row?.bytes ?? 0) + bytes };
  if (docs > 0 && next.docs > MAX_DATA_DOCS_PER_APP) fail("invalid", `This app already holds ${MAX_DATA_DOCS_PER_APP} docs, the most it can.`);
  if (bytes > 0 && next.bytes > MAX_DATA_BYTES_PER_APP) fail("invalid", "This app's data is full. Remove something first.");
  if (row) await ctx.db.patch(row._id, next);
  else await ctx.db.insert("app_data_usage", { app_id: appId, ...next });
}

/** An app's doc by an id the app handed back, or invalid when it is not one
 *  of this app's collection docs. */
async function requireDoc(ctx: QueryCtx, appId: Id<"apps">, rawId: string): Promise<Doc<"app_data">> {
  const id = ctx.db.normalizeId("app_data", rawId);
  const row = id ? await ctx.db.get(id) : null;
  return row && row.app_id === appId && row.collection !== SHARED_COLLECTION ? row : fail("not_found", "That doc does not exist anymore.");
}

function sharedRow(ctx: QueryCtx, appId: Id<"apps">, key: string) {
  return ctx.db
    .query("app_data")
    .withIndex("by_app_collection_key", (q) => q.eq("app_id", appId).eq("collection", SHARED_COLLECTION).eq("key", key))
    .unique();
}

/** `me`: the visitor this app speaks for, live as they rename or change face. */
export const me = query({
  args: runtimeArgs,
  handler: async (ctx, args): Promise<PublicVisitor> => publicVisitor((await requireRuntime(ctx, args)).visitor),
});

/** usePresence: who is in the app now with their app state, earliest first. */
export const people = query({
  args: runtimeArgs,
  handler: async (ctx, args): Promise<PersonView[]> => {
    const { app } = await requireRuntime(ctx, args);
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
    const { visitor, app } = await requireRuntime(ctx, args);
    const state = requireValid(checkPresenceState(args.state)).value;
    await takeRate(ctx, "presenceState", visitor._id);
    const row = await presenceRow(ctx, app._id, visitor._id);
    if (row) await ctx.db.patch(row._id, { state });
    else await insertPresence(ctx, app._id, visitor._id, Date.now(), { state });
    return null;
  },
});

/** useCollection: the latest DATA_LIST_MAX docs of a collection, oldest first. */
export const list = query({
  args: { ...runtimeArgs, collection: v.string() },
  handler: async (ctx, args): Promise<DataDoc[]> => {
    const { app } = await requireRuntime(ctx, args);
    const collection = requireCollection(args.collection);
    const rows = (
      await ctx.db
        .query("app_data")
        .withIndex("by_app_collection_key", (q) => q.eq("app_id", app._id).eq("collection", collection))
        .order("desc")
        .take(DATA_LIST_MAX)
    ).reverse();
    const authors = await publicVisitors(ctx, rows.map((r) => r.created_by));
    return rows.map((r) => ({ ...r.value, _id: r._id, _by: authors.get(r.created_by) ?? null, _at: r.updated_at }));
  },
});

export const insert = mutation({
  args: { ...runtimeArgs, collection: v.string(), value: v.any() },
  handler: async (ctx, args): Promise<Id<"app_data">> => {
    const { visitor, app } = await requireRuntime(ctx, args);
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
    const { visitor, app } = await requireRuntime(ctx, args);
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
    const { visitor, app } = await requireRuntime(ctx, args);
    const row = await requireDoc(ctx, app._id, args.id);
    await writeGate(ctx, app, visitor);
    await adjustUsage(ctx, app._id, -1, -row.size);
    await ctx.db.delete(row._id);
    return null;
  },
});

/** useShared: one key's value, or null before anyone set it. */
export const shared = query({
  args: { ...runtimeArgs, key: v.string() },
  handler: async (ctx, args): Promise<SharedView> => {
    const { app } = await requireRuntime(ctx, args);
    if (!isSharedKey(args.key)) fail("invalid", "A shared key must be 1 to 64 characters.");
    const row = await sharedRow(ctx, app._id, args.key);
    if (!row) return null;
    const by = await publicVisitors(ctx, [row.updated_by]);
    return { value: row.value, rev: row.rev, by: by.get(row.updated_by) ?? null, at: row.updated_at };
  },
});

export type SetSharedResult = { ok: true; rev: number } | { ok: false; value: unknown; rev: number };

/** Set a shared value. With `base_rev` (0 for "nobody set it yet") the write
 *  only lands if nobody wrote since; otherwise it answers with the current
 *  value so the SDK can run the updater again. Without it, last write wins. */
export const setShared = mutation({
  args: { ...runtimeArgs, key: v.string(), value: v.any(), base_rev: v.optional(v.number()) },
  handler: async (ctx, args): Promise<SetSharedResult> => {
    const { visitor, app } = await requireRuntime(ctx, args);
    if (!isSharedKey(args.key)) fail("invalid", "A shared key must be 1 to 64 characters.");
    const value = requireValid(checkShared(args.value));
    const row = await sharedRow(ctx, app._id, args.key);
    const rev = row?.rev ?? 0;
    if (args.base_rev !== undefined && args.base_rev !== rev) return { ok: false, value: row?.value ?? null, rev };
    await writeGate(ctx, app, visitor);
    await adjustUsage(ctx, app._id, row ? 0 : 1, value.size - (row?.size ?? 0));
    const fields = { value: value.value, size: value.size, rev: rev + 1, updated_by: visitor._id, updated_at: Date.now() };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("app_data", { app_id: app._id, collection: SHARED_COLLECTION, key: args.key, created_by: visitor._id, ...fields });
    return { ok: true, rev: rev + 1 };
  },
});

const COPY_BATCH = 100;

/** Start copying every doc and shared value of one app into another (a
 *  fork's data). Runs in batches so a full app fits the mutation limits. */
export async function startDataCopy(ctx: MutationCtx, fromAppId: Id<"apps">, toAppId: Id<"apps">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.runtime.copyData, { from_app_id: fromAppId, to_app_id: toAppId, cursor: null });
}

export const copyData = internalMutation({
  args: { from_app_id: v.id("apps"), to_app_id: v.id("apps"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("app_data")
      .withIndex("by_app_collection_key", (q) => q.eq("app_id", args.from_app_id))
      .paginate({ cursor: args.cursor, numItems: COPY_BATCH });
    let bytes = 0;
    for (const { _id, _creationTime, app_id, ...row } of page.page) {
      await ctx.db.insert("app_data", { ...row, app_id: args.to_app_id });
      bytes += row.size;
    }
    if (page.page.length) await adjustUsage(ctx, args.to_app_id, page.page.length, bytes);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.runtime.copyData, { ...args, cursor: page.continueCursor });
    return page.page.length;
  },
});
