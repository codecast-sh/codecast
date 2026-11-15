// Page state: collections a published page reads and writes, live. A page
// declares them under "state" in cast-data.json (the shared contract in
// @codecast/shared/contracts/pageData); a publish stores the declaration on
// page_state_config (pageData.applySet), and the rows live in page_state.
//
// The page's runtime (lib/castData.ts) subscribes to `list` and `get` over
// Convex's own WebSocket, so a write reaches every open copy of the page
// without polling. These functions are public and reachable without the page,
// so every call carries what the page holds (its gate tokens, and the owner,
// edit and identity keys from its fragment) and is admitted by the same check
// comments use (artifacts.pageAdmission).

import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./functions";
import type { MutationCtx, QueryCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  PAGE_STATE_LIMITS,
  encodeStateValue,
  type PageStateCollection,
} from "@codecast/shared/contracts/pageData";
import { pageAdmission, type PageAdmission } from "./artifacts";
import { bumpWindow } from "./ipRateLimit";
import { teamPolicyRefusal } from "./lib/teamPolicyGuard";
import { verifyApiToken } from "./apiTokens";

/** What the page presents on every call: the gates it cleared and the keys its fragment carries. */
const presentedArgs = {
  slug: v.string(),
  k: v.optional(v.string()),
  e: v.optional(v.string()),
  m: v.optional(v.string()),
  owner_key: v.optional(v.string()),
  edit_key: v.optional(v.string()),
  identity_token: v.optional(v.string()),
};
type Presented = { slug: string; k?: string; e?: string; m?: string; owner_key?: string; edit_key?: string; identity_token?: string };

type Caller = PageAdmission & { artifact: Doc<"artifacts">; collections: PageStateCollection[] };

/** The page, its declared collections, and who the caller is on it; an error when the page or its gates refuse them. */
async function admit(ctx: { db: QueryCtx["db"]; auth: QueryCtx["auth"] }, presented: Presented): Promise<Caller | { error: string }> {
  const artifact = await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", presented.slug)).first();
  if (!artifact) return { error: "Page not found" };
  const config = await ctx.db.query("page_state_config").withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id)).first();
  if (!config) return { error: "This page declares no state" };
  const admission = await pageAdmission(ctx, artifact, presented);
  if (admission.blocked) return { error: admission.blocked };
  // A team that turns public sharing off stops its pages' state as it stops
  // their query data; the owner and teammates who see the page keep it.
  if (!artifact.team_gate && !admission.role) {
    const refusal = await teamPolicyRefusal(ctx, { workspace: config.workspace }, "public_sharing_disabled");
    if (refusal) return { error: refusal };
  }
  return { ...admission, artifact, collections: JSON.parse(config.collections_json) };
}

const isOwner = (c: PageAdmission) => c.role === "owner";

export function canRead(c: PageAdmission, coll: PageStateCollection): boolean {
  return coll.read === "viewers" || (coll.read === "editors" ? c.editor : isOwner(c));
}

export function canWrite(c: PageAdmission, coll: PageStateCollection): boolean {
  switch (coll.write) {
    case "anyone": return true;
    case "signed-in": return !!c.identity || c.editor;
    case "editors": return c.editor;
    case "owner": return isOwner(c);
  }
}

function collectionFor(caller: Caller, id: string): PageStateCollection | { error: string } {
  const coll = caller.collections.find((c) => c.id === id);
  return coll ?? { error: `This page declares no state collection "${id}" (it has: ${caller.collections.map((c) => c.id).join(", ")})` };
}

type RowView = { key: string; value_json: string; by: { name: string; avatar: string | null } | null; mine: boolean; created_at: number; updated_at: number };

async function viewRows(ctx: { db: QueryCtx["db"] }, rows: Doc<"page_state">[], me: Id<"users"> | undefined): Promise<RowView[]> {
  const people = new Map<string, { name: string; avatar: string | null } | null>();
  const out: RowView[] = [];
  for (const r of rows) {
    let by: RowView["by"] = null;
    if (r.author_user_id) {
      const id = r.author_user_id.toString();
      if (!people.has(id)) {
        const u = await ctx.db.get(r.author_user_id);
        people.set(id, u ? { name: u.name || u.github_username || "teammate", avatar: u.github_avatar_url || u.image || null } : null);
      }
      by = people.get(id) ?? null;
    }
    out.push({ key: r.key, value_json: r.value_json, by, mine: !!me && r.author_user_id === me, created_at: r.created_at, updated_at: r.updated_at });
  }
  return out;
}

