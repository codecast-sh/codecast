// Live artifacts: boards, sheets and dashboards (docs rows of those types)
// whose content is a set of keyed elements, edited at once by people in the
// browser and agent sessions through `cast board|sheet|data`.
//
// One write path: applyBatchCore (lib/liveArtifactWrite.ts). It validates the
// ops against the product's spec, folds each onto the element's stored row
// with @codecast/shared's applyOp, stamps every element write with the next doc
// revision, and logs the batch. Revisions are unique per doc, so a client's live tail is one
// index range ("rows with rev > what I hold") and the first load is the same
// query from 0. Every field converges on the server's arrival order.
//
// Access is the doc's: every entry point resolves the caller (web auth, or the
// CLI's api_token) and runs requireAccessibleDoc.
import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mayEditLive, requireArtifactEditor, requireLiveDoc, resolveCaller, upsertPresence, userName, vCaller, type Caller } from "./lib/liveArtifactAccess";
import { applyBatchCore, DRAFT_BYTES_MAX, DRAFT_ROWS_MAX, headOf, insertVersion, tracked, type Layer } from "./lib/liveArtifactWrite";
import { canAccessDoc } from "./lib/access";
import { liveArtifactValidators } from "./liveArtifactsSchema";
import {
  applyOp,
  chunkOps,
  diffStates,
  foldOps,
  isArtifactDocType,
  jsonBytes,
  specForCli,
  type ArtifactOp,
  type ElementState,
} from "@codecast/shared/artifacts";

const { vLayer, vPosition } = liveArtifactValidators;

/** Rows one elementsSince page returns. */
const PAGE_ROWS = 500;
/** Ops one restore transaction writes (each reads its element row). */
const RESTORE_CHUNK = 400;

// ── Identity ────────────────────────────────────────────────────────────────

// ── Reads ───────────────────────────────────────────────────────────────────

async function requireLiveEdit(ctx: any, doc: Doc<"docs">, userId: Id<"users">) {
  await requireArtifactEditor(ctx, doc, userId);
}

function wireRow(r: Doc<"live_elements">) {
  return {
    doc_id: r.doc_id,
    layer: r.layer,
    key: r.key,
    kind: r.kind,
    fields: r.fields,
    rev: r.rev,
    by: r.by,
    at: r.at,
    ...(r.deleted ? { deleted: true } : {}),
    ...(r.dead ? { dead: true } : {}),
  };
}

function wireDraft(head: Doc<"live_heads"> | null) {
  return head?.draft ? { by: head.draft.by, by_name: head.draft.by_name, at: head.draft.at, label: head.draft.label } : null;
}

/** A chunked restore that has not finished: where it was going, and the state it started from. */
function wireRestoring(head: Doc<"live_heads"> | null) {
  return head?.restoring ?? null;
}

/**
 * Element rows written after `since`, oldest first, with the doc's head. The
 * first load (since 0) and the live tail are the same read; a client keeps
 * the highest rev it holds and asks again from there.
 */
