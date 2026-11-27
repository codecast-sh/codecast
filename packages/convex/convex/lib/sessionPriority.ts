// The priority a session serves, as the Deploys page names it beside the session (deploys.md DP12), with its owner and
// its rank as the viewer reads it (lib/priorityGroup positionOf: a teammate's numbered over what they can read, as the
// list numbers it): read only for a team
// with the priorities feature on, and only a priority the viewer may read (lib/priorityAccess), the rule priorities.ts
// reads by.
import type { Doc, Id } from "../_generated/dataModel";
import { FEATURE, featureCheck, readerFor, type Reader } from "./priorityAccess";
import { teamHasFeature } from "./teamFeatureGuard";
import { groupMemo, positionOf } from "./priorityGroup";
import type { SessionPriorityRef } from "@codecast/shared/contracts/priorities";

type Ctx = { db: any };
export type SessionPriority = SessionPriorityRef;

/** A reader of sessions' priorities for one viewer in one team, memoized per priority; null for every session while the team has the feature off. */
export async function sessionPriorityReader(ctx: Ctx, viewer: Id<"users">, teamId: Id<"teams"> | null | undefined): Promise<(conv: Pick<Doc<"conversations">, "priority_id"> | null | undefined) => Promise<SessionPriority | null>> {
  if (!teamId || !(await teamHasFeature(ctx, teamId, FEATURE))) return async () => null;
  const featureOn = featureCheck(ctx);
  let reader: Promise<Reader> | null = null;
  const seen = new Map<string, Promise<SessionPriority | null>>();
  // One read of each owner's active group per workspace, however many of their priorities the sessions serve.
  const readGroup = groupMemo();
  return (conv) => {
    const id = conv?.priority_id;
    if (!id) return Promise.resolve(null);
    const key = String(id);
    if (!seen.has(key)) {
      seen.set(key, (async () => {
        const p: Doc<"priorities"> | null = await ctx.db.get(id);
        if (!p || !(await featureOn(p.workspace))) return null;
        reader ??= readerFor(ctx, viewer);
        if (!(await (await reader).canRead(p))) return null;
        return { id: p.short_id, title: p.title ?? null, rank: await positionOf(ctx, await reader, p, readGroup), user_id: String(p.user_id) };
      })());
    }
    return seen.get(key)!;
  };
}
