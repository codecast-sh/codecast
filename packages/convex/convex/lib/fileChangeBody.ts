// One file change's text, read by key: the pure reader, in a leaf module so
// lib code (lib/sessionMedia) can import it without pulling fileChangeBodies'
// Convex functions, and with them functions.ts, into its import graph.
import type { Doc, Id } from "../_generated/dataModel";
import type { FileChangeBody } from "../fileChanges/extractor";
import type { QueryCtx } from "../functions";

type ReadCtx = { db: QueryCtx["db"] };

export function bodyOf(row: { old_content?: string; new_content?: string } | null | undefined): FileChangeBody | null {
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

