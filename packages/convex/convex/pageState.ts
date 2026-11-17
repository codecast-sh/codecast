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
//
// Sessions take part too. Every write fires the trigger event page_state for
// the page, so a session that ran `cast publish watch <page>` wakes with what
// changed (coalesced, lib/triggerMatch), and its own writes through
// `cast publish state` are stamped with the session and never wake it back.
// A session reads and writes as its user would in the app (accountAdmission).

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
import { accountAdmission, artifactUrl, pageAdmission, type PageAdmission } from "./artifacts";
import { pageTriggers, scheduleTriggerMatch } from "./lib/triggerMatch";
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

type RowView = {
  key: string;
  value_json: string;
  by: { name: string; avatar: string | null } | null;
  /** The agent session that wrote the row, when one did: an answer the page can show as the agent's. */
  agent: { session: string; title: string } | null;
  mine: boolean;
  created_at: number;
  updated_at: number;
};

async function viewRows(ctx: { db: QueryCtx["db"] }, rows: Doc<"page_state">[], me: Id<"users"> | undefined): Promise<RowView[]> {
  const people = new Map<string, { name: string; avatar: string | null } | null>();
  const sessions = new Map<string, RowView["agent"]>();
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
    let agent: RowView["agent"] = null;
    if (r.author_conversation_id) {
      const id = r.author_conversation_id.toString();
      if (!sessions.has(id)) {
        const conv = await ctx.db.get(r.author_conversation_id);
        sessions.set(id, conv ? { session: id.slice(0, 7), title: conv.title || "agent session" } : null);
      }
      agent = sessions.get(id) ?? null;
    }
    out.push({ key: r.key, value_json: r.value_json, by, agent, mine: !!me && r.author_user_id === me, created_at: r.created_at, updated_at: r.updated_at });
  }
  return out;
}

/** The armed triggers watching a page: a running one is an agent at work on what the page sent it. */
async function pageWatchers(ctx: { db: QueryCtx["db"] }, artifactId: Id<"artifacts">): Promise<Doc<"agent_tasks">[]> {
  const out: Doc<"agent_tasks">[] = [];
  for (const status of ["scheduled", "running"] as const) out.push(...((await pageTriggers(ctx, status, String(artifactId)).collect()) as Doc<"agent_tasks">[]));
  return out.filter((t) => t.event_filter?.event_type === "page_state");
}

/**
 * What the page may show about the agents watching it: how many, and how many
 * are at work on a change right now (a run going, or a burst waiting out its
 * window). Counts only: whose sessions they are is the owner's business.
 */
