// Undo of a gesture on a session whose conversation meta is not loaded.
//
// A session that was never opened in this window has no `conversations` row,
// and an action that writes one (favorite, pin, privacy, project) creates a
// thin `{_id}` row to carry the write. That row stands for a server row: no
// undoable action mints a conversation (creates are never undoable). So the
// undo of such an add restores the fields the action wrote and keeps the row.
// Deleting it would plant a `conversations:<id>` exclude that nothing retires,
// and the conversation's meta could never sync in again; it would also throw
// away meta that loaded between the gesture and its undo.
//
// The thin row says nothing about what a field held before. The inbox row
// does: `sessions` and `conversations` are two copies of one server row, the
// action writes both, and the sessions cell carries the real prior value.
//
// The inbox row is also the truth when the meta is loaded. Its conversations
// copy can lag: the server leaves a cleared stamp out of the meta and the
// merge keeps the old value, so a draft that writes the clear on both copies
// changes only the stale one. The prior value is the inbox row's then too,
// and where the inbox row already showed the written value there is nothing
// to take back: sending the stale stamp would re-hide (or re-kill) the row.
import { sameShape, type CellChange, type UndoCtx } from "@platform/engine";
import { OPTIONAL_INBOX_TIMESTAMPS } from "../syncProtocol";

const isThinAdd = (c: CellChange) => c.store === "conversations" && c.field === undefined && !c.hadBefore && c.hadAfter;

const sessionsTwin = (cells: readonly CellChange[], id: string, field: string) =>
  cells.find((s) => s.store === "sessions" && s.id === id && s.field === field);

/**
 * A conversations field cell with the prior value of the sessions cell for the
 * same row and field; undefined where the inbox row did not change (or there
 * is none), so the prior value is unknown here.
 */
export const withSessionsPrior = (cells: readonly CellChange[], c: CellChange): CellChange | undefined => {
  const twin = sessionsTwin(cells, c.id, c.field!);
  return twin && { ...c, before: twin.before, hadBefore: twin.hadBefore };
};

// Whether the inbox row held `value` in `field` before the gesture. An optional
// stamp's clear is spelled either way (null or left out), as in the sync merge.
const inboxRowHeld = (row: Record<string, unknown>, field: string, value: unknown): boolean =>
  OPTIONAL_INBOX_TIMESTAMPS.has(field) && row[field] == null
    ? value == null
    : Object.prototype.hasOwnProperty.call(row, field) && sameShape(row[field], value);

/**
 * Turns each thin-row add into one cell per field it wrote, restored from the
 * inbox row; a field the inbox row did not change is dropped, so nothing is
 * written or locked for it. A row kept by an earlier undo is still thin, so a
 * field cell with no prior value takes the inbox row's too, where it has one.
 * Where the inbox row stood behind the gesture, every conversations field cell
 * takes its prior value, and one whose value the inbox row already showed is
 * dropped (the conversations copy was stale).
 */
export const keepConversationRows = (cells: CellChange[], ctx?: Pick<UndoCtx, "before">): CellChange[] =>
  cells.flatMap((c) => {
    if (c.store !== "conversations") return [c];
    const inboxRow = ctx?.before?.sessions?.[c.id] as Record<string, unknown> | undefined;
    if (c.field !== undefined) {
      if (!inboxRow) return [c.hadBefore ? c : (withSessionsPrior(cells, c) ?? c)];
      const twin = withSessionsPrior(cells, c);
      if (twin) return [twin];
      return inboxRowHeld(inboxRow, c.field, c.after) ? [] : [c];
    }
    if (c.hadBefore || !isThinAdd(c)) return [c];
    const added = c.after as Record<string, unknown>;
    const fields = Object.keys(added).filter((field) => field !== "_id");
    return fields.flatMap((field) => withSessionsPrior(cells, { ...c, field, before: undefined, after: added[field] }) ?? []);
  });

/**
 * Whether a gesture wrote conversation fields whose prior values nothing here
 * knows: the row is thin (created by this gesture, or a stub an earlier write
 * left, which the server never delivered) and no inbox row stands behind it.
 * The /sessions page lists rows this window holds in neither store. An undo
 * could only clear those fields, so taking back an unpin would send the unpin
 * again. Such a gesture is not recorded.
 */
export const priorUnknown = (ctx: Pick<UndoCtx, "changes" | "before">): boolean =>
  ctx.changes.some(
    (c) => c.store === "conversations" && !c.hadBefore && c.hadAfter && isThinBefore(ctx, c.id) && ctx.before?.sessions?.[c.id] == null,
  );

/**
 * Whether the gesture found no loaded meta for the row: it had no
 * conversations row, or a stub an earlier write left. The server's row always
 * carries _creationTime. With no record of the gesture the row counts as thin.
 */
export const isThinBefore = (ctx: Pick<UndoCtx, "before"> | undefined, id: string): boolean =>
  ctx?.before?.conversations?.[id]?._creationTime == null;