export const elementsSince = query({
  args: { doc_id: v.id("docs"), since: v.number(), ...vCaller },
  handler: async (ctx, args) => {
    let doc: Doc<"docs">;
    let caller: Caller;
    try {
      caller = await resolveCaller(ctx, args);
      doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    } catch {
      return null;
    }
    const rows = await ctx.db
      .query("live_elements")
      .withIndex("by_doc_rev", (q: any) => q.eq("doc_id", args.doc_id).gt("rev", args.since))
      .take(PAGE_ROWS + 1);
    const head = await headOf(ctx, args.doc_id);
    const more = rows.length > PAGE_ROWS;
    const page = more ? rows.slice(0, PAGE_ROWS) : rows;
    return {
      doc_id: args.doc_id,
      title: doc.title,
      doc_type: doc.doc_type,
      head: head?.rev ?? 0,
      draft: wireDraft(head),
      restoring: wireRestoring(head),
      // Who may edit, and whether the caller may.
      edit: head?.edit ?? "team",
      editors: (head?.editors ?? []).map(String),
      can_edit: mayEditLive(doc, head, caller.userId),
      // How many element rows a complete copy of the doc holds; null when unknown.
      total: tracked(head) ? head!.rows : null,
      rev_sum: tracked(head) ? head!.rev_sum : null,
      rows: page.map(wireRow),
      more,
      next: page.length ? page[page.length - 1].rev : args.since,
    };
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

const vOps = v.array(v.any());

/**
 * Write a batch. The web reaches this through the store's applyLiveOps
 * dispatch; the CLI through /cli/live/apply, as its session. A session's
 * write moves its cursor to what it wrote.
 */
export const apply = mutation({
  args: {
    doc_id: v.id("docs"),
    layer: v.optional(vLayer),
    ops: vOps,
    client_id: v.optional(v.string()),
    position: v.optional(vPosition),
    selection: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    ...vCaller,
  },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, args);
    const doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    const result = await applyBatchCore(ctx, { doc, layer: args.layer ?? "main", ops: args.ops as ArtifactOp[], caller, client_id: args.client_id });
    if (caller.kind === "agent") {
      await upsertPresence(ctx, doc._id, caller, caller.actor, {
        position: args.position,
        selection: args.selection ?? result.keys.slice(-50),
        status: args.status ?? "editing",
      });
    }
    return result;
  },
});

/** The web's write, run by the dispatch side effect `applyLiveOps` as the signed-in person. */
export async function applyAsWebUser(ctx: any, userId: Id<"users">, docId: string, layer: Layer, ops: ArtifactOp[], clientId?: string) {
  const id = ctx.db.normalizeId("docs", docId);
  if (!id) return null;
  const user = await ctx.db.get(userId);
  const caller: Caller = { userId, actor: `u:${userId}`, name: userName(user), kind: "person" };
  const doc = await requireLiveDoc(ctx, userId, id);
  return await applyBatchCore(ctx, { doc, layer, ops, caller, client_id: clientId });
}

// ── Presence ────────────────────────────────────────────────────────────────

// ── Drafts ──────────────────────────────────────────────────────────────────

async function draftRows(ctx: any, docId: Id<"docs">): Promise<Doc<"live_elements">[]> {
  const rows = await ctx.db
    .query("live_elements")
    .withIndex("by_doc_layer_dead_key", (q: any) => q.eq("doc_id", docId).eq("layer", "draft").eq("dead", undefined))
    .take(DRAFT_ROWS_MAX + 1);
  if (rows.length > DRAFT_ROWS_MAX) throw new ConvexError(`A draft holds at most ${DRAFT_ROWS_MAX} changed elements`);
  return rows;
}

/** Retire every draft row (each gets a revision so clients drop it) and clear the head's draft. */
async function retireDraft(ctx: any, docId: Id<"docs">, rows: Doc<"live_elements">[]) {
  const head = (await headOf(ctx, docId))!;
  let rev = head.rev;
  const now = Date.now();
  for (const r of rows) {
    rev += 1;
    await ctx.db.patch(r._id, { dead: true, rev, at: now });
  }
  const retiredRevs = rows.reduce((n, r) => n + r.rev, 0);
  await ctx.db.patch(head._id, {
    rev, draft: undefined, draft_count: 0, draft_bytes: 0,
    ...(tracked(head) ? { rows: Math.max(0, head.rows! - rows.length), rev_sum: head.rev_sum! - retiredRevs } : {}),
  });
}

/** Rows countLiveRows counts in one transaction; a bigger doc keeps no count (-1) and every open reads it whole. */
const COUNT_ROWS_MAX = 4000;

/**
 * Fill in a head's row count, in one transaction so no write can slip between
 * the read and the stamp. Scheduled by the first write to a head without one.
 */
export const countLiveRows = internalMutation({
  args: { doc_id: v.id("docs") },
  handler: async (ctx, args) => {
    const head = await headOf(ctx, args.doc_id);
    if (!head || tracked(head) || head.rows === -1) return;
    const rows = await ctx.db.query("live_elements").withIndex("by_doc_rev", (q: any) => q.eq("doc_id", args.doc_id)).take(COUNT_ROWS_MAX + 1);
    // -1: too big to count; its writes stop asking and every open reads it whole.
    if (rows.length > COUNT_ROWS_MAX) return void (await ctx.db.patch(head._id, { rows: -1 }));
    const live = rows.filter((r) => !r.dead);
    await ctx.db.patch(head._id, { rows: live.length, rev_sum: live.reduce((n, r) => n + r.rev, 0) });
  },
});

export const draftStart = mutation({
  args: { doc_id: v.id("docs"), label: v.optional(v.string()), ...vCaller },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, args);
    const doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    await requireLiveEdit(ctx, doc, caller.userId);
    let head = await headOf(ctx, doc._id);
    const draft = { by: caller.actor, by_name: caller.name, at: Date.now(), label: args.label?.slice(0, 120) };
    if (!head) await ctx.db.insert("live_heads", { doc_id: doc._id, rev: 0, last_write_at: Date.now(), draft, rows: 0, rev_sum: 0 });
    else if (!head.draft) await ctx.db.patch(head._id, { draft });
    head = await headOf(ctx, doc._id);
    return wireDraft(head);
  },
});

