// A permanent delete as a tree of index lookups: each node names a table, the
// index that finds a parent's rows in it, and the nodes for each row's own
// rows. A walk deletes children before their row and reads in pages against a
// budget, so one pass of a large delete stays far under Convex's per-function
// read and time caps, and the next pass picks up where it stopped: everything
// already deleted is simply no longer in the index.
//
// A leaf module: it imports nothing, so any mutation can run a tree.

/** Rows deleted per table, for the delete's record. */
export type PurgeCounts = Record<string, number>;

/** What one walk left: everything gone, more to do, or a row that cannot go yet. */
export type PurgeOutcome = "done" | "more" | "wait";

/** Units a pass may spend. A read costs one, a deleted row its node's weight. */
export type PurgeBudget = { left: number };

export type PurgeNode = {
  table: string;
  index: string;
  /** The index's leading field, matched against `value(parent)`. */
  field: string;
  /** The parent's key in this table; absent means nothing to find. */
  value: (parent: any) => unknown;
  /** Rows per read; heavy rows are read in small pages. */
  page?: number;
  /** What a deleted row costs against the budget (heavy rows cost more). */
  weight?: number;
  /** Rows that hang off each row, deleted before it. */
  children?: ReadonlyArray<PurgeNode>;
  /** Work before the row goes: its stored files, its effects on other rows. `wait` keeps it for a later pass. */
  before?: (ctx: any, row: any, counts: PurgeCounts) => Promise<void | "wait">;
};

export function addCount(counts: PurgeCounts, key: string, n = 1): void {
  if (n > 0) counts[key] = (counts[key] ?? 0) + n;
}

/** Delete every row of `nodes` under `parent`, in node order. */
export async function purgeChildren(
  ctx: any,
  nodes: ReadonlyArray<PurgeNode>,
  parent: any,
  budget: PurgeBudget,
  counts: PurgeCounts,
): Promise<PurgeOutcome> {
  for (const node of nodes) {
    const out = await purgeRange(ctx, node, parent, budget, counts);
    if (out !== "done") return out;
  }
  return "done";
}

/** Delete every row `node` finds under `parent`, a page at a time. */
export async function purgeRange(
  ctx: any,
  node: PurgeNode,
  parent: any,
  budget: PurgeBudget,
  counts: PurgeCounts,
): Promise<PurgeOutcome> {
  const value = node.value(parent);
  if (value === undefined || value === null) return "done";
  const page = node.page ?? 100;
  const weight = node.weight ?? 1;
  for (;;) {
    if (budget.left <= 0) return "more";
    budget.left -= 1;
    const take = Math.max(1, Math.min(page, Math.floor(budget.left / weight)));
    const rows = await ctx.db
      .query(node.table)
      .withIndex(node.index, (q: any) => q.eq(node.field, value))
      .take(take);
    for (const row of rows) {
      const out = await purgeRow(ctx, node, row, budget, counts);
      if (out !== "done") return out;
    }
    if (rows.length < take) return "done";
  }
}

/** Delete one row of `node`: its children, its `before` work, then the row. */
export async function purgeRow(
  ctx: any,
  node: PurgeNode,
  row: any,
  budget: PurgeBudget,
  counts: PurgeCounts,
): Promise<PurgeOutcome> {
  if (node.children) {
    const out = await purgeChildren(ctx, node.children, row, budget, counts);
    if (out !== "done") return out;
  }
  if (budget.left <= 0) return "more";
  if (node.before && (await node.before(ctx, row, counts)) === "wait") return "wait";
  await ctx.db.delete(row._id);
  addCount(counts, node.table);
  budget.left -= node.weight ?? 1;
  return "done";
}

/** A stored file, gone; one already missing is not an error. */
export async function deleteStored(ctx: any, counts: PurgeCounts, storageId: unknown): Promise<void> {
  if (!storageId) return;
  await ctx.storage.delete(storageId).catch(() => {});
  addCount(counts, "storage_files");
}