async function agentsOn(ctx: { db: QueryCtx["db"] }, artifactId: Id<"artifacts">) {
  const watchers = await pageWatchers(ctx, artifactId);
  return {
    watching: watchers.length,
    working: watchers.filter((t) => t.status === "running" || (t.pending_events?.length ?? 0) > 0).length,
  };
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
      agents: await agentsOn(ctx, caller.artifact._id),
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

/**
 * A fresh key that sorts after every earlier one: the time, then a counter
 * past the last key inserted in the same millisecond, so two inserts that land
 * together still list in the order they were made.
 */
async function newKey(ctx: { db: QueryCtx["db"] }, artifactId: Id<"artifacts">, collection: string, now: number): Promise<string> {
  const prefix = now.toString(36).padStart(9, "0");
  const last = await ctx.db
    .query("page_state")
    .withIndex("by_artifact_collection_key", (q) => q.eq("artifact_id", artifactId).eq("collection", collection).gte("key", prefix).lt("key", `${prefix}~`))
    .order("desc")
    .first();
  const next = last ? (parseInt(last.key.slice(prefix.length), 36) || 0) + 1 : 0;
  return prefix + next.toString(36).padStart(6, "0");
}

type WriteInput = { op: Op; key?: string; value_json?: string };
type Writer = {
  editor: boolean;
  author?: Id<"users">;
  /** The agent session writing through the CLI: stamped on the row, and never woken by its own write. */
  session?: Id<"conversations">;
  /** Who wrote it, as a watching session reads it. */
  name: string;
};

/**
 * One write against a collection, caps and ownership enforced. Shared by the
 * page's mutation and the owner's CLI, so both obey the same limits.
 */
async function applyWrite(ctx: MutationCtx, artifact: Doc<"artifacts">, coll: PageStateCollection, input: WriteInput, writer: Writer): Promise<{ key?: string; cleared?: number } | { error: string }> {
  const result = await writeRows(ctx, artifact._id, coll, input, writer);
  if (!("error" in result) && result.changed) {
    await announceWrite(ctx, artifact, coll, input.op, result.key, result.value_json, writer);
  }
  const { changed: _c, value_json: _v, ...out } = result as { changed?: boolean; value_json?: string; key?: string; cleared?: number } & { error?: string };
  return out as { key?: string; cleared?: number } | { error: string };
}

/** How much of a written value a watching session reads in its wake: enough to act on a small row without a read. */
const ANNOUNCED_VALUE_CHARS = 200;

/**
 * Tell the sessions watching this page what changed (trigger event
 * page_state). One line per write, coalesced into one run per burst by the
 * matcher; the value rides along cut short, because most rows a page writes
 * (a vote, a request, a checkbox) are small enough to act on as they are.
 */
async function announceWrite(ctx: MutationCtx, artifact: Doc<"artifacts">, coll: PageStateCollection, op: Op, key: string | undefined, valueJson: string | undefined, writer: Writer) {
  const value = valueJson === undefined ? "" : `: ${valueJson.length > ANNOUNCED_VALUE_CHARS ? `${valueJson.slice(0, ANNOUNCED_VALUE_CHARS)}…` : valueJson}`;
  const verb = op === "clear" ? "cleared" : op === "delete" ? `deleted ${key}` : op === "insert" ? `added ${key}` : `set ${key}`;
  await scheduleTriggerMatch(ctx, {
    event_type: "page_state",
    page_id: artifact._id,
    collection: coll.id,
    ...(writer.session ? { origin_conversation_id: String(writer.session) } : {}),
    event_ref: {
      group_short_id: `${artifact.slug}/${coll.id}`,
      title: `${writer.name} ${verb}${value}`,
      url: artifactUrl(artifact.slug),
    },
  });
}

type RowsWritten = { key?: string; cleared?: number; changed: boolean; value_json?: string } | { error: string };

async function writeRows(ctx: MutationCtx, artifactId: Id<"artifacts">, coll: PageStateCollection, input: WriteInput, writer: Writer): Promise<RowsWritten> {
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
    return { cleared: rows.length, changed: rows.length > 0 };
  }

  const key = input.op === "insert" ? (input.key ?? (await newKey(ctx, artifactId, coll.id, now))) : input.key;
  if (!key) return { error: `${input.op} needs a key` };
  if (key.length > PAGE_STATE_LIMITS.key_chars) return { error: `keys are at most ${PAGE_STATE_LIMITS.key_chars} characters` };
  const existing = await rowAt(ctx, artifactId, coll.id, key);
  if (existing && coll.own && !writer.editor && (!writer.author || existing.author_user_id !== writer.author)) {
    return { error: `In "${coll.id}" you can change only rows you wrote` };
  }

  if (input.op === "delete") {
    if (!existing) return { key, changed: false };
    await ctx.db.delete(existing._id);
    await save(Math.max(0, held.rows - 1), Math.max(0, held.bytes - existing.value_json.length));
    return { key, changed: true };
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
  const changed = !existing || existing.value_json !== encoded.json;
  const session = writer.session ? { author_conversation_id: writer.session } : {};
  if (existing) {
    if (changed) await ctx.db.patch(existing._id, { value_json: encoded.json, updated_at: now, ...session });
  } else {
    await ctx.db.insert("page_state", {
      artifact_id: artifactId,
      collection: coll.id,
      key,
      value_json: encoded.json,
      ...(writer.author ? { author_user_id: writer.author } : {}),
      ...session,
      created_at: now,
      updated_at: now,
    });
  }
  await save(rows, bytes);
  return { key, changed, value_json: encoded.json };
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
    return await applyWrite(ctx, caller.artifact, coll, { op: args.op, key: args.key, value_json: args.value_json }, {
      editor: caller.editor,
      author: caller.identity?.user._id,
      name: caller.identity?.name ?? (isOwner(caller) ? "the page's owner" : "an anonymous viewer"),
    });
  },
});

