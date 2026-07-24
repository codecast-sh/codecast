import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type ViewCoverage = {
  contractId: string;
  viewKey: string;
  revision: number;
};

export type CommandIdCoverageTarget = {
  kind: "command-id";
  contractId: string;
  viewKey: string;
};

export type CommandIdCoverage = CommandIdCoverageTarget & {
  commandId: string;
};

export type CommandReceiptCoverage = ViewCoverage | CommandIdCoverage;

export type ViewCoverageTarget = Pick<ViewCoverage, "contractId" | "viewKey"> & {
  /**
   * Revision-domain owner when the caller is one authorized viewer of a shared
   * view. This identity is server-derived and never appears in public receipts.
   */
  revisionPrincipalId?: Id<"users">;
};

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export async function readLocalViewRevision(
  ctx: DbCtx,
  principalId: Id<"users">,
  contractId: string,
  viewKey: string,
): Promise<number> {
  const head = await ctx.db
    .query("local_view_heads")
    .withIndex("by_principal_contract_view", (q: any) =>
      q
        .eq("principal_id", principalId)
        .eq("contract_id", contractId)
        .eq("view_key", viewKey))
    .unique();
  return head?.revision ?? 0;
}

/** Advance a view revision inside the domain mutation's Convex transaction. */
export async function advanceLocalViewRevision(
  ctx: Pick<MutationCtx, "db">,
  principalId: Id<"users">,
  contractId: string,
  viewKey: string,
): Promise<ViewCoverage> {
  const current = await ctx.db
    .query("local_view_heads")
    .withIndex("by_principal_contract_view", (q: any) =>
      q
        .eq("principal_id", principalId)
        .eq("contract_id", contractId)
        .eq("view_key", viewKey))
    .unique();
  const revision = (current?.revision ?? 0) + 1;
  const updatedAt = Date.now();
  if (current) {
    await ctx.db.patch(current._id, { revision, updated_at: updatedAt });
  } else {
    await ctx.db.insert("local_view_heads", {
      principal_id: principalId,
      contract_id: contractId,
      view_key: viewKey,
      revision,
      updated_at: updatedAt,
    });
  }
  return { contractId, viewKey, revision };
}