/** Fold the draft onto the artifact as one write, checkpointed before and after. */
export const draftSave = mutation({
  // draft_at names the draft the caller saw: a retried or late request for a
  // draft that has since closed (and maybe been replaced) does nothing.
  args: { doc_id: v.id("docs"), draft_at: v.optional(v.number()), ...vCaller },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, args);
    const doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    await requireLiveEdit(ctx, doc, caller.userId);
    const head = await headOf(ctx, doc._id);
    if (!head?.draft) return { saved: 0 };
    if (args.draft_at !== undefined && head.draft.at !== args.draft_at) return { saved: 0, stale: true };
    const rows = await draftRows(ctx, doc._id);
    const ops: ArtifactOp[] = rows.map((r) => (r.deleted ? { k: r.key, del: true as const } : { k: r.key, put: { kind: r.kind, ...(r.fields ?? {}) } }));
    if (head.rev > 0) await insertVersion(ctx, doc._id, head.rev, "manual", "Before draft", caller);
    const result = ops.length ? await applyBatchCore(ctx, { doc, layer: "main", ops, caller, unbounded: true }) : { rev: head.rev };
    await retireDraft(ctx, doc._id, rows);
    await insertVersion(ctx, doc._id, result.rev, "draft_saved", head.draft.label ? `Draft saved: ${head.draft.label}` : "Draft saved", caller);
    return { saved: ops.length, rev: result.rev };
  },
});

export const draftDiscard = mutation({
  // draft_at names the draft the caller saw: a retried or late request for a
  // draft that has since closed (and maybe been replaced) does nothing.
  args: { doc_id: v.id("docs"), draft_at: v.optional(v.number()), ...vCaller },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, args);
    const doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    await requireLiveEdit(ctx, doc, caller.userId);
    const head = await headOf(ctx, doc._id);
    if (!head?.draft) return { discarded: 0 };
    if (args.draft_at !== undefined && head.draft.at !== args.draft_at) return { discarded: 0, stale: true };
    const rows = await draftRows(ctx, doc._id);
    await retireDraft(ctx, doc._id, rows);
    return { discarded: rows.length };
  },
});

// ── History ─────────────────────────────────────────────────────────────────

export const versions = query({
  args: { doc_id: v.id("docs"), ...vCaller },
  handler: async (ctx, args) => {
    try {
      const caller = await resolveCaller(ctx, args);
      await requireLiveDoc(ctx, caller.userId, args.doc_id);
    } catch {
      return null;
    }
    const head = await headOf(ctx, args.doc_id);
    const rows = await ctx.db
      .query("live_versions")
      .withIndex("by_doc_rev", (q: any) => q.eq("doc_id", args.doc_id))
      .order("desc")
      .take(100);
    return {
      doc_id: args.doc_id,
      head: head?.rev ?? 0,
      versions: rows.map((r) => ({ _id: r._id, doc_id: r.doc_id, rev: r.rev, label: r.label, reason: r.reason, by: r.by, by_name: r.by_name, at: r.at, elements: r.elements })),
    };
  },
});

export const checkpoint = mutation({
  args: { doc_id: v.id("docs"), label: v.optional(v.string()), ...vCaller },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, args);
    const doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    await requireLiveEdit(ctx, doc, caller.userId);
    const head = await headOf(ctx, doc._id);
    const rev = head?.rev ?? 0;
    await insertVersion(ctx, doc._id, rev, "manual", (args.label || "Saved version").slice(0, 120), caller, !!args.label?.trim());
    return { rev };
  },
});

