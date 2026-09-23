// A file change's text lives apart from its index row.
//
// Convex reads whole documents and caps one function at 16 MiB read and 16 MiB
// returned. With whole-file writes stored inline, one long session's
// file_changes rows reached 26 MiB, so every query over them failed and the
// conversation page fell into its error boundary. The index row now carries
// only sizes; the text sits in file_change_bodies under the same
// (conversation_id, change_key) and is read by key, a few changes at a time.
//
// Readers accept a legacy row that still carries its text inline, so nothing
// waits on `migrate` finishing.
import { v } from "convex/values";
import { internalMutation, type MutationCtx, type QueryCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { withBody, type FileChange, type FileChangeBody, type FileChangeRef } from "./fileChanges/extractor";
import { selectFoldInputs } from "@codecast/shared/diff";

type ReadCtx = { db: QueryCtx["db"] };

/** Newest index rows one read returns. A session past this keeps its recent
 *  changes, the ones the diff panel opens on. */
export const FILE_CHANGE_INDEX_LIMIT = 10_000;
/** Text bytes one function reads or returns for bodies. Leaves the rest of
 *  the 16 MiB caps to the payload around them. */
export const FILE_CHANGE_BODY_BUDGET = 6 * 1024 * 1024;
/** Keys one bodies query accepts. The web batches under the byte budget
 *  itself; this bounds the index lookups. */
export const FILE_CHANGE_BODY_KEYS_LIMIT = 200;

export function fileChangeRef(row: Doc<"file_changes">, sequenceIndex: number): FileChangeRef {
  return {
    id: row.change_key,
    toolCallId: row.tool_call_id,
    sequenceIndex,
    messageId: row.message_id,
    filePath: row.file_path,
    changeType: row.change_type,
    oldBytes: row.old_bytes ?? (row.old_content === undefined ? undefined : row.old_content.length),
    newBytes: row.new_bytes ?? row.new_content?.length ?? 0,
    commitMessage: row.commit_message,
    commitHash: row.commit_hash,
    timestamp: row.timestamp,
  };
}

/** Every change of a conversation, without text, in extractor order. */
export async function readFileChangeIndex(
  ctx: ReadCtx,
  conversationId: Id<"conversations">,
): Promise<FileChangeRef[]> {
  const rows = await ctx.db
    .query("file_changes")
    .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId))
    .order("desc")
    .take(FILE_CHANGE_INDEX_LIMIT);
  // Re-synced messages can leave duplicate rows; the newest wins. Then order
  // by (timestamp, in-message seq) to match the client extractor.
  const byKey = new Map<string, Doc<"file_changes">>();
  for (const row of rows) if (!byKey.has(row.change_key)) byKey.set(row.change_key, row);
  return Array.from(byKey.values())
    .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq)
    .map((row, i) => fileChangeRef(row, i));
}

function bodyOf(row: { old_content?: string; new_content?: string } | null | undefined): FileChangeBody | null {
  if (row?.new_content === undefined) return null;
  return { oldContent: row.old_content, newContent: row.new_content };
}

/** One change's text: its index row's legacy inline copy when the caller
 *  holds the row, else the body row, else the index row looked up by key. */
export async function readFileChangeBody(
  ctx: ReadCtx,
  conversationId: Id<"conversations">,
  changeKey: string,
  indexRow?: Doc<"file_changes"> | null,
): Promise<FileChangeBody | null> {
  const inline = bodyOf(indexRow);
  if (inline) return inline;
  const bodyRow = await ctx.db
    .query("file_change_bodies")
    .withIndex("by_conversation_change_key", (q) =>
      q.eq("conversation_id", conversationId).eq("change_key", changeKey))
    .first();
  if (bodyRow) return bodyOf(bodyRow);
  if (indexRow !== undefined) return null;
  const row = await ctx.db
    .query("file_changes")
    .withIndex("by_conversation_change_key", (q) =>
      q.eq("conversation_id", conversationId).eq("change_key", changeKey))
    .first();
  return bodyOf(row);
}

export function bodyBytes(body: FileChangeBody): number {
  return (body.oldContent?.length ?? 0) + body.newContent.length;
}

/** Bodies for `keys` in order, stopping before the budget; `truncated` tells
 *  the caller to ask again for the rest. */
export async function readFileChangeBodies(
  ctx: ReadCtx,
  conversationId: Id<"conversations">,
  keys: string[],
  budget = FILE_CHANGE_BODY_BUDGET,
): Promise<{ bodies: Map<string, FileChangeBody>; truncated: boolean }> {
  const bodies = new Map<string, FileChangeBody>();
  let bytes = 0;
  for (const key of keys) {
    if (bodies.has(key)) continue;
    const body = await readFileChangeBody(ctx, conversationId, key);
    if (!body) continue;
    const size = bodyBytes(body);
    if (bodies.size > 0 && bytes + size > budget) return { bodies, truncated: true };
    bodies.set(key, body);
    bytes += size;
  }
  return { bodies, truncated: false };
}

/**
 * The changes a fold of the whole conversation reads, with their text, plus
 * every commit row. Same fold result as the full history at a fraction of
 * the bytes (shared/diff selectFoldInputs); `cast diff` and the web build
 * that predates the split consume this. `truncated` means the budget cut
 * some bodies and the tree is missing files.
 */
