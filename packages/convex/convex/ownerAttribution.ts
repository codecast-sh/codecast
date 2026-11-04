// A prompt a person typed in their own terminal is stored with no
// from_user_id: every reader (transcript, sticky prompt, navigator, mobile)
// attributes such a row to conversation.user_id. A move across accounts
// (devices.performReparentSessionToDevice) rewrites user_id to the new runner,
// so without this every earlier prompt silently became the new owner's: the
// person who wrote them saw their own words under someone else's name, and
// only the prompts the web had stamped (a composer send) stayed theirs
// (ct-85423). The move therefore writes the sender onto the rows before the
// owner changes hands, so the fact lives on the row and no later owner change
// can move it.

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isNavigableUserMessage } from "./userMessagesFilter";

/** User-role rows read per page. Most are tool results carrying command
 *  output, so the page stays small enough for one mutation's read limit. */
export const OWNER_STAMP_PAGE_SIZE = 100;

/** A row the conversation's owner wrote that names no sender: a person's
 *  prompt (the navigator's test, or its stored flag). Tool results and
 *  compaction rows carry no authorship worth keeping. */
export function needsOwnerStamp(m: { role: string; from_user_id?: unknown; nav_prompt?: true; subtype?: string; content?: string; tool_results?: unknown[] | null; images?: any[] }): boolean {
  if (m.role !== "user" || m.from_user_id) return false;
  return m.nav_prompt === true || isNavigableUserMessage(m as any);
}

// Named by path rather than through the generated api, so this module adds
// nothing to _generated/api.d.ts.
const nextPage = makeFunctionReference<"mutation">("ownerAttribution:stampPriorOwnerPrompts");

type StampArgs = { conversation_id: Id<"conversations">; user_id: Id<"users">; until: number; cursor?: string };

/** Stamp one page of `user_id` onto the prompts written up to `until`, and
 *  schedule the next page when there is one. The move calls it in the same
 *  transaction that changes user_id, so a session of ordinary length is fully
 *  attributed before anyone can read it under the new owner. */
export async function stampPriorOwnerPage(ctx: { db: any; scheduler?: any }, args: StampArgs) {
  const page = await ctx.db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) =>
      q.eq("conversation_id", args.conversation_id).eq("role", "user").lte("timestamp", args.until))
    .paginate({ cursor: args.cursor ?? null, numItems: OWNER_STAMP_PAGE_SIZE });
  const stale = page.page.filter((m: any) => needsOwnerStamp(m));
  if (stale.length > 0) {
    // A transcript_revision jump makes open windows refetch rows that sit
    // behind their live tail, the way every backfill edit does.
    const conv = await ctx.db.get(args.conversation_id);
    let revision = conv?.transcript_revision ?? 0;
    for (const m of stale) await ctx.db.patch(m._id, { from_user_id: args.user_id, transcript_revision: ++revision });
    if (conv) await ctx.db.patch(conv._id, { transcript_revision: revision });
  }
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, nextPage, { ...args, cursor: page.continueCursor });
  }
  return { scanned: page.page.length, stamped: stale.length, done: page.isDone };
}

export const stampPriorOwnerPrompts = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    until: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: (ctx, args) => stampPriorOwnerPage(ctx, args),
});