/**
 * Who may change the artifact: "team" (everyone who can open it) or "owners"
 * (its owner plus `editors`, each of whom must be able to open it). Only the
 * owner sets it.
 */
export const setEditAccess = mutation({
  args: { doc_id: v.id("docs"), edit: v.union(v.literal("team"), v.literal("owners")), editors: v.optional(v.array(v.id("users"))) },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, {});
    const doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    // Its owner sets it, or an admin of its team (so a board is never locked for good when its owner leaves).
    if (String(doc.user_id) !== String(caller.userId) && !(await isTeamAdminOf(ctx, doc, caller.userId))) {
      throw new ConvexError("Only the artifact's owner or a team admin can change who edits it");
    }
    const editors: Id<"users">[] = [];
    for (const id of [...new Set((args.editors ?? []).map(String))].slice(0, 50)) {
      const uid = id as Id<"users">;
      if (uid === doc.user_id) continue;
      if (!(await canAccessDoc(ctx, uid, doc))) throw new ConvexError("That person can't open this artifact, so they can't edit it");
      editors.push(uid);
    }
    let head = await headOf(ctx, doc._id);
    if (!head) {
      const id = await ctx.db.insert("live_heads", { doc_id: doc._id, rev: 0, last_write_at: Date.now(), rows: 0, rev_sum: 0 });
      head = (await ctx.db.get(id))!;
    }
    // Every open page's feed reads the head, so it learns at once.
    await ctx.db.patch(head!._id, { edit: args.edit, editors });
    return { edit: args.edit, editors: editors.map(String) };
  },
});

/**
 * Who the owner can name as an editor: the people of the artifact's own team
 * (not the team the owner is looking at), who can open it. Owner only; empty
 * for a personal artifact.
 */
