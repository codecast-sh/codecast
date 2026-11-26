// The pieces every undo policy builds inverses from: a server call, and the
// changed cells and rows of a gesture.
import type { CellChange, Invocation, UndoCtx } from "@platform/engine";

export const call = (action: string, ...args: unknown[]): Invocation => ({ action, args, runDraft: false });

export const cellsOf = (ctx: UndoCtx, stores: string | readonly string[], field?: string): CellChange[] => {
  const keys = typeof stores === "string" ? [stores] : stores;
  return ctx.changes.filter((c) => keys.includes(c.store) && (field === undefined || c.field === field));
};

export const rowIds = (cells: readonly CellChange[]): string[] => [...new Set(cells.map((c) => c.id))];
