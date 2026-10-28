// A codecast reaction mirrored into Slack, under the name of whoever reacted.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./functions";
import { slackApi } from "./lib/slackApi";
import { emojiToShortcode } from "./lib/slackText";
import { tokenCanReact } from "./lib/slackMirror";
import { slackLinkForChannel } from "./lib/slackOutbound";
import { noteOutboundFailure, pushableContext, userTokenFor } from "./slackSync";

// Who a reaction is said by in Slack. A person who connected Slack with
// reactions:write reacts as themselves, under their own name. Everyone else is
// spoken for by the app, which holds ONE reaction per emoji for all of them, so
// it lets go only when nobody it speaks for still holds that emoji. Rows that
// came in from Slack are those people's own reactions, never the app's.
export const reactionSpeaker = internalQuery({
  args: { message_id: v.id("chat_messages"), user_id: v.id("users"), emoji: v.string() },
  handler: async (ctx, args): Promise<{ personal: string | null; app_holds_for_others: boolean }> => {
    const message = await ctx.db.get(args.message_id);
    const link = message ? await slackLinkForChannel(ctx, message.channel_id) : null;
    if (!message || !link) return { personal: null, app_holds_for_others: false };
    const reacts = async (userId: Id<"users">) => {
      const token = await userTokenFor(ctx, link.installation_id, userId);
      return token && tokenCanReact(token.scopes) ? token.token : null;
    };
    const holders = await ctx.db
      .query("chat_reactions")
      .withIndex("by_message", (q: any) => q.eq("message_id", args.message_id))
      .collect();
    let appHolds = false;
    for (const r of holders) {
      if (r.emoji !== args.emoji || r.slack_user || r.user_id === args.user_id) continue;
      if (!(await reacts(r.user_id))) { appHolds = true; break; }
    }
    return { personal: await reacts(args.user_id), app_holds_for_others: appHolds };
  },
});

export const pushReaction = internalAction({
  args: { message_id: v.id("chat_messages"), emoji: v.string(), add: v.boolean(), user_id: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const c = await pushableContext(ctx, args.message_id, { option: "reactions", ours: false });
    // The app is not in a person's DM, so Slack answers channel_not_found, and
    // that answer pauses the whole link. The reaction stays here.
    if (!c || c.link.kind === "dm") return;
    const name = emojiToShortcode(args.emoji);
    if (!name) return;
    // Never c.install.bot_token: the context swaps in the message AUTHOR's own
    // token when they connected Slack, which is right for posting their line
    // but would put someone else's reaction under the author's name.
    const appToken = c.app_token ?? c.install.bot_token;
    const who = args.user_id
      ? await ctx.runQuery(internal.slackReactions.reactionSpeaker, { message_id: args.message_id, user_id: args.user_id, emoji: args.emoji })
      : { personal: null, app_holds_for_others: false };
    const send = (token: string) => slackApi(token, args.add ? "reactions.add" : "reactions.remove", {
      channel: c.link.slack_channel_id, timestamp: c.message.external!.ts, name,
    });
    if (who.personal) {
      const mine = await send(who.personal);
      if (mine.ok || mine.error === "already_reacted") return;
    }
    // The app takes it when the person cannot react as themselves, including a
    // removal that finds nothing because the app reacted for them before they
    // connected. Its reaction stays while it still speaks for someone else.
    if (!args.add && who.app_holds_for_others) return;
    const resp = await send(appToken);
    if (!resp.ok && resp.error !== "already_reacted" && resp.error !== "no_reaction" && resp.error !== "invalid_name") {
      await noteOutboundFailure(ctx, c.link, `reaction: ${resp.error}`);
    }
  },
});