// ── sessions: `cast publish state` and `cast publish watch` ──

/**
 * A page an account names from the CLI: by slug or page URL (any page the
 * account may open), or by the source path it published from (its own).
 */
type AccountPage = { artifact: Doc<"artifacts">; admission: PageAdmission; collections: PageStateCollection[] };

async function pageFor(ctx: { db: QueryCtx["db"] }, userId: Id<"users">, target: string): Promise<AccountPage | { error: string }> {
  const slug = target.match(/\/a\/([A-Za-z0-9_-]+)/)?.[1] ?? target;
  const bySlug = await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", slug)).first();
  const artifact = bySlug
    ?? await ctx.db.query("artifacts").withIndex("by_user_path", (q) => q.eq("user_id", userId).eq("source_path", target)).first();
  if (!artifact) return { error: `No page matches "${target}" (cast publish ls lists yours)` };
  const admission = await accountAdmission(ctx, artifact, userId);
  if (admission.blocked) return { error: `${artifact.slug} is closed to your account: ${admission.blocked}` };
  const config = await ctx.db.query("page_state_config").withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id)).first();
  return { artifact, admission, collections: (config ? JSON.parse(config.collections_json) : []) as PageStateCollection[] };
}

/** Whether a watcher's account may still read this page's collection (any collection, when none is named). */
export async function watcherMayRead(ctx: { db: QueryCtx["db"] }, artifact: Doc<"artifacts">, userId: Id<"users">, collection: string | undefined): Promise<boolean> {
  const page = await pageFor(ctx, userId, artifact.slug);
  if ("error" in page) return false;
  const readable = page.collections.filter((c) => canRead(page.admission, c));
  return collection ? readable.some((c) => c.id === collection) : readable.length > 0;
}

/** The filter a page_state trigger stores: the page resolved to its id, and the named collections checked against what the account may read. */
export async function watchedPageFilter(ctx: { db: QueryCtx["db"] }, userId: Id<"users">, target: string, collections: string[] | undefined): Promise<{ page_id: string; collections?: string[] }> {
  const page = await pageFor(ctx, userId, target.trim());
  if ("error" in page) throw new Error(page.error);
  if (!page.collections.length) throw new Error(`${page.artifact.slug} declares no state to watch (cast guide publish, Pages as apps)`);
  const readable = page.collections.filter((c) => canRead(page.admission, c)).map((c) => c.id);
  for (const c of collections ?? []) {
    if (!page.collections.some((d) => d.id === c)) throw new Error(`${page.artifact.slug} declares no state collection "${c}" (it has: ${page.collections.map((d) => d.id).join(", ")})`);
    if (!readable.includes(c)) throw new Error(`Your account cannot read "${c}" on ${page.artifact.slug}, so a watch on it would never fire`);
  }
  if (!readable.length) throw new Error(`Your account can read none of ${page.artifact.slug}'s collections`);
  return { page_id: String(page.artifact._id), ...(collections?.length ? { collections } : {}) };
}

/** The calling session's conversation, when the CLI names one of the caller's own: by conversation id (CODECAST_CONVERSATION_ID) or session uuid. */
async function ownSession(ctx: { db: QueryCtx["db"] }, userId: Id<"users">, ref: { conversation_id?: string; session_id?: string }): Promise<Doc<"conversations"> | null> {
  const id = ref.conversation_id ? ctx.db.normalizeId("conversations", ref.conversation_id) : null;
  const conv = id
    ? await ctx.db.get(id)
    : ref.session_id
      ? await ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", ref.session_id)).first()
      : null;
  return conv && conv.user_id === userId ? conv : null;
}

