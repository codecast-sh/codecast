// One-off sweeps over the hosted assistant's conversations (plan pl-840),
// run by hand with `packages/convex/run.sh`. Each is safe to run again.
import { v } from "convex/values";
import { internalMutation } from "../functions";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { isHostedAgentType } from "@codecast/shared/contracts";

/** Whether a hosted conversation still carries a name no title pass gave
 *  it: no pass has run (a pass always writes a subtitle), or its title is
 *  the opening of the person's first message. Conversations from before the
 *  hosted title prompt, and ones whose only turn failed, read that way. */
export function needsHostedTitle(conv: Pick<Doc<"conversations">, "title" | "subtitle" | "first_prompt" | "title_is_custom" | "skip_title_generation">): boolean {
  if (conv.title_is_custom || conv.skip_title_generation) return false;
  if (conv.subtitle === undefined) return true;
  const title = conv.title?.trim().replace(/[….]+$/, "").toLowerCase();
  const first = conv.first_prompt?.trim().toLowerCase();
  return !!title && !!first && title.length >= 12 && first.startsWith(title);
}

/** Retitles hosted conversations that still carry their first message as a
 *  name, through the hosted title prompt (titleGeneration.ts
 *  buildHostedTitlePrompt, chosen by agent_type). Found through their turns,
 *  since conversations have no index by agent. Staggered a second apart to
 *  stay clear of the model's rate limit. `dry_run` only counts. */
export const retitleHostedConversations = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const seen = new Set<string>();
    let scheduled = 0;
    for (const turn of await ctx.db.query("assistant_turns").collect()) {
      const id = String(turn.conversation_id);
      if (seen.has(id)) continue;
      seen.add(id);
      const conv = await ctx.db.get(turn.conversation_id as Id<"conversations">);
      if (!conv || !isHostedAgentType(conv.agent_type) || !needsHostedTitle(conv)) continue;
      if (!args.dry_run) {
        await ctx.db.patch(conv._id, { title_gen_scheduled_at: Date.now() });
        await ctx.scheduler.runAfter(scheduled * 1_000, internal.titleGeneration.generateTitle, { conversation_id: conv._id });
      }
      scheduled++;
    }
    return { conversations: seen.size, scheduled };
  },
});