export const editorCandidates = query({
  args: { doc_id: v.id("docs") },
  handler: async (ctx, args) => {
    let caller: Caller;
    let doc: Doc<"docs">;
    try {
      caller = await resolveCaller(ctx, {});
      doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    } catch {
      return [];
    }
    if (String(doc.user_id) !== String(caller.userId)) return [];
    const ws = String(doc.workspace ?? "");
    if (!ws.startsWith("team:")) return [];
    const teamId = ws.slice(5) as Id<"teams">;
    const memberships = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).take(200);
    const out: Array<{ _id: string; name: string; image?: string }> = [];
    for (const m of memberships) {
      if (String(m.user_id) === String(doc.user_id)) continue;
      const u = await ctx.db.get(m.user_id);
      if (!u || (u as any).is_bot) continue;
      out.push({ _id: String(u._id), name: userName(u), ...(u.image ? { image: u.image } : {}) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

async function isTeamAdminOf(ctx: any, doc: Doc<"docs">, userId: Id<"users">): Promise<boolean> {
  const ws = String(doc.workspace ?? "");
  if (!ws.startsWith("team:")) return false;
  const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", ws.slice(5))).first();
  return m?.role === "admin";
}

/** A viewer asks the owner to let them edit: a notification to the owner that opens the artifact. */
export const askToEdit = mutation({
  args: { doc_id: v.id("docs") },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, {});
    const doc = await requireLiveDoc(ctx, caller.userId, args.doc_id);
    if (mayEditLive(doc, await headOf(ctx, doc._id), caller.userId)) return { asked: false };
    await ctx.runMutation(internal.notificationRouter.emit, {
      event_type: "mention",
      actor_user_id: caller.userId,
      entity_type: "doc",
      entity_id: String(doc._id),
      message: `${caller.name} asks to edit "${doc.title || "Untitled"}"`,
      link: `/docs/${doc._id}`,
      direct_recipient_id: doc.user_id,
    });
    return { asked: true };
  },
});

/** The caller, checked against the doc, for an action (actions have no db). */
export const callerForAction = internalQuery({
  args: { doc_id: v.id("docs"), ...vCaller },
  handler: async (ctx, args) => {
    const caller = await resolveCaller(ctx, args);
    await requireLiveDoc(ctx, caller.userId, args.doc_id);
    return { userId: caller.userId, actor: caller.actor, name: caller.name, kind: caller.kind };
  },
});

/** The newest checkpoint at or before `rev` that has its snapshot written. */
export const snapshotBase = internalQuery({
  args: { doc_id: v.id("docs"), rev: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("live_versions")
      .withIndex("by_doc_rev", (q: any) => q.eq("doc_id", args.doc_id).lte("rev", args.rev))
      .order("desc")
      .take(20);
    const base = rows.find((r) => r.snapshot);
    return base ? { rev: base.rev, snapshot: base.snapshot! } : null;
  },
});

/** Log records with rev_to past `after`, oldest first: up to 200, or about 4 MB, whichever comes first. */
export const batchesPage = internalQuery({
  args: { doc_id: v.id("docs"), after: v.number() },
  handler: async (ctx, args) => {
    const out: Array<{ layer: string; rev_from: number; rev_to: number; ops: any }> = [];
    let bytes = 0;
    const q = ctx.db.query("live_batches").withIndex("by_doc_rev", (q: any) => q.eq("doc_id", args.doc_id).gt("rev_to", args.after));
    for await (const r of q) {
      out.push({ layer: r.layer, rev_from: r.rev_from, rev_to: r.rev_to, ops: r.ops });
      bytes += jsonBytes(r.ops);
      if (out.length >= 200 || bytes > 4 * 1024 * 1024) return { rows: out, more: true };
    }
    return { rows: out, more: false };
  },
});

/** The current main layer in key order, up to 1000 rows or about 4 MB a page. */
export const mainPage = internalQuery({
  args: { doc_id: v.id("docs"), after_key: v.string() },
  handler: async (ctx, args) => {
    const rows: Array<{ key: string; kind: string; fields: any; deleted: boolean }> = [];
    let bytes = 0;
    const q = ctx.db.query("live_elements").withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", args.doc_id).eq("layer", "main").gt("key", args.after_key));
    for await (const r of q) {
      rows.push({ key: r.key, kind: r.kind, fields: r.fields, deleted: !!r.deleted });
      bytes += jsonBytes(r.fields ?? {});
      if (rows.length >= 1000 || bytes > 4 * 1024 * 1024) return { rows, more: true };
    }
    return { rows, more: false };
  },
});

type SnapshotEntry = [string, ElementState];

/** Fold the main layer's state at `rev`: the nearest snapshot, then the batches after it. */
async function stateAtRev(ctx: any, docId: Id<"docs">, rev: number): Promise<Map<string, ElementState>> {
  const base = await ctx.runQuery(internal.liveArtifacts.snapshotBase, { doc_id: docId, rev });
  const state = new Map<string, ElementState>();
  let after = 0;
  if (base) {
    const blob = await ctx.storage.get(base.snapshot);
    if (blob) {
      for (const [k, s] of JSON.parse(await blob.text()) as SnapshotEntry[]) state.set(k, s);
      after = base.rev;
    }
  }
  // A record straddling `rev` contributes only the ops at or before it (op i is revision rev_from + i).
  outer: for (;;) {
    const { rows: page, more } = await ctx.runQuery(internal.liveArtifacts.batchesPage, { doc_id: docId, after });
    for (const b of page) {
      if (b.rev_from > rev) break outer;
      const ops = (b.ops as ArtifactOp[]).slice(0, rev - b.rev_from + 1);
      if (b.layer === "main") foldOps(state, ops);
      after = b.rev_to;
      if (b.rev_to >= rev) break outer;
    }
    if (!more) break;
  }
  for (const [k, s] of state) if (s.deleted) state.delete(k);
  return state;
}

export const snapshotVersion = internalAction({
  args: { version_id: v.id("live_versions") },
  handler: async (ctx, args) => {
    const version = await ctx.runQuery(internal.liveArtifacts.versionRow, { version_id: args.version_id });
    if (!version || version.snapshot) return;
    const state = await stateAtRev(ctx, version.doc_id, version.rev);
    const snapshot = await ctx.storage.store(new Blob([JSON.stringify([...state.entries()])], { type: "application/json" }));
    await ctx.runMutation(internal.liveArtifacts.setVersionSnapshot, { version_id: args.version_id, snapshot, elements: state.size });
  },
});

export const versionRow = internalQuery({
  args: { version_id: v.id("live_versions") },
  handler: async (ctx, args) => await ctx.db.get(args.version_id),
});

export const setVersionSnapshot = internalMutation({
  args: { version_id: v.id("live_versions"), snapshot: v.id("_storage"), elements: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.version_id);
    if (!row) {
      await ctx.storage.delete(args.snapshot);
      return;
    }
    await ctx.db.patch(args.version_id, { snapshot: args.snapshot, elements: args.elements });
  },
});

/** The artifact as it was at `rev`: elements in key order. Opening a version reads this. */
export const stateAt = action({
  args: { doc_id: v.id("docs"), rev: v.number(), ...vCaller },
  handler: async (ctx, args): Promise<Array<{ key: string; kind: string; fields: any }>> => {
    await ctx.runQuery(internal.liveArtifacts.callerForAction, { doc_id: args.doc_id, api_token: args.api_token, session_id: args.session_id });
    const state = await stateAtRev(ctx, args.doc_id, args.rev);
    return [...state.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, s]) => ({ key, kind: s.kind, fields: s.fields }));
  },
});

