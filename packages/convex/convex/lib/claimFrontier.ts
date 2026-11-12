// `/cli/work/claim` as the HTTP route runs it: two internal.taskFrontier calls.
// Kept apart from taskFrontier.ts, which reaches tasks.ts and the big import
// cycle, so http.ts mounts the route without loading it (ct-92432).
import type { GenericActionCtx } from "convex/server";
import { internal } from "../_generated/api";
import type { ClaimResult } from "../taskFrontier";

/** `/cli/work/claim`: read the candidates, then claim one. */
export async function claimFrontier(
  ctx: Pick<GenericActionCtx<any>, "runQuery" | "runMutation">,
  args: { api_token: string; conversation_id?: string; stale?: boolean } & Record<string, any>,
): Promise<ClaimResult> {
  const { candidates, more, stale_passed, others_passed } = await ctx.runQuery(internal.taskFrontier.claimCandidates, args as any);
  const passed = { ...(stale_passed ? { stale_passed } : {}), ...(others_passed ? { others_passed } : {}) };
  if (!candidates.length) return { task: null, skipped: [], more, ...passed };
  const claim: ClaimResult = await ctx.runMutation(internal.taskFrontier.claimNextReady, {
    api_token: args.api_token,
    candidates,
    ...(args.conversation_id ? { conversation_id: args.conversation_id } : {}),
    ...(args.stale ? { stale: true } : {}),
    ...(args.include_subtasks ? { include_subtasks: true } : {}),
  });
  return { ...claim, ...(!claim.task ? { ...(more ? { more } : {}), ...passed } : {}) };
}
