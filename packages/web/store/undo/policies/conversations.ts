// Conversation privacy and project for the work undo policy (./work.ts): the
// prior values an inverse restores, and how a cell is spelled for the lock.
import type { CellChange, Invocation, UndoCtx } from "@platform/engine";
import { isThinBefore, withSessionsPrior } from "../thinConversation";
import { call, rowIds } from "./invocation";

// ── Conversations: privacy and project ───────────────────────────────────────

export const CONV_STORES = ["conversations", "sessions"] as const;

/** A conversation field's prior value, from the cells that changed it (either store copy). */
export function priorOf(ctx: UndoCtx, id: string, field: string): unknown {
  const cells = ctx.changes.filter((c) => c.id === id && c.field === field && (CONV_STORES as readonly string[]).includes(c.store));
  const known = cells.find((c) => c.before !== undefined) ?? cells[0];
  return known ? known.before : rowBefore(ctx, id)?.[field];
}

export const rowBefore = (ctx: UndoCtx, id: string) => ctx.before?.conversations?.[id] ?? ctx.before?.sessions?.[id];

export const convIds = (ctx: UndoCtx, fields: readonly string[]) =>
  rowIds(ctx.changes.filter((c) => (CONV_STORES as readonly string[]).includes(c.store) && c.field !== undefined && fields.includes(c.field)));

// The server's setPrivacy(true) stamps team_visibility "private", and its
// setPrivacy(false) keeps whatever visibility the row has; setTeamVisibility
// shares and names the level. So a row that was shared returns through
// setTeamVisibility with its prior level, and a row that was private returns
// through setPrivacy(true).
export function restorePrivacy(ctx: UndoCtx): Invocation[] {
  return convIds(ctx, ["is_private", "team_visibility"]).map((id) =>
    priorOf(ctx, id, "is_private") === true
      ? call("setPrivacy", id, true)
      : call("setTeamVisibility", id, (priorOf(ctx, id, "team_visibility") as string | undefined) ?? null),
  );
}

// Whether the inverse can put the server back where it was. Sharing assigns a
// team to a conversation that has none (privacy.ts buildShareUpdate) and no
// verb takes a team away, so a row that was shared with no team cannot be
// returned to: the undo would show it to a team that never saw it. The same
// holds when the prior is_private is unknown here (a row without the field),
// which restorePrivacy would read as shared. Such gestures are not recorded.
export const privacyRestorable = (ctx: UndoCtx): boolean =>
  convIds(ctx, ["is_private", "team_visibility"]).every((id) => {
    const prior = priorOf(ctx, id, "is_private");
    return prior === true || (prior === false && rowBefore(ctx, id)?.team_id != null);
  });

// On a row with no loaded meta, these inverses cannot restore a conversations
// cell with no prior value as a clear: the thin row says nothing about what
// the field held, so a lock for an absent value would never meet its echo and
// would strip the field from the meta when it syncs. The prior value is the
// inbox row's: each such cell takes the before value of the sessions cell for
// the same field, and is dropped where the inbox row did not change, so
// nothing is written or locked for it. A row whose meta was loaded keeps the
// cell: there the field really was unset, and the inverse returns it to that
// (setTeamVisibility(id, null) clears the level).
export const spellThinConversation = (cells: CellChange[], ctx?: UndoCtx): CellChange[] =>
  cells.flatMap((c) =>
    c.store !== "conversations" || c.field === undefined || c.hadBefore || !isThinBefore(ctx, c.id) ? [c] : (withSessionsPrior(cells, c) ?? []),
  );

// setPrivacy(true) stores team_visibility "private" even on a row born
// private with none, so an undo back to private writes that spelling and its
// lock retires on the echo.
export const spellPrivacy = (all: CellChange[], ctx?: UndoCtx): CellChange[] => {
  const cells = spellThinConversation(all, ctx);
  return cells.map((c) =>
    c.field === "team_visibility" && c.before == null && priorPrivate(cells, c.id)
      ? { ...c, before: "private", hadBefore: true }
      : c,
  );
};

// The server's switchProject stores git_root = the path it is given, so an
// undo back to a prior project_path writes that path as git_root too, even
// when the row's prior git_root was a parent directory or unset.
export const spellSwitchProject = (all: CellChange[], ctx?: UndoCtx): CellChange[] => {
  const cells = spellThinConversation(all, ctx);
  return cells.map((c) => {
    if (c.field !== "git_root") return c;
    const prior = cells.find((p) => p.id === c.id && p.store === c.store && p.field === "project_path")?.before;
    return typeof prior === "string" ? { ...c, before: prior, hadBefore: true } : c;
  });
};

export const priorPrivate = (cells: readonly CellChange[], id: string) =>
  cells.some((c) => c.id === id && c.field === "is_private" && c.before === true);

/**
 * Who can see a row, ordered: private, then a summary, then everything. A
 * shared row with no level of its own falls back to its owner's membership
 * level, which can sit on either side of the others, so it is its own value.
 */
export function audience(isPrivate: unknown, visibility: unknown): number | "default" {
  if (visibility === "full") return 2;
  if (visibility === "summary") return 1;
  return isPrivate === true || visibility === "private" ? 0 : "default";
}

export const rowNow = (ctx: UndoCtx, id: string) => ctx.after?.conversations?.[id] ?? ctx.after?.sessions?.[id];

// Undo widens access when the prior audience is wider than the one the
// gesture left, or when the two cannot be ordered (the member default).
export function undoWidens(ctx: UndoCtx): boolean {
  return convIds(ctx, ["is_private", "team_visibility"]).some((id) => {
    const prior = audience(priorOf(ctx, id, "is_private"), priorOf(ctx, id, "team_visibility"));
    const now = audience(rowNow(ctx, id)?.is_private, rowNow(ctx, id)?.team_visibility);
    if (prior === now || prior === 0) return false;
    return now === 0 || prior === "default" || now === "default" || prior > now;
  });
}

export const visibilityName = (v: unknown) => (v === "full" ? "full" : v === "summary" ? "summary" : "default");