/**
 * Put the artifact back to how it was at `rev`. The current state is
 * checkpointed first ("Before restore"), then the difference is written as
 * ordinary batches: the restore syncs to every open page and can itself be
 * restored away. The diff is computed against the head it read; if a write
 * lands before the first batch, the restore starts over.
 *
 * A restore that fits one transaction (RESTORE_ATOMIC_OPS) is one mutation:
 * it lands whole or not at all. A bigger one runs in chunks under a marker on
 * the head (`restoring`), which every open page shows. If a chunk fails, the
 * action puts the artifact back to the "Before restore" state; if even that
 * cannot finish (or the action dies), the marker stays and the page offers to
 * finish the restore or undo it, both of which are this same action.
 */
export const restore = action({
  args: { doc_id: v.id("docs"), rev: v.number(), ...vCaller },
  handler: async (ctx, args): Promise<{ changed: number; rev: number }> => {
    const caller: RestoreCaller = await ctx.runQuery(internal.liveArtifacts.callerForAction, {
      doc_id: args.doc_id, api_token: args.api_token, session_id: args.session_id,
    });
    const r = await restoreTo(ctx, args.doc_id, args.rev, caller);
    if (r.ok) return { changed: r.changed, rev: r.rev };
    // A chunk failed partway: put back what was there before the restore began.
    if (r.before !== undefined) {
      const back = await restoreTo(ctx, args.doc_id, r.before, caller, "Undid a restore that stopped partway").catch(() => null);
      if (back?.ok) throw new ConvexError(`The restore to r${args.rev} failed partway and was undone; nothing changed`);
    }
    throw new ConvexError(`The restore to r${args.rev} stopped partway; finish or undo it from History`);
  },
});

type RestoreCaller = { userId: Id<"users">; actor: string; name: string; kind: "person" | "agent" };
type RestoreOutcome = { ok: true; changed: number; rev: number } | { ok: false; before?: number };

/** Ops one restore transaction may write and still land whole. */
const RESTORE_ATOMIC_OPS = DRAFT_ROWS_MAX;
const RESTORE_ATOMIC_BYTES = DRAFT_BYTES_MAX;

async function readMain(ctx: any, docId: Id<"docs">): Promise<Map<string, ElementState>> {
  const current = new Map<string, ElementState>();
  let afterKey = "";
  for (;;) {
    const { rows: page, more } = await ctx.runQuery(internal.liveArtifacts.mainPage, { doc_id: docId, after_key: afterKey });
    for (const r of page) if (!r.deleted) current.set(r.key, { kind: r.kind, fields: r.fields ?? {} });
    if (!more || page.length === 0) break;
    afterKey = page[page.length - 1].key;
  }
  return current;
}