// ── reads (live) ──

/** A collection's rows in key order (inserted keys sort by time). */
export const list = query({
  args: { ...presentedArgs, collection: v.string() },
  handler: async (ctx, args): Promise<{ rows: RowView[] } | { error: string }> => {
    const caller = await admit(ctx, args);
    if ("error" in caller) return caller;
    const coll = collectionFor(caller, args.collection);
    if ("error" in coll) return coll;
    if (!canRead(caller, coll)) return { error: `"${coll.id}" is readable by ${coll.read === "owner" ? "the page's owner" : "the page's editors"} only` };
    const rows = await ctx.db
      .query("page_state")
      .withIndex("by_artifact_collection_key", (q) => q.eq("artifact_id", caller.artifact._id).eq("collection", coll.id))
      .take(PAGE_STATE_LIMITS.rows);
    return { rows: await viewRows(ctx, rows, caller.identity?.user._id) };
  },
});

/** One row, or null: what a page subscribes to for a single value, so other rows' writes do not wake it. */
export const get = query({
  args: { ...presentedArgs, collection: v.string(), key: v.string() },
  handler: async (ctx, args): Promise<{ row: RowView | null } | { error: string }> => {
    const caller = await admit(ctx, args);
    if ("error" in caller) return caller;
    const coll = collectionFor(caller, args.collection);
    if ("error" in coll) return coll;
    if (!canRead(caller, coll)) return { error: `"${coll.id}" is readable by ${coll.read === "owner" ? "the page's owner" : "the page's editors"} only` };
    const row = await rowAt(ctx, caller.artifact._id, coll.id, args.key);
    return { row: row ? (await viewRows(ctx, [row], caller.identity?.user._id))[0] : null };
  },
});

/** Who the caller is on this page and what each collection lets them do. */
export const me = query({
  args: presentedArgs,
  handler: async (ctx, args) => {
    const caller = await admit(ctx, args);
    if ("error" in caller) return caller;
    return {
      name: caller.identity?.name ?? null,
      avatar: caller.identity?.avatar ?? null,
      signed_in: !!caller.identity,
      owner: isOwner(caller),
      editor: caller.editor,
      collections: caller.collections.map((c) => ({ ...c, can_read: canRead(caller, c), can_write: canWrite(caller, c) })),
    };
  },
});

// ── writes ──

const vOp = v.union(v.literal("set"), v.literal("insert"), v.literal("patch"), v.literal("delete"), v.literal("clear"));
type Op = "set" | "insert" | "patch" | "delete" | "clear";

async function rowAt(ctx: { db: QueryCtx["db"] }, artifactId: Id<"artifacts">, collection: string, key: string) {
  return await ctx.db
    .query("page_state")
    .withIndex("by_artifact_collection_key", (q) => q.eq("artifact_id", artifactId).eq("collection", collection).eq("key", key))
    .first();
}