export async function readFoldChanges(
  ctx: ReadCtx,
  conversationId: Id<"conversations">,
  budget = FILE_CHANGE_BODY_BUDGET,
): Promise<{ changes: FileChange[]; truncated: boolean }> {
  const index = await readFileChangeIndex(ctx, conversationId);
  const inputs = selectFoldInputs(index, null);
  const { bodies, truncated } = await readFileChangeBodies(ctx, conversationId, inputs.map((c) => c.id), budget);
  const changes: FileChange[] = [];
  for (const ref of index) {
    if (ref.changeType === "commit") {
      changes.push(withBody(ref, { newContent: "" }));
      continue;
    }
    const body = bodies.get(ref.id);
    if (body) changes.push(withBody(ref, body));
  }
  return { changes, truncated };
}

export type FileChangeFields = Omit<
  Doc<"file_changes">,
  "_id" | "_creationTime" | "old_content" | "new_content" | "old_bytes" | "new_bytes"
>;

/**
 * Insert or refresh one change: the index row without text, the text in its
 * body row. `existing` is the index row already found under this change_key,
 * or null. Every materializer (message ingest, the shell-change sync, the
 * blame backfills) writes through here so the two tables cannot drift.
 */
export async function writeFileChange(
  ctx: MutationCtx,
  existing: Doc<"file_changes"> | null,
  fields: FileChangeFields,
  body: FileChangeBody,
): Promise<void> {
  const meta = {
    ...fields,
    old_bytes: body.oldContent === undefined ? undefined : body.oldContent.length,
    new_bytes: body.newContent.length,
  };
  if (!existing) {
    await ctx.db.insert("file_changes", meta);
  } else {
    const changed =
      (Object.keys(meta) as Array<keyof typeof meta>).some((key) => existing[key] !== meta[key]) ||
      existing.new_content !== undefined;
    // A legacy row still carrying its text loses it here; the body row below
    // takes over.
    if (changed) await ctx.db.patch(existing._id, { ...meta, old_content: undefined, new_content: undefined });
  }
  const bodyRow = await ctx.db
    .query("file_change_bodies")
    .withIndex("by_conversation_change_key", (q) =>
      q.eq("conversation_id", fields.conversation_id).eq("change_key", fields.change_key))
    .first();
  const text = { old_content: body.oldContent, new_content: body.newContent };
  if (!bodyRow) {
    await ctx.db.insert("file_change_bodies", { conversation_id: fields.conversation_id, change_key: fields.change_key, ...text });
  } else if (bodyRow.old_content !== text.old_content || bodyRow.new_content !== text.new_content) {
    await ctx.db.patch(bodyRow._id, text);
  }
}

/** Remove a change and its text, duplicates included. */
export async function deleteFileChange(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  changeKey: string,
): Promise<void> {
  for (const table of ["file_changes", "file_change_bodies"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_conversation_change_key", (q) =>
        q.eq("conversation_id", conversationId).eq("change_key", changeKey))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

// Rows one migration hop moves. Rows are at most a document (1 MiB) and a
// shell capture is at most 400 KiB, so a page stays under the read and write
// caps even when every row is a whole-file write.
const MIGRATE_PAGE = 16;

/**
 * Move legacy inline text into file_change_bodies, one page per hop,
 * self-scheduling until the table is exhausted (a one-shot driver dies on a
 * table this size). Idempotent: a row without inline text is skipped, a body
 * row already present is refreshed only if it differs. Live writers already
 * strip inline text on their next upsert, so this only has to reach the rows
 * nothing touches again. Run:
 *   packages/convex/run.sh fileChangeBodies:migrate
 */
export const migrate = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    moved: v.optional(v.number()),
    scanned: v.optional(v.number()),
    hops: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("file_changes").paginate({ numItems: MIGRATE_PAGE, cursor: args.cursor ?? null });
    let moved = args.moved ?? 0;
    for (const row of page.page) {
      const body = bodyOf(row);
      if (!body) continue;
      const bodyRow = await ctx.db
        .query("file_change_bodies")
        .withIndex("by_conversation_change_key", (q) =>
          q.eq("conversation_id", row.conversation_id).eq("change_key", row.change_key))
        .first();
      const text = { old_content: body.oldContent, new_content: body.newContent };
      if (!bodyRow) {
        await ctx.db.insert("file_change_bodies", { conversation_id: row.conversation_id, change_key: row.change_key, ...text });
      } else if (bodyRow.old_content !== text.old_content || bodyRow.new_content !== text.new_content) {
        await ctx.db.patch(bodyRow._id, text);
      }
      await ctx.db.patch(row._id, {
        old_bytes: body.oldContent === undefined ? undefined : body.oldContent.length,
        new_bytes: body.newContent.length,
        old_content: undefined,
        new_content: undefined,
      });
      moved++;
    }
    const scanned = (args.scanned ?? 0) + page.page.length;
    const hops = (args.hops ?? 0) + 1;
    if (!page.isDone) {
      if (hops % 500 === 0) console.log(`fileChangeBodies.migrate: ${scanned} scanned, ${moved} moved, cursor ${page.continueCursor}`);
      await ctx.scheduler.runAfter(0, internal.fileChangeBodies.migrate, { cursor: page.continueCursor, moved, scanned, hops });
    } else {
      console.log(`fileChangeBodies.migrate done: ${scanned} scanned, ${moved} moved`);
    }
    return { scanned, moved, done: page.isDone };
  },
});
