// Codecast's own permission rules (lib/permissionRules.ts): the daemon checks
// a tool call here before it opens a card, and a person sees and removes the
// approvals they kept from Settings.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { boundedRuleRequest, permissionRuleKey, permissionRuleLabel } from "@codecast/shared/contracts/permissionRules";
import { mutation, query } from "./functions";
import { getAuthenticatedUserId } from "./permissions";
import { recordAuthorityEvent } from "./lib/authorityEvents";
import { ruleRequestValidator, rulesForConversation, settle } from "./lib/permissionRules";
import type { Id } from "./_generated/dataModel";

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
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
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
      rule_key: permissionRuleKey(r),
      created_at: r.created_at,
      ...(r.source_conversation_id && { source_conversation_id: r.source_conversation_id }),
    }));
  },
});

/** Adds a rule by hand, where the viewer already keeps rules (Settings >
 *  Approvals offers it per project and workspace). A deny wins over every
 *  allow, attended or not. */
export const add = mutation({
  args: {
    project: v.string(),
    scope: v.string(),
    permission: v.string(),
    pattern: v.string(),
    action: v.union(v.literal("allow"), v.literal("deny")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const pattern = args.pattern.trim().slice(0, 300);
    if (!pattern) throw new Error("A rule needs a pattern");
    if (args.scope !== `user:${userId}`) {
      const teamId = args.scope.startsWith("team:") ? args.scope.slice(5) : null;
      const member = teamId && await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .filter((q: any) => q.eq(q.field("team_id"), teamId))
        .first();
      if (!member) throw new Error("Unauthorized");
    }
    const existing = await ctx.db
      .query("permission_rules")
      .withIndex("by_user_project", (q) => q.eq("user_id", userId).eq("project", args.project))
      .collect();
    const same = existing.find((r) => r.scope === args.scope && r.permission === args.permission && r.pattern === pattern && r.action === args.action);
    if (same) return same._id;
    const id = await ctx.db.insert("permission_rules", {
      user_id: userId, project: args.project, scope: args.scope, permission: args.permission.slice(0, 80), pattern, action: args.action, created_at: Date.now(),
    });
    await recordAuthorityEvent(ctx, {
      kind: "permission_rule_saved",
      actor_user_id: userId,
      detail: { after: { rule_id: id, permission: args.permission, pattern, action: args.action, project: args.project, scope: args.scope } },
    });
    return id;
  },
});

/** Removes one of the viewer's rules. The next matching call asks again. */
export const remove = mutation({
  args: {
    rule_id: v.optional(v.id("permission_rules")),
    // A row the client added and has not seen echoed, named by its fields.
    match: v.optional(v.object({ project: v.string(), scope: v.string(), permission: v.string(), pattern: v.string(), action: v.union(v.literal("allow"), v.literal("deny")) })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const m = args.match;
    const rule = args.rule_id
      ? await ctx.db.get(args.rule_id)
      : m
        ? (await ctx.db.query("permission_rules").withIndex("by_user_project", (q) => q.eq("user_id", userId).eq("project", m.project)).collect())
            .find((r) => r.scope === m.scope && r.permission === m.permission && r.pattern === m.pattern && r.action === m.action) ?? null
        : null;
    if (!rule) return null;
    if (String(rule.user_id) !== String(userId)) throw new Error("Unauthorized");
    await ctx.db.delete(rule._id);
    const conv = rule.source_conversation_id ? await ctx.db.get(rule.source_conversation_id) : null;
    await recordAuthorityEvent(ctx, {
      kind: "permission_rule_removed",
      actor_user_id: userId,
      conversation: conv,
      detail: { before: { permission: rule.permission, pattern: rule.pattern, action: rule.action, project: rule.project, scope: rule.scope } },
    });
    return rule._id;
  },
});