export const accountRead = internalQuery({
  args: { user: v.id("users"), target: v.string(), collection: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const page = await pageFor(ctx, args.user, args.target);
    if ("error" in page) return page;
    const out = [];
    for (const c of page.collections) {
      if (args.collection && c.id !== args.collection) continue;
      const counts = await ctx.db
        .query("page_state_counts")
        .withIndex("by_artifact_collection", (q) => q.eq("artifact_id", page.artifact._id).eq("collection", c.id))
        .first();
      const readable = canRead(page.admission, c);
      const rows = readable
        ? await ctx.db
          .query("page_state")
          .withIndex("by_artifact_collection_key", (q) => q.eq("artifact_id", page.artifact._id).eq("collection", c.id))
          .take(PAGE_STATE_LIMITS.rows)
        : [];
      out.push({ ...c, can_read: readable, can_write: canWrite(page.admission, c), bytes: counts?.bytes ?? 0, rows: await viewRows(ctx, rows, args.user) });
    }
    if (args.collection && !out.length) return { error: `${page.artifact.slug} declares no state collection "${args.collection}"` };
    // This account's own watches, by trigger, so `cast trigger cancel` can stop one.
    const watches = [];
    for (const t of await pageWatchers(ctx, page.artifact._id)) {
      if (t.user_id !== args.user) continue;
      const conv = t.originating_conversation_id ? await ctx.db.get(t.originating_conversation_id) : null;
      watches.push({ trigger: t.short_id ?? String(t._id), status: t.status, collections: t.event_filter?.collections ?? null, session: conv ? String(conv._id).slice(0, 7) : null, session_title: conv?.title ?? null });
    }
    return {
      slug: page.artifact.slug,
      page_id: String(page.artifact._id),
      title: page.artifact.title,
      url: artifactUrl(page.artifact.slug),
      owner: isOwner(page.admission),
      editor: page.admission.editor,
      collections: out,
      watches,
      agents: await agentsOn(ctx, page.artifact._id),
    };
  },
});

export const accountWrite = internalMutation({
  args: { user: v.id("users"), target: v.string(), collection: v.string(), op: vOp, key: v.optional(v.string()), value_json: v.optional(v.string()), session_id: v.optional(v.string()), conversation_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ key?: string; cleared?: number } | { error: string }> => {
    const page = await pageFor(ctx, args.user, args.target);
    if ("error" in page) return page;
    const coll = page.collections.find((c) => c.id === args.collection);
    if (!coll) return { error: `${page.artifact.slug} declares no state collection "${args.collection}"` };
    if (!canWrite(page.admission, coll)) return { error: `"${coll.id}" is written by ${coll.write === "owner" ? "the page's owner" : "the page's editors"} only` };
    const session = await ownSession(ctx, args.user, args);
    return await applyWrite(ctx, page.artifact, coll, { op: args.op, key: args.key, value_json: args.value_json }, {
      editor: page.admission.editor,
      author: args.user,
      ...(session ? { session: session._id } : {}),
      name: session ? `session ${String(session._id).slice(0, 7)} (${session.title || "agent"})` : (page.admission.identity?.name ?? "the page's owner"),
    });
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
    /** The calling agent's session (its conversation id, or its session uuid): its write is stamped with it and wakes it never. */
    session_id: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const user: Id<"users"> | null = await ctx.runQuery(internal.pageState.ownerToken, { api_token: args.api_token });
    if (!user) throw new Error("Unauthorized");
    let wrote: { key?: string; cleared?: number } | { error: string } | undefined;
    if (args.op) {
      if (!args.collection) throw new Error("A write names its collection");
      const w: { key?: string; cleared?: number } | { error: string } = await ctx.runMutation(internal.pageState.accountWrite, { user, target: args.target, collection: args.collection, op: args.op, key: args.key, value_json: args.value_json, session_id: args.session_id, conversation_id: args.conversation_id });
      if ("error" in w) throw new Error(w.error);
      wrote = w;
    }
    const read: any = await ctx.runQuery(internal.pageState.accountRead, { user, target: args.target, collection: args.collection });
    if (read.error) throw new Error(read.error);
    return { ...read, ...(wrote ? { wrote } : {}) };
  },
});

export const ownerToken = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args): Promise<Id<"users"> | null> => (await verifyApiToken(ctx, args.api_token))?.userId ?? null,
});