/** The restore loop, shared by a restore and the undo of a failed one. */
async function restoreTo(ctx: any, docId: Id<"docs">, rev: number, caller: RestoreCaller, label?: string): Promise<RestoreOutcome> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const head: number = await ctx.runQuery(internal.liveArtifacts.headRev, { doc_id: docId });
    if (rev > head) throw new ConvexError(`r${rev} is past the artifact's head (r${head})`);
    const target = await stateAtRev(ctx, docId, rev);
    const ops = diffStates(await readMain(ctx, docId), target);
    const atomic = chunkOps(ops, RESTORE_ATOMIC_OPS, RESTORE_ATOMIC_BYTES).length <= 1;
    const chunks = ops.length === 0 ? [[]] : atomic ? [ops] : chunkOps(ops, RESTORE_CHUNK);
    let last = { rev: head };
    let started = false;
    let raced = false;
    for (let i = 0; i < chunks.length; i++) {
      // Every batch expects the head the previous one left: a write before the
      // first starts the restore over, re-diffed against what is there now.
      let r: { rev: number } | null;
      try {
        r = await ctx.runMutation(internal.liveArtifacts.applyRestore, {
          doc_id: docId, rev, label, ops: chunks[i], caller, expect_head: last.rev, first: i === 0, last: i === chunks.length - 1, chunked: chunks.length > 1,
        });
      } catch (e) {
        if (!started) throw e;
        return { ok: false, before: head };
      }
      if (!r) {
        // A write landed mid-way through a chunked restore: re-diff and go on from where it is.
        raced = true;
        break;
      }
      started = true;
      last = r;
    }
    if (!raced) return { ok: true, changed: ops.length, rev: last.rev };
  }
  throw new ConvexError("The artifact kept changing during the restore; try again");
}

/** How History names a restore: after the version restored, by its name, else by when it was taken. */
async function restoredLabel(ctx: any, docId: Id<"docs">, rev: number): Promise<string> {
  const v = await ctx.db.query("live_versions").withIndex("by_doc_rev", (q: any) => q.eq("doc_id", docId).eq("rev", rev)).first();
  // The restored version's own name; History shows when it was taken beside it, in the reader's time.
  return v ? `Restored "${v.label}"` : "Restored an earlier version";
}

export const headRev = internalQuery({
  args: { doc_id: v.id("docs") },
  handler: async (ctx, args): Promise<number> => (await headOf(ctx, args.doc_id))?.rev ?? 0,
});

/**
 * One restore batch. Returns null if a write landed since the caller read the
 * head. The first batch checkpoints "Before restore" and, for a chunked
 * restore, marks the head as restoring; the last clears it.
 */
export const applyRestore = internalMutation({
  args: {
    doc_id: v.id("docs"),
    rev: v.number(),
    label: v.optional(v.string()),
    ops: v.array(v.any()),
    expect_head: v.number(),
    first: v.boolean(),
    last: v.boolean(),
    chunked: v.optional(v.boolean()),
    caller: v.object({ userId: v.id("users"), actor: v.string(), name: v.string(), kind: v.union(v.literal("person"), v.literal("agent")) }),
  },
  handler: async (ctx, args): Promise<{ rev: number } | null> => {
    const doc = await requireLiveDoc(ctx, args.caller.userId, args.doc_id);
    // Checked here too: a restore with nothing to change writes no ops, but still records versions.
    await requireLiveEdit(ctx, doc, args.caller.userId);
    const head = await headOf(ctx, doc._id);
    const caller: Caller = { ...args.caller };
    if ((head?.rev ?? 0) !== args.expect_head) return null;
    // Finishing or undoing a restore that stopped partway already has its "Before restore".
    if (args.first && head && head.rev > 0 && !head.restoring) await insertVersion(ctx, doc._id, head.rev, "manual", "Before restore", caller);
    if (args.first && args.chunked && head) {
      await ctx.db.patch(head._id, { restoring: head.restoring ?? { to: args.rev, from: head.rev, by: caller.actor, by_name: caller.name, at: Date.now() } });
    }
    const result = args.ops.length ? await applyBatchCore(ctx, { doc, layer: "main", ops: args.ops as ArtifactOp[], caller, unbounded: true }) : { rev: head?.rev ?? 0 };
    if (args.last) {
      await insertVersion(ctx, doc._id, result.rev, "restore", args.label ?? (await restoredLabel(ctx, doc._id, args.rev)), caller);
      const after = await headOf(ctx, doc._id);
      if (after?.restoring) await ctx.db.patch(after._id, { restoring: undefined });
    }
    return { rev: result.rev };
  },
});

// ── Helpers for product convex code ─────────────────────────────────────────

/**
 * A doc's current elements, without tombstones: the main layer, the draft
 * layer alone, or main with the draft laid over it. Callers check access.
 */