/** A fresh key that sorts after every earlier one: time first, then randomness against same-millisecond inserts. */
function newKey(now: number): string {
  return now.toString(36).padStart(9, "0") + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

type WriteInput = { op: Op; key?: string; value_json?: string };
type Writer = { editor: boolean; author?: Id<"users"> };

/**
 * One write against a collection, caps and ownership enforced. Shared by the
 * page's mutation and the owner's CLI, so both obey the same limits.
 */
async function applyWrite(ctx: MutationCtx, artifactId: Id<"artifacts">, coll: PageStateCollection, input: WriteInput, writer: Writer): Promise<{ key?: string; cleared?: number } | { error: string }> {
  const now = Date.now();
  const counts = await ctx.db
    .query("page_state_counts")
    .withIndex("by_artifact_collection", (q) => q.eq("artifact_id", artifactId).eq("collection", coll.id))
    .first();
  const held = { rows: counts?.rows ?? 0, bytes: counts?.bytes ?? 0 };
  const save = async (rows: number, bytes: number) => {
    if (counts) await ctx.db.patch(counts._id, { rows, bytes });
    else await ctx.db.insert("page_state_counts", { artifact_id: artifactId, collection: coll.id, rows, bytes });
  };

  if (input.op === "clear") {
    if (!writer.editor) return { error: "Only the page's editors can clear a collection" };
    const rows = await ctx.db
      .query("page_state")
      .withIndex("by_artifact_collection_key", (q) => q.eq("artifact_id", artifactId).eq("collection", coll.id))
      .take(PAGE_STATE_LIMITS.rows + 1);
    for (const r of rows) await ctx.db.delete(r._id);
    await save(0, 0);
    return { cleared: rows.length };
  }

  const key = input.op === "insert" ? (input.key ?? newKey(now)) : input.key;
  if (!key) return { error: `${input.op} needs a key` };
  if (key.length > PAGE_STATE_LIMITS.key_chars) return { error: `keys are at most ${PAGE_STATE_LIMITS.key_chars} characters` };
  const existing = await rowAt(ctx, artifactId, coll.id, key);
  if (existing && coll.own && !writer.editor && (!writer.author || existing.author_user_id !== writer.author)) {
    return { error: `In "${coll.id}" you can change only rows you wrote` };
  }

  if (input.op === "delete") {
    if (!existing) return { key };
    await ctx.db.delete(existing._id);
    await save(Math.max(0, held.rows - 1), Math.max(0, held.bytes - existing.value_json.length));
    return { key };
  }
  if (input.op === "insert" && existing) return { error: `"${key}" already exists in "${coll.id}"` };

  let value: unknown;
  try {
    value = JSON.parse(input.value_json ?? "");
  } catch {
    return { error: "The value is not JSON" };
  }
  if (input.op === "patch") {
    const base = existing ? JSON.parse(existing.value_json) : {};
    if (!base || typeof base !== "object" || Array.isArray(base) || !value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "patch merges an object into an object row" };
    }
    value = { ...base, ...(value as object) };
  }
  const encoded = encodeStateValue(value);
  if ("error" in encoded) return encoded;
  const rows = held.rows + (existing ? 0 : 1);
  const bytes = held.bytes - (existing?.value_json.length ?? 0) + encoded.json.length;
  if (rows > PAGE_STATE_LIMITS.rows) return { error: `"${coll.id}" is full (${PAGE_STATE_LIMITS.rows} rows)` };
  if (bytes > PAGE_STATE_LIMITS.collection_bytes) return { error: `"${coll.id}" is full (${PAGE_STATE_LIMITS.collection_bytes / 1_048_576} MB)` };
  if (existing) {
    if (existing.value_json !== encoded.json) await ctx.db.patch(existing._id, { value_json: encoded.json, updated_at: now });
  } else {
    await ctx.db.insert("page_state", {
      artifact_id: artifactId,
      collection: coll.id,
      key,
      value_json: encoded.json,
      ...(writer.author ? { author_user_id: writer.author } : {}),
      created_at: now,
      updated_at: now,
    });
  }
  await save(rows, bytes);
  return { key };
}

/** The page's own write: admitted, checked against the collection's write level, and inside the page's per-minute budget. */
export const write = mutation({
  args: { ...presentedArgs, collection: v.string(), op: vOp, key: v.optional(v.string()), value_json: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ key?: string; cleared?: number } | { error: string }> => {
    const caller = await admit(ctx, args);
    if ("error" in caller) return caller;
    const coll = collectionFor(caller, args.collection);
    if ("error" in coll) return coll;
    if (!canWrite(caller, coll)) {
      return { error: coll.write === "signed-in" ? `Sign in to write to "${coll.id}"` : `"${coll.id}" is written by ${coll.write === "owner" ? "the page's owner" : "the page's editors"} only` };
    }
    // Last of the checks, so a refused write costs the page none of its budget.
    // The page is the unit: behind the proxy mesh a client's address rotates.
    if (!caller.editor) {
      const budget = await bumpWindow(ctx.db, `page-state:${caller.artifact._id}`, PAGE_STATE_LIMITS.writes_per_minute, 60_000);
      if (!budget.ok) return { error: "This page is taking too many writes; try again in a minute" };
    }
    return await applyWrite(ctx, caller.artifact._id, coll, { op: args.op, key: args.key, value_json: args.value_json }, {
      editor: caller.editor,
      author: caller.identity?.user._id,
    });
  },
});

