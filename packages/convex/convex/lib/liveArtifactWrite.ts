// The one write path for live artifacts (liveArtifacts.ts): validate a batch
// against the product's spec, fold each op onto its element row, stamp every
// write with the next doc revision, checkpoint after quiet spells, and log the
// batch.
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mayEditLive, VIEW_ONLY_MESSAGE, type Caller } from "./liveArtifactAccess";
import { notifyLiveComments, type NewComment } from "../liveComments";
import { scheduleLiveSearch } from "../liveSearch";
import {
  applyOp,
  artifactSpec,
  coalesceOps,
  jsonBytes,
  ARTIFACT_LIMITS,
  opsProblem,
  type ArtifactLayer,
  type ArtifactOp,
  type ElementState,
} from "@codecast/shared/artifacts";

export type Layer = ArtifactLayer | "comments";

/** A write after this much quiet checkpoints the state it rested in. */
const QUIET_CHECKPOINT_MS = 5 * 60_000;
/** Steady editing checkpoints this often, so a long session still leaves history. */
const AUTOSAVE_MS = 10 * 60_000;
/** Rows a draft save or discard handles in one transaction. */
export const DRAFT_ROWS_MAX = 1500;
/** Bytes the open draft may hold: a save reads them and writes them twice, under the 16 MiB transaction budget. */
export const DRAFT_BYTES_MAX = 4 * 1024 * 1024;
/** One op-log record's serialized size, well under Convex's 1 MiB document limit. */
const LOG_RECORD_BYTES = 600 * 1024;