export async function readLiveElements(
  ctx: any,
  docId: Id<"docs">,
  layer: "main" | "draft" | "merged",
): Promise<Array<Record<string, any> & { key: string; kind: string; rev: number }>> {
  const read = async (l: "main" | "draft") =>
    (await ctx.db
      .query("live_elements")
      .withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", docId).eq("layer", l))
      .collect()) as Doc<"live_elements">[];
  const byKey = new Map<string, Doc<"live_elements">>();
  if (layer !== "draft") for (const r of await read("main")) byKey.set(r.key, r);
  if (layer !== "main") for (const r of await read("draft")) if (!r.dead) byKey.set(r.key, r);
  return [...byKey.values()]
    .filter((r) => !r.deleted && !r.dead)
    .map((r) => ({ ...(r.fields ?? {}), key: r.key, kind: r.kind, rev: r.rev, by: r.by, at: r.at }));
}

// ── Remote product verbs (`cast data query ...`) ────────────────────────────

/** Resolve and check a remote verb's caller; the route runs the action after. */
export const remoteCaller = internalQuery({
  args: { cli: v.string(), verb: v.string(), doc_id: v.optional(v.string()), ...vCaller },
  handler: async (ctx, args) => {
    const spec = specForCli(args.cli);
    const verb = spec?.remote?.[args.verb];
    if (!spec || !verb) throw new ConvexError(`cast ${args.cli} has no verb "${args.verb}"`);
    const caller = await resolveCaller(ctx, args);
    let docId: Id<"docs"> | undefined;
    if (args.doc_id) {
      const id = ctx.db.normalizeId("docs", args.doc_id);
      if (!id) throw new ConvexError(`${args.doc_id} is not a doc id`);
      const doc = await requireLiveDoc(ctx, caller.userId, id);
      if (doc.doc_type !== spec.type) throw new ConvexError(`${doc.title} is a ${doc.doc_type}, not a ${spec.type}`);
      docId = id;
    } else if (verb.needsDoc) {
      throw new ConvexError(`usage: cast ${args.cli} ${verb.usage}`);
    }
    return { action: verb.action, user_id: caller.userId, actor: caller.actor, actor_name: caller.name, doc_id: docId };
  },
});

export const runRemote = action({
  args: { cli: v.string(), verb: v.string(), doc_id: v.optional(v.string()), args: v.array(v.string()), stdin: v.optional(v.string()), ...vCaller },
  handler: async (ctx, args): Promise<{ text?: string; json?: any }> => {
    const c: { action: string; user_id: Id<"users">; actor: string; actor_name: string; doc_id?: Id<"docs"> } = await ctx.runQuery(internal.liveArtifacts.remoteCaller, {
      cli: args.cli, verb: args.verb, doc_id: args.doc_id, api_token: args.api_token, session_id: args.session_id,
    });
    const ref = makeFunctionReference<"action">(c.action) as any;
    return await ctx.runAction(ref, {
      user_id: c.user_id, actor: c.actor, actor_name: c.actor_name,
      ...(c.doc_id ? { doc_id: c.doc_id } : {}), args: args.args, ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
    });
  },
});

// ── Shared link (read only) ─────────────────────────────────────────────────

const SHARED_ELEMENTS_MAX = 5000;

/**
 * A shared artifact as anyone holding its link sees it: the saved (main)
 * layer only, never the draft, comments or who is in it. Null when the token
 * names nothing or names a doc that is not a board, sheet or dashboard.
 */
export const sharedElements = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    if (!args.share_token) return null;
    const doc = await ctx.db.query("docs").withIndex("by_share_token", (q: any) => q.eq("share_token", args.share_token)).first();
    if (!doc || !isArtifactDocType(doc.doc_type) || doc.archived_at) return null;
    const rows = await ctx.db
      .query("live_elements")
      .withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", doc._id).eq("layer", "main"))
      .take(SHARED_ELEMENTS_MAX);
    const user = await ctx.db.get(doc.user_id);
    return {
      doc: { _id: doc._id, title: doc.title, doc_type: doc.doc_type, updated_at: doc.updated_at, user: user ? { name: user.name, image: user.image } : null },
      elements: rows.filter((r) => !r.deleted).map((r) => ({ ...(r.fields ?? {}), key: r.key, kind: r.kind, rev: r.rev })),
      truncated: rows.length >= SHARED_ELEMENTS_MAX,
    };
  },
});
