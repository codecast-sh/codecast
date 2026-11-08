// The vendor guard (HIPAA, plan pl-990): a regulated team's content reaches a
// third-party vendor only when Codecast holds a BAA with that vendor
// (BAA_COVERED_VENDORS in @codecast/shared/contracts/vendorCoverage). Every
// vendor's chokepoint asks here: lib/anthropic.ts for model calls, lib/openai.ts
// for OpenAI, the call token and recording paths for LiveKit, callFace for
// Tavus. A leaf beside teamPolicyGuard: it imports nothing from
// ./functions, and it works from a query or mutation (ctx.db) and from an
// action (ctx.runQuery, through vendorCoverage:refusalFor).
//
// The scope is where the content comes from: the workspace of the row being
// worked on (or the conversation it belongs to) and the token the request came
// with. A cron or a background job passes the scope of the row it is processing. Work that carries no team's
// content at all (a health ping, an org chart routed over role names) passes
// NO_TEAM_CONTENT, which reads as a claim a reviewer can check.
import { makeFunctionReference } from "convex/server";
import { accessError } from "@platform/auth/convex";
import { BAA_COVERED_VENDORS, FEATURE_VENDORS, vendorCovered, vendorUncoveredMessage, type ContentVendor } from "@codecast/shared/contracts/vendorCoverage";
import type { TeamFeatureKey } from "@codecast/shared/contracts";
import type { Id } from "../_generated/dataModel";
import { policyWorkspaceOf, regulatedTeamFor, type PolicyScope } from "./teamPolicyGuard";

/**
 * A conversation's content answers to the team it is visible to (policyTeamOf) and to the team it is filed
 * under: a private session inside a regulated team still holds that team's regulated data. Any other row
 * (a doc, a chat message, a role) answers to its workspace, else its team (policyTeamOf).
 */
export type VendorScope = PolicyScope & {
  conversationId?: Id<"conversations"> | string | null;
  row?: { table: string; id: string } | null;
};

const scoped = (scope: VendorScope) => !!(scope.workspace || scope.apiToken || scope.conversationId || scope.row);

/** The scope of work that sends no team's content (a ping, a prompt built only from Codecast's own text). */
export const NO_TEAM_CONTENT: VendorScope = Object.freeze({});

type DbCtx = { db: any };
type QueryRunner = { runQuery: (ref: any, args: any) => Promise<any> };
export type VendorCtx = DbCtx | QueryRunner;

/** What a vendor's chokepoint needs: the context it can read the team from, and the scope of the content it sends. */
export type VendorGate = { ctx: VendorCtx; scope: VendorScope };

/** The gate for work that sends no team's content: it never reads anything. */
export const NO_TEAM_CONTENT_GATE: VendorGate = Object.freeze({ ctx: { runQuery: async () => null }, scope: NO_TEAM_CONTENT });

const refusalForRef = makeFunctionReference<
  "query",
  { workspace?: string | null; api_token?: string | null; conversation_id?: string | null; row?: { table: string; id: string } | null; vendor: ContentVendor },
  string | null
>(
  "vendorCoverage:refusalFor",
);

/** The refusal for sending this scope's content to `vendor` from a db context; null when it may go. */
export async function vendorRefusalFromDb(
  ctx: DbCtx,
  scope: VendorScope,
  vendor: ContentVendor,
  covered: readonly ContentVendor[] = BAA_COVERED_VENDORS,
): Promise<string | null> {
  if (vendorCovered(vendor, covered) || !scoped(scope)) return null;
  const conversationId = scope.conversationId ? ctx.db.normalizeId("conversations", String(scope.conversationId)) : null;
  const conversation = conversationId ? await ctx.db.get(conversationId) : null;
  const workspaces = new Set<string | null>([scope.workspace ?? null]);
  if (conversation) {
    workspaces.add(policyWorkspaceOf("conversations", conversation));
    // Data classification, not access: the team a private session is filed under owns its data.
    if (conversation.team_id) workspaces.add(`team:${conversation.team_id}`);
  }
  const rowId = scope.row ? ctx.db.normalizeId(scope.row.table, scope.row.id) : null;
  const row = rowId ? await ctx.db.get(rowId) : null;
  if (row) workspaces.add(policyWorkspaceOf(scope.row!.table, row));
  for (const workspace of workspaces) {
    const team = await regulatedTeamFor(ctx, { workspace, apiToken: scope.apiToken });
    if (team) return vendorUncoveredMessage(vendor, team.team_name);
  }
  return null;
}

/** The refusal for sending this scope's content to `vendor`; null when it may go. */
export async function vendorRefusalFor(ctx: VendorCtx, scope: VendorScope, vendor: ContentVendor): Promise<string | null> {
  if (vendorCovered(vendor) || !scoped(scope)) return null;
  if ("db" in ctx && ctx.db) return vendorRefusalFromDb(ctx, scope, vendor);
  return (ctx as QueryRunner).runQuery(refusalForRef, {
    workspace: scope.workspace ?? null,
    api_token: scope.apiToken ?? null,
    conversation_id: scope.conversationId ? String(scope.conversationId) : null,
    row: scope.row ?? null,
    vendor,
  });
}

/** Whether this scope's content may be sent to `vendor`. */
export async function vendorAllowedFor(ctx: VendorCtx, scope: VendorScope, vendor: ContentVendor): Promise<boolean> {
  return (await vendorRefusalFor(ctx, scope, vendor)) === null;
}

/** Throws the vendor's one-line refusal (a FORBIDDEN ConvexError, so the web shows the words) when the content may not go. */
export async function requireVendorAllowed(ctx: VendorCtx, scope: VendorScope, vendor: ContentVendor): Promise<void> {
  const refusal = await vendorRefusalFor(ctx, scope, vendor);
  if (refusal) throw accessError("FORBIDDEN", refusal);
}

/** Why a team feature that sends content to a vendor (FEATURE_VENDORS) is off for this team, or null. */
export async function featureVendorRefusal(ctx: DbCtx, teamId: Id<"teams"> | null | undefined, key: TeamFeatureKey): Promise<string | null> {
  if (!teamId) return null;
  for (const vendor of FEATURE_VENDORS[key] ?? []) {
    const refusal = await vendorRefusalFromDb(ctx, { workspace: `team:${teamId}` }, vendor);
    if (refusal) return refusal;
  }
  return null;
}
