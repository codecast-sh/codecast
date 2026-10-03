// One row of a workspace-keyed table by the ref a person types: its short id
// (eg-12, src-3, mw-4, rp-9), else its Convex id, else (for a table that has
// one) its name in the caller's workspace. A row the caller's access key does
// not admit reads as missing, never as forbidden.
import type { Id } from "../_generated/dataModel";
import { workspaceGrantsAccess } from "./access";
import { notFound } from "./auth";

type RefTable = "event_sources" | "event_groups" | "metric_watches" | "replays";

/** The row, or null when it does not exist or the caller may not read it. */
export async function readableRowByRef(
  ctx: { db: any },
  table: RefTable,
  userId: Id<"users">,
  ref: string,
  byName?: (needle: string) => Promise<any | null>,
): Promise<any | null> {
  const needle = ref.trim();
  if (!needle) return null;
  const byShort = await ctx.db.query(table).withIndex("by_short_id", (q: any) => q.eq("short_id", needle)).first();
  const id = byShort ? null : ctx.db.normalizeId(table, needle);
  const row = byShort ?? (id ? await ctx.db.get(id) : null) ?? (byName ? await byName(needle) : null);
  return row && (await workspaceGrantsAccess(ctx as any, userId, row.workspace)) ? row : null;
}

/** readableRowByRef that refuses a miss with "<label> <ref> not found". */
export async function rowByRef(
  ctx: { db: any },
  table: RefTable,
  userId: Id<"users">,
  ref: string,
  label: string,
  byName?: (needle: string) => Promise<any | null>,
): Promise<any> {
  const row = await readableRowByRef(ctx, table, userId, ref, byName);
  if (!row) notFound(`${label} ${ref.trim()} not found`);
  return row;
}