/** Split ops into runs whose JSON stays under `bytes`. */
export function splitByBytes(ops: ArtifactOp[], bytes: number): ArtifactOp[][] {
  const out: ArtifactOp[][] = [];
  let cur: ArtifactOp[] = [];
  let size = 0;
  for (const op of ops) {
    const n = jsonBytes(op) + 1;
    if (cur.length && size + n > bytes) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(op);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function headOf(ctx: any, docId: Id<"docs">): Promise<Doc<"live_heads"> | null> {
  return await ctx.db.query("live_heads").withIndex("by_doc", (q: any) => q.eq("doc_id", docId)).first();
}

/** Whether the head keeps the counts a cached copy is checked against. */
export function tracked(head: Doc<"live_heads"> | null): boolean {
  return !!head && head.rows !== undefined && head.rows >= 0 && head.rev_sum !== undefined;
}

async function stateOf(ctx: any, docId: Id<"docs">, layer: Layer, key: string): Promise<{ row: Doc<"live_elements"> | null; state?: ElementState }> {
  const row = await ctx.db
    .query("live_elements")
    .withIndex("by_doc_layer_key", (q: any) => q.eq("doc_id", docId).eq("layer", layer).eq("key", key))
    .first();
  if (!row || row.dead) return { row, state: undefined };
  return { row, state: { kind: row.kind, fields: row.fields ?? {}, ...(row.deleted ? { deleted: true } : {}) } };
}

function kindsProblem(type: string, layer: Layer, ops: readonly ArtifactOp[]): string | null {
  const allowed = layer === "comments" ? ["comment"] : artifactSpec(type as any).kinds;
  for (const op of ops) {
    if ("put" in op && !allowed.includes(op.put.kind)) {
      return `kind "${op.put.kind}" is not a ${layer === "comments" ? "comment" : type} element (one of: ${allowed.join(", ")})`;
    }
  }
  return null;
}

export async function insertVersion(
  ctx: any,
  docId: Id<"docs">,
  rev: number,
  reason: Doc<"live_versions">["reason"],
  label: string,
  caller: Pick<Caller, "actor" | "name">,
  /** A name the person typed: it wins over whatever label the version at this point has. */
  named = false,
): Promise<Id<"live_versions"> | null> {
  const existing = await ctx.db
    .query("live_versions")
    .withIndex("by_doc_rev", (q: any) => q.eq("doc_id", docId).eq("rev", rev))
    .first();
  if (existing) {
    // A person naming the current version names the one already at this point, whatever made it.
    if (named || (reason !== "auto" && existing.reason === "auto")) await ctx.db.patch(existing._id, { reason: existing.reason === "auto" ? reason : existing.reason, label });
    return existing._id;
  }
  const id = await ctx.db.insert("live_versions", { doc_id: docId, rev, reason, label, by: caller.actor, by_name: caller.name, at: Date.now() });
  const head = await headOf(ctx, docId);
  if (head) await ctx.db.patch(head._id, { last_version_at: Date.now() });
  await ctx.scheduler.runAfter(0, internal.liveArtifacts.snapshotVersion, { version_id: id });
  return id;
}

/** Fields of a comment anyone with access may change: whether its thread is resolved. */
const COMMENT_SHARED_FIELDS = new Set(["resolved"]);
/** Where an ask went and who answered it: written by the server's own follow-up (and `sent_to` by the comment's author), never by another client. */
const COMMENT_ASK_FIELDS = new Set(["sent_to", "answered_at", "answered_by", "answered_by_name"]);

/**
 * Whether this caller may make this change to an existing comment. Its words
 * are its author's: only they edit or delete it (the artifact's owner may
 * delete, to moderate). Resolving, reopening and the ask stamps are anyone's.
 * A comment is never replaced whole.
 */
function commentWriteProblem(state: ElementState, op: ArtifactOp, caller: Caller, doc: Doc<"docs">): string | null {
  const mine = state.fields.author === caller.actor || state.fields.author === `u:${caller.userId}`;
  if ("put" in op) return "A comment can't be replaced; edit or delete it";
  if ("del" in op) return mine || String(doc.user_id) === String(caller.userId) ? null : "Only its author can delete a comment";
  if ("set" in op) {
    for (const f of Object.keys(op.set)) {
      if (COMMENT_SHARED_FIELDS.has(f)) continue;
      if (f === "sent_to" && mine) continue;
      if (COMMENT_ASK_FIELDS.has(f)) return "An ask's state is set by the server";
      if (!mine) return "Only its author can edit a comment";
    }
  }
  return null;
}

type BatchInput = {
  doc: Doc<"docs">;
  layer: Layer;
  ops: ArtifactOp[];
  caller: Caller;
  client_id?: string;
  /** Internal writes (draft save, restore) may exceed the per-batch op limit. */
  unbounded?: boolean;
  /** The server's own follow-up (an ask's stamps): skips the per-comment ownership rules. */
  internal?: boolean;
};

/** The one write path. Returns the revision the batch ended at. */
export async function applyBatchCore(ctx: any, input: BatchInput): Promise<{ rev: number; keys: string[] }> {
  const { doc, layer, caller } = input;
  // A comment's author is whoever wrote it, never what the client claims:
  // stamped on create, and no later edit may change it.
  const ops = coalesceOps(input.ops).map((op): ArtifactOp => {
    if (layer !== "comments") return op;
    if ("put" in op) {
      // "Answered" is the server's to say: a client's own put never carries it.
      const { answered_at: _at, answered_by: _by, answered_by_name: _byName, ...put } = op.put as Record<string, any>;
      return { k: op.k, put: { ...(input.internal ? op.put : put), kind: op.put.kind, author: caller.actor, author_name: caller.name } };
    }
    if ("set" in op) {
      const { author: _a, author_name: _n, ...rest } = op.set;
      return { k: op.k, set: rest };
    }
    return op;
  });
  const problem = input.unbounded ? null : opsProblem(ops);
  if (problem) throw new ConvexError(problem);
  const kindProblem = kindsProblem(doc.doc_type, layer, ops);
  if (kindProblem) throw new ConvexError(kindProblem);

  const now = Date.now();
  let head = await headOf(ctx, doc._id);
  // Comments are open to everyone who can see it; the artifact itself to its editors.
  if (layer !== "comments" && !mayEditLive(doc, head, caller.userId)) {
    throw new ConvexError(VIEW_ONLY_MESSAGE);
  }
  if (!head) {
    const id = await ctx.db.insert("live_heads", { doc_id: doc._id, rev: 0, last_write_at: now, rows: 0, rev_sum: 0 });
    head = (await ctx.db.get(id))!;
  }
  if (layer === "draft" && !head!.draft) {
    await ctx.db.patch(head!._id, { draft: { by: caller.actor, by_name: caller.name, at: now } });
  }
  // A write after a quiet spell checkpoints the state the artifact rested in;
  // steady editing checkpoints every AUTOSAVE_MS of it.
  if (layer === "main" && head!.rev > 0) {
    if (now - head!.last_write_at > QUIET_CHECKPOINT_MS) await insertVersion(ctx, doc._id, head!.rev, "auto", "Before edits", caller);
    else if (now - (head!.last_version_at ?? head!._creationTime) > AUTOSAVE_MS) await insertVersion(ctx, doc._id, head!.rev, "auto", "Autosave", caller);
  }

  const revFrom = head!.rev;
  let rev = revFrom;
  let draftCount = layer === "draft" ? (head!.draft_count ?? 0) : 0;
  let draftBytes = layer === "draft" ? (head!.draft_bytes ?? 0) : 0;
  const written: ArtifactOp[] = [];
  const createdComments: NewComment[] = [];
  let addedRows = 0;
  let revDelta = 0;
  for (const op of ops) {
    const { row, state } = await stateOf(ctx, doc._id, layer, op.k);
    let prev = state;
    // A draft edit of an element the draft has not touched yet starts from main.
    if ((!row || row.dead) && layer === "draft") prev = (await stateOf(ctx, doc._id, "main", op.k)).state;
    if (layer === "comments" && state && !state.deleted && !input.internal) {
      const problem = commentWriteProblem(state, op, caller, doc);
      if (problem) throw new ConvexError(problem);
    }
    if ("set" in op && (!prev || prev.deleted)) continue;
    if ("del" in op && (!prev || prev.deleted) && layer !== "draft") continue;
    const next = applyOp(prev, op);
    if (!next.deleted && jsonBytes(next.fields) > ARTIFACT_LIMITS.elementBytes) throw new ConvexError(`element ${op.k} would be over ${ARTIFACT_LIMITS.elementBytes} bytes`);
    // The draft holds at most DRAFT_ROWS_MAX elements, so it can always be saved or discarded in one go.
    if (layer === "draft") {
      if (!row || row.dead) {
        draftCount += 1;
        if (draftCount > DRAFT_ROWS_MAX) throw new ConvexError(`A draft holds at most ${DRAFT_ROWS_MAX} changed elements; save or discard it first`);
      }
      draftBytes += jsonBytes(next.fields) - (row && !row.dead ? jsonBytes(row.fields ?? {}) : 0);
      if (draftBytes > DRAFT_BYTES_MAX) throw new ConvexError(`A draft holds at most ${DRAFT_BYTES_MAX >> 20} MB; save or discard it first`);
    }
    rev += 1;
    const fields = { kind: next.kind, fields: next.fields, rev, by: caller.actor, at: now, deleted: next.deleted ? true : undefined, dead: undefined };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("live_elements", { doc_id: doc._id, layer, key: op.k, ...fields });
    if (!row || row.dead) addedRows += 1;
    revDelta += rev - (row && !row.dead ? row.rev : 0);
    written.push(op);
    if (layer === "comments" && "put" in op && !state && typeof next.fields.text === "string") {
      createdComments.push({ key: op.k, text: next.fields.text, parent: next.fields.parent as string | undefined, sent_to: next.fields.sent_to as string | undefined });
    }
  }
  if (written.length === 0) return { rev: revFrom, keys: [] };
  // The log holds the batch in records under the document size limit; op i
  // of the batch is revision revFrom + 1 + i, so a record's range follows.
  let start = 0;
  for (const part of splitByBytes(written, LOG_RECORD_BYTES)) {
    await ctx.db.insert("live_batches", {
      doc_id: doc._id,
      layer,
      rev_from: revFrom + 1 + start,
      rev_to: revFrom + start + part.length,
      ops: part,
      actor: caller.actor,
      actor_name: caller.name,
      client_id: input.client_id,
      at: now,
    });
    start += part.length;
  }
  await ctx.db.patch(head!._id, {
    rev,
    last_write_at: now,
    ...(tracked(head) ? { rows: head!.rows! + addedRows, rev_sum: head!.rev_sum! + revDelta } : {}),
    ...(layer === "draft" ? { draft_count: draftCount, draft_bytes: Math.max(0, draftBytes) } : {}),
  });
  if (!tracked(head) && head!.rows !== -1) await ctx.scheduler.runAfter(0, internal.liveArtifacts.countLiveRows, { doc_id: doc._id });
  if (layer !== "comments") await ctx.db.patch(doc._id, { updated_at: now });
  if (layer === "main") await scheduleLiveSearch(ctx, head!, doc._id);
  // Mentions, replies and asks: the follow-up stamps are `set`s, so they create no comments of their own.
  const followUps = await notifyLiveComments(ctx, doc, caller, createdComments);
  if (followUps.length) rev = (await applyBatchCore(ctx, { doc, layer: "comments", ops: followUps, caller, unbounded: true, internal: true })).rev;
  return { rev, keys: written.map((o) => o.k) };
}
