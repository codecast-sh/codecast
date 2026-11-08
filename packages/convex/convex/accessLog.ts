// The audit log of data access for regulated teams: the open touchpoints that
// have no read of their own to ride (a conversation or a call video opened in
// an app, a file saved from a thread), the CLI routes' records, the staff
// record run.sh writes before it runs anything, and the admin's paged read.
// Every write goes through lib/accessLog.ts, which writes nothing for a team
// that is not regulated.
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { recordRowAccess, recordStaffRead } from "./lib/accessLog";
import { checkConversationAccess } from "./privacy";
import { readableConversation } from "./conversations";
import { resolveCallRef } from "./transcripts";
import { requireTeamAdmin } from "./lib/access";
import { verifyApiToken } from "./apiTokens";

const appClient = v.union(v.literal("web"), v.literal("desktop"), v.literal("mobile"));

/**
 * A person opened a conversation, or saved a file from one, in an app. Called
 * once per open by clients whose viewer belongs to a regulated team; the
 * server decides again from the conversation's own team.
 */
export const noteConversationAccess = mutation({
  args: {
    conversation_id: v.id("conversations"),
    action: v.union(v.literal("open"), v.literal("download")),
    client: appClient,
    detail: v.optional(v.string()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return false;
    if ((await checkConversationAccess(ctx, userId, conv, args.share_token)) === "denied") return false;
    const actor = userId ? { userId } : { label: "Share link holder" };
    return recordRowAccess(ctx, "conversations", conv, { actor, action: args.action, client: args.client, detail: args.detail });
  },
});

/** A person opened a call's recording in an app (the call page's player). */
export const noteCallRecordingOpen = mutation({
  args: { call: v.string(), client: appClient },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    const t = await resolveCallRef(ctx, userId, args.call);
    if (!t) return false;
    return recordRowAccess(ctx, "transcripts", t, { actor: { userId }, action: "open", client: args.client, detail: "recording" });
  },
});

/** The CLI read a conversation (`cast read`, `cast diff`: /cli/read) or exported it (/cli/export). */
export const recordCliConversation = internalMutation({
  args: { api_token: v.string(), conversation_id: v.string(), action: v.union(v.literal("open"), v.literal("export")) },
  handler: async (ctx, args) => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
    if ("error" in access) return false;
    return recordRowAccess(ctx, "conversations", access.conv, { actor: { userId: access.user._id }, action: args.action, client: "cli" });
  },
});

/** The CLI fetched a call's recording files (`cast call snap`: /cli/calls/recordings). */
export const recordCliCallRecording = internalMutation({
  args: { api_token: v.string(), call: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return false;
    const t = await resolveCallRef(ctx, auth.userId, args.call);
    if (!t) return false;
    return recordRowAccess(ctx, "transcripts", t, { actor: { userId: auth.userId }, action: "download", client: "cli", detail: "recording" });
  },
});

/**
 * A staff read through the admin key: packages/convex/run.sh calls this
 * before it runs the function it was asked for. Internal, so only an admin
 * key reaches it. `actor` is the staff member's git identity and machine.
 */
export const recordStaffRun = internalMutation({
  args: { actor: v.string(), fn: v.string(), args_json: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let parsed: unknown = {};
    try {
      parsed = args.args_json ? JSON.parse(args.args_json) : {};
    } catch {
      parsed = args.args_json;
    }
    return recordStaffRead(ctx, { actor: args.actor, fn: args.fn, args: parsed });
  },
});

/** A team's access log, newest first, paged. Team admins only, and only their own team. */
export const listForTeam = query({
  args: { team_id: v.id("teams"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await requireTeamAdmin(ctx, userId, args.team_id);
    const page = await ctx.db
      .query("access_log")
      .withIndex("by_team_at", (q) => q.eq("team_id", args.team_id))
      .order("desc")
      .paginate(args.paginationOpts);
    const names = new Map<string, { name: string; email: string | null } | null>();
    const who = async (id: Id<"users">) => {
      const key = String(id);
      if (!names.has(key)) {
        const u = await ctx.db.get(id);
        names.set(key, u ? { name: u.name || u.email || "Unknown", email: u.email ?? null } : null);
      }
      return names.get(key);
    };
    const rows = [];
    for (const r of page.page) {
      const person = r.actor_user_id ? await who(r.actor_user_id) : null;
      rows.push({
        _id: r._id,
        at: r.at,
        actor: person?.name ?? r.actor_label ?? "Unknown",
        actor_email: person?.email ?? null,
        action: r.action,
        object_table: r.object_table,
        object_id: r.object_id,
        object_short_id: r.object_short_id ?? null,
        client: r.client,
        detail: r.detail ?? null,
      });
    }
    return { ...page, page: rows };
  },
});
