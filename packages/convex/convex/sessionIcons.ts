// A pinned session's icon (org-staffing.md S13): a plain session in someone's
// header pins, with characters off, wears a drawing in the role icon language,
// made by the same generator from its title and stored as
// conversations.drawn_icon. Kept apart from roleIcons.ts, which writes roles.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { canAccessConversation } from "./lib/access";
import { modelCost } from "./lib/anthropic";
import { roleIconValidator } from "./lib/roleIconValidator";
import { ICON_MODEL, generateRoleIcon, type IconBrief } from "./lib/roleIconGenerator";
import { SESSION_ICON_RETRY_MS, isRoleIcon, pickRoleIconAccent } from "@codecast/shared/contracts/roleIcon";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";
import { deploymentAsk, performViewerRoles } from "./roleIcons";

type Ctx = { db: any; scheduler: any };

export { SESSION_ICON_RETRY_MS };

/** Whether a drawing was scheduled. */
export async function performRequestSessionIcon(ctx: Ctx, userId: Id<"users">, conversationId: string, now = Date.now()): Promise<boolean> {
  const id = ctx.db.normalizeId("conversations", conversationId);
  const conv: any = id ? await ctx.db.get(id) : null;
  if (!conv || !String(conv.title ?? "").trim() || isRoleIcon(conv.drawn_icon)) return false;
  if (conv.drawn_icon_requested_at && now - conv.drawn_icon_requested_at < SESSION_ICON_RETRY_MS) return false;
  if (!(await canAccessConversation(ctx as any, userId, conv))) return false;
  await ctx.db.patch(conv._id, { drawn_icon_requested_at: now });
  await ctx.scheduler.runAfter(0, internal.sessionIcons.drawSessionIcon, { conversation_id: conv._id, user_id: userId });
  return true;
}

// A header pin of a plain session asks for this when it paints with no icon
// (characters off). An untitled session has nothing to draw from yet; its pin
// asks again once a title lands.
export const requestSessionIcon = mutation({
  args: { api_token: v.optional(v.string()), conversation_id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (userId) await performRequestSessionIcon(ctx, userId, args.conversation_id);
  },
});

/** The brief for a session: its title, kept clear of the concepts of every role the requester sees. */
export const sessionIconBrief = internalQuery({
  args: { conversation_id: v.id("conversations"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<IconBrief | null> => {
    const conv: any = await ctx.db.get(args.conversation_id);
    const title = String(conv?.title ?? "").trim();
    if (!conv || !title || isRoleIcon(conv.drawn_icon)) return null;
    const roles = await performViewerRoles(ctx, args.user_id);
    return {
      role_id: String(conv._id),
      title,
      handle: String(conv._id).slice(0, 7),
      siblings: roles.flatMap((r) => (r.icon ? [{ title: r.name, handle: r.handle, icon: r.icon }] : [])),
      examples: ROLE_ICON_EXAMPLES,
      accent: pickRoleIconAccent([], String(conv._id)),
    };
  },
});

export const drawSessionIcon = internalAction({
  args: { conversation_id: v.id("conversations"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<void> => {
    if (!process.env.ANTHROPIC_API_KEY) return;
    const brief: IconBrief | null = await ctx.runQuery(internal.sessionIcons.sessionIconBrief, args);
    if (!brief) return;
    const scratch: Id<"_storage">[] = [];
    try {
      const result = await generateRoleIcon(brief, deploymentAsk(ctx, scratch));
      console.log(`session icon for ${brief.handle}: ${result.ok ? `"${result.icon.concept}"` : "none"}, ${result.calls} calls, $${modelCost(ICON_MODEL, result.usage).toFixed(3)}`);
      if (result.ok) await ctx.runMutation(internal.sessionIcons.saveSessionIcon, { conversation_id: args.conversation_id, icon: result.icon });
      else console.error(`session icon for ${brief.handle}: ${result.reason}`);
    } catch (err) {
      console.error(`session icon for ${brief.handle} failed:`, err);
    } finally {
      for (const id of scratch) await ctx.storage.delete(id).catch(() => {});
    }
  },
});

export const saveSessionIcon = internalMutation({
  args: { conversation_id: v.id("conversations"), icon: roleIconValidator },
  handler: async (ctx, args): Promise<void> => {
    const conv: any = await ctx.db.get(args.conversation_id);
    if (conv && !isRoleIcon(conv.drawn_icon)) await ctx.db.patch(conv._id, { drawn_icon: args.icon });
  },
});