// ── the owner's CLI: `cast publish state` ──

async function ownerPage(ctx: { db: QueryCtx["db"] }, owner: Id<"users">, target: string) {
  const bySlug = await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", target)).first();
  const artifact = bySlug && bySlug.user_id === owner
    ? bySlug
    : await ctx.db.query("artifacts").withIndex("by_user_path", (q) => q.eq("user_id", owner).eq("source_path", target)).first();
  if (!artifact) return null;
  const config = await ctx.db.query("page_state_config").withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id)).first();
  return { artifact, collections: (config ? JSON.parse(config.collections_json) : []) as PageStateCollection[] };
}

export const ownerRead = internalQuery({
  args: { owner: v.id("users"), target: v.string(), collection: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const page = await ownerPage(ctx, args.owner, args.target);
    if (!page) return { error: `No page of yours matches "${args.target}" (cast publish ls)` };
    const out = [];
    for (const c of page.collections) {
      if (args.collection && c.id !== args.collection) continue;
      const counts = await ctx.db
        .query("page_state_counts")
        .withIndex("by_artifact_collection", (q) => q.eq("artifact_id", page.artifact._id).eq("collection", c.id))
        .first();
      const rows = await ctx.db
        .query("page_state")
        .withIndex("by_artifact_collection_key", (q) => q.eq("artifact_id", page.artifact._id).eq("collection", c.id))
        .take(PAGE_STATE_LIMITS.rows);
      out.push({ ...c, bytes: counts?.bytes ?? 0, rows: await viewRows(ctx, rows, args.owner) });
    }
    if (args.collection && !out.length) return { error: `${page.artifact.slug} declares no state collection "${args.collection}"` };
    return { slug: page.artifact.slug, title: page.artifact.title, collections: out };
  },
});

export const ownerWrite = internalMutation({
  args: { owner: v.id("users"), target: v.string(), collection: v.string(), op: vOp, key: v.optional(v.string()), value_json: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ key?: string; cleared?: number } | { error: string }> => {
    const page = await ownerPage(ctx, args.owner, args.target);
    if (!page) return { error: `No page of yours matches "${args.target}" (cast publish ls)` };
    const coll = page.collections.find((c) => c.id === args.collection);
    if (!coll) return { error: `${page.artifact.slug} declares no state collection "${args.collection}"` };
    return await applyWrite(ctx, page.artifact._id, coll, { op: args.op, key: args.key, value_json: args.value_json }, { editor: true, author: args.owner });
  },
});

/** `cast publish state <target> [collection]`, with --set/--insert/--patch/--delete/--clear for one write first. */
export const forCli = action({
  args: {
    api_token: v.string(),
    target: v.string(),
    collection: v.optional(v.string()),
    op: v.optional(vOp),
    key: v.optional(v.string()),
    value_json: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const owner: Id<"users"> | null = await ctx.runQuery(internal.pageState.ownerToken, { api_token: args.api_token });
    if (!owner) throw new Error("Unauthorized");
    let wrote: { key?: string; cleared?: number } | { error: string } | undefined;
    if (args.op) {
      if (!args.collection) throw new Error("A write names its collection");
      const w: { key?: string; cleared?: number } | { error: string } = await ctx.runMutation(internal.pageState.ownerWrite, { owner, target: args.target, collection: args.collection, op: args.op, key: args.key, value_json: args.value_json });
      if ("error" in w) throw new Error(w.error);
      wrote = w;
    }
    const read: any = await ctx.runQuery(internal.pageState.ownerRead, { owner, target: args.target, collection: args.collection });
    if (read.error) throw new Error(read.error);
    return { ...read, ...(wrote ? { wrote } : {}) };
  },
});

export const ownerToken = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args): Promise<Id<"users"> | null> => (await verifyApiToken(ctx, args.api_token))?.userId ?? null,
});
