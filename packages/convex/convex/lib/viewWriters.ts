import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  advanceLocalViewRevision,
  type ViewCoverageTarget,
} from "../localViewRevisions";

export type RevisionMode = "advance" | "receipt";

export type ViewWriter<Table extends TableNames> = {
  insert(value: Omit<Doc<Table>, "_id" | "_creationTime">): Promise<Id<Table>>;
  patch(id: Id<Table>, value: Partial<Doc<Table>>): Promise<void>;
  delete(id: Id<Table>): Promise<void>;
};

export type ViewWriterBinding<Table extends TableNames> = {
  /** Table whose ordinary raw writes this boundary owns. */
  table: Table;
  /** Row noun used in error messages ("bookmark", "comment"). */
  label: string;
  /** Reject an insert whose value lands outside the bound view. */
  guardInsert(value: Omit<Doc<Table>, "_id" | "_creationTime">): void;
  /** Reject a patch/delete whose authoritative row is outside the bound view. */
  guardRow(row: Doc<Table>): void;
  /** Reject a patch that would move the row across the binding. */
  guardPatch?(row: Doc<Table>, patch: Partial<Doc<Table>>): void;
  /**
   * The exact view head every grouped write advances. Must carry the
   * server-derived `revisionPrincipalId`; a binding without one cannot advance
   * anything and is a programming error, not a runtime condition.
   */
  coverageTarget: ViewCoverageTarget;
};

/**
 * The shared choreography behind every table-owned view boundary: a typed
 * writer whose operations re-check the binding against the authoritative row,
 * one write counter, and exactly one revision advance per grouped transition.
 * "receipt" mode defers that advance to runLocalCommand so the domain write,
 * coverage, and durable receipt commit in one transaction.
 *
 * A binding declares only what is genuinely domain-bound — which rows belong
 * to the view and which head they advance. Everything mechanical lives here.
 */
export async function runViewTransition<Table extends TableNames, Result>(
  ctx: MutationCtx,
  binding: ViewWriterBinding<Table>,
  revisionMode: RevisionMode,
  transition: (writer: ViewWriter<Table>) => Promise<Result>,
): Promise<{ result: Result; coverageTarget?: ViewCoverageTarget }> {
  const requireBoundRow = async (id: Id<Table>): Promise<Doc<Table>> => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error(`Cannot write a missing ${binding.label}`);
    binding.guardRow(row);
    return row;
  };

  let writeCount = 0;
  const writer: ViewWriter<Table> = {
    async insert(value) {
      binding.guardInsert(value);
      writeCount++;
      return await ctx.db.insert(binding.table, value as never);
    },
    async patch(id, value) {
      const row = await requireBoundRow(id);
      binding.guardPatch?.(row, value);
      writeCount++;
      await ctx.db.patch(id, value as never);
    },
    async delete(id) {
      await requireBoundRow(id);
      writeCount++;
      await ctx.db.delete(id);
    },
  };

  const result = await transition(writer);
  if (writeCount === 0) return { result };

  const target = binding.coverageTarget;
  if (!target.revisionPrincipalId) {
    throw new Error(`View binding for ${binding.table} lacks a revision principal`);
  }
  if (revisionMode === "advance") {
    await advanceLocalViewRevision(
      ctx,
      target.revisionPrincipalId,
      target.contractId,
      target.viewKey,
    );
  }
  return { result, coverageTarget: target };
}
