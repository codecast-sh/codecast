// Writing a share token: the one check that a token serves one row of a
// table, the team policy that may forbid public links, and the authority
// event. Leaf module, so a conversation, doc or plan mints its link without
// importing publicShare.ts, whose call links reach the call modules and the
// big import cycle (ct-92432).
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { recordAuthorityEvent } from "./authorityEvents";
import { policyWorkspaceOf, requireTeamPolicyAllows } from "./teamPolicyGuard";

export const SHARE_TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ShareTable =
  | "conversations" | "docs" | "plans" | "tasks" | "transcripts" | "projects" | "initiatives"
  | "session_decisions" | "decision_stacks" | "agent_tasks" | "workflow_runs" | "weekly_cards";

/** Point `row`'s share token at `token` (null clears it) and record who did
 *  it. A token already serving another row of the table is refused, so one
 *  link can never be re-aimed at a different object. Returns what changed. A
 *  call's link has more to do (publicShare.claimShareToken restamps its
 *  running recordings), so the table type leaves calls out of the plain claim
 *  below. */
export async function writeShareToken(
  ctx: Pick<MutationCtx, "db">,
  table: ShareTable,
  row: { _id: Id<ShareTable>; share_token?: string | null },
  token: string | null,
  by?: Id<"users">,
  // The api token of a CLI request, so a device enrolled in a team that
  // turned public sharing off is refused too (lib/teamPolicyGuard).
  apiToken?: string,
): Promise<"minted" | "revoked" | null> {
  // A call's link may also carry its video (callRecordings.setCallShareVideo).
  // That choice belongs to the link it was made for: a link cleared or
  // re-aimed drops it, so a link turned on again (even with the old token,
  // which any free UUID may be) starts with the transcript alone and video is
  // always a fresh choice.
  const dropVideo = table === "transcripts" ? { share_video_token: undefined, share_video_through: undefined } : {};
  const audit = async (kind: "share_link_minted" | "share_link_revoked", shareToken: string) => {
    if (!by) throw new Error("A share link change needs the person who made it");
    await recordAuthorityEvent(ctx, {
      kind, actor_user_id: by, share_table: table, share_token: shareToken,
      conversation: table === "conversations" ? (row as any) : null,
      ...(table !== "conversations" && (row as any).team_id ? { team_id: (row as any).team_id } : {}),
      detail: { before: { on: !!row.share_token }, after: { on: kind === "share_link_minted", table, row_id: row._id } },
    });
  };
  if (token === null) {
    if (row.share_token) {
      await ctx.db.patch(row._id, { share_token: undefined, ...dropVideo } as any);
      await audit("share_link_revoked", row.share_token);
      return "revoked";
    }
    return null;
  }
  if (row.share_token === token) return null;
  if (!SHARE_TOKEN_SHAPE.test(token)) throw new Error("Invalid share token");
  await requireTeamPolicyAllows(ctx, { workspace: policyWorkspaceOf(table, row), apiToken }, "public_sharing_disabled");
  const taken = await (ctx.db.query(table) as any)
    .withIndex("by_share_token", (q: any) => q.eq("share_token", token))
    .first();
  if (taken) throw new Error("Invalid share token");
  await ctx.db.patch(row._id, { share_token: token, ...dropVideo } as any);
  await audit("share_link_minted", token);
  return "minted";
}

/** Point a non-call row's share token at `token` (null clears it). */
export async function claimShareToken(
  ctx: Pick<MutationCtx, "db">,
  table: Exclude<ShareTable, "transcripts">,
  row: { _id: Id<ShareTable>; share_token?: string | null },
  token: string | null,
  by?: Id<"users">,
  apiToken?: string,
): Promise<void> {
  await writeShareToken(ctx, table, row, token, by, apiToken);
}
