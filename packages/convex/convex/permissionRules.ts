// Codecast's own permission rules (lib/permissionRules.ts): the daemon checks
// a tool call here before it opens a card, and a person sees and removes the
// approvals they kept from Settings.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { boundedRuleRequest, permissionRuleLabel } from "@codecast/shared/contracts/permissionRules";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { recordAuthorityEvent } from "./lib/authorityEvents";
import { ruleRequestValidator, rulesForConversation, settle } from "./lib/permissionRules";
import type { Id } from "./_generated/dataModel";

async function callerId(ctx: { db: any }, apiToken?: string): Promise<Id<"users"> | null> {
  const session = await getAuthUserId(ctx as any);
  if (session) return session;
  return apiToken ? (await verifyApiToken(ctx, apiToken))?.userId ?? null : null;
}

/** How a tool call in this conversation settles before anyone is asked:
 *  allow, deny (with the message the agent reads), or ask. Only the
 *  conversation's owner may ask. */
export const check = query({
  args: {
    conversation_id: v.id("conversations"),
    request: ruleRequestValidator,
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await callerId(ctx, args.api_token);
    const conv = await ctx.db.get(args.conversation_id);
    if (!userId || !conv || String(conv.user_id) !== String(userId)) return { action: "ask" as const };
    const rules = await rulesForConversation(ctx, conv);
    const settled = settle(conv, boundedRuleRequest(args.request), rules);
    return settled.action === "deny"
      ? { action: "deny" as const, reason: settled.reason, message: settled.message }
      : { action: settled.action };
  },
});

/** The viewer's saved rules, newest first, each with the label a person reads. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("permission_rules")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(500);
    return rows.map((r) => ({
      _id: r._id,
      project: r.project,
      scope: r.scope,
      permission: r.permission,
      pattern: r.pattern,
      action: r.action,
      label: permissionRuleLabel(r),
      created_at: r.created_at,
      ...(r.source_conversation_id && { source_conversation_id: r.source_conversation_id }),
    }));
  },
});

/** Removes one of the viewer's rules. The next matching call asks again. */
export const remove = mutation({
  args: { rule_id: v.id("permission_rules") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const rule = await ctx.db.get(args.rule_id);
    if (!rule) return null;
    if (String(rule.user_id) !== String(userId)) throw new Error("Unauthorized");
    await ctx.db.delete(args.rule_id);
    const conv = rule.source_conversation_id ? await ctx.db.get(rule.source_conversation_id) : null;
    await recordAuthorityEvent(ctx, {
      kind: "permission_rule_removed",
      actor_user_id: userId,
      conversation: conv,
      detail: { before: { permission: rule.permission, pattern: rule.pattern, action: rule.action, project: rule.project, scope: rule.scope } },
    });
    return args.rule_id;
  },
});
