import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { checkConversationAccess } from "./privacy";

// ── Collaboration grants ──
// A shared link lets anyone read a conversation, and any signed-in viewer co-write
// the draft (see composeSync.ts). Actually *firing* that draft into the live session
// runs commands on the owner's machine, so it takes an explicit, per-session grant.
// The owner approves once; performSessionSend then accepts the grantee's sends.

// The caller's grant row for a conversation, if any. Keyed (conversation, grantee),
// so there is at most one — re-requests reuse it.
async function getGrant(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  granteeId: Id<"users">
): Promise<any | null> {
  return await ctx.db
    .query("collab_grants")
    .withIndex("by_conversation_grantee", (q: any) =>
      q.eq("conversation_id", conversationId).eq("grantee_user_id", granteeId)
    )
    .first();
}

// The send-side gate, called from performSessionSend. True only for a live,
// owner-approved grant — a denied/revoked/requested row does not let a send through.
export async function hasGrantedSendAccess(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">
): Promise<boolean> {
  const grant = await getGrant(ctx, conversationId, userId);
  return grant?.status === "granted";
}

// What this conversation lets the *current* viewer do with the composer. The
// composer reads this to decide between "send", "request access", "waiting", etc.
//  - owner / team  → can send today, no grant needed (unchanged behaviour)
//  - granted        → link recipient the owner approved; can send + run commands
//  - requested      → asked, awaiting the owner's decision
//  - denied/revoked → asked and was turned down (or had access pulled)
//  - shared         → signed in, can co-write, must request before sending
//  - anonymous      → not signed in; read-only until they sign in
export const mySendAccess = query({
  // conversation_id is URL-derived; normalize so a legacy/malformed id reads as
  // "denied" rather than failing v.id() arg validation. (See collabRequests.)
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const conversationId = ctx.db.normalizeId("conversations", args.conversation_id);
    const conversation = conversationId ? await ctx.db.get(conversationId) : null;
    if (!conversation) return { level: "denied" as const };

    if (!userId) return { level: "anonymous" as const };

    const access = await checkConversationAccess(ctx, userId, conversation);
    if (access === "owner") return { level: "owner" as const };
    if (access === "team") return { level: "team" as const };
    if (access !== "shared") return { level: "denied" as const };

    const grant = await getGrant(ctx, conversation._id, userId);
    if (!grant) return { level: "shared" as const };
    return { level: grant.status as "requested" | "granted" | "denied" | "revoked", grant_id: grant._id };
  },
});

// A signed-in link recipient asks the owner to let them send into the session.
// No-ops (returns the live level) for an owner/teammate who can already send, and
// for an already-granted grantee. Pings the owner via the existing permission
// notification so they're prompted even when not watching the conversation.
export const requestSendAccess = mutation({
  // conversation_id is URL-derived; normalize so a malformed id surfaces as the
  // handler's "Conversation not found" rather than an opaque v.id() arg error.
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in to request send access");

    const conversationId = ctx.db.normalizeId("conversations", args.conversation_id);
    const conversation = conversationId ? await ctx.db.get(conversationId) : null;
    if (!conversation || !conversationId) throw new Error("Conversation not found");

    const access = await checkConversationAccess(ctx, userId, conversation);
    if (access === "owner") return { level: "owner" as const };
    if (access === "team") return { level: "team" as const };
    // Only a share-link recipient (not owner, not team) goes through the gate.
    if (access !== "shared") throw new Error("This conversation isn't shared with you");

    const user = await ctx.db.get(userId);
    const name = user?.name || user?.github_username || user?.email || "A teammate";
    const image = user?.image || user?.github_avatar_url;

    const existing = await getGrant(ctx, conversationId, userId);
    if (existing?.status === "granted") return { level: "granted" as const, grant_id: existing._id };

    const now = Date.now();
    let grantId: Id<"collab_grants">;
    if (existing) {
      // Re-ask after a denial/revoke reopens the same row.
      await ctx.db.patch(existing._id, {
        status: "requested" as const,
        grantee_name: name,
        grantee_image: image,
        updated_at: now,
      });
      grantId = existing._id;
    } else {
      grantId = await ctx.db.insert("collab_grants", {
        conversation_id: conversationId,
        grantee_user_id: userId,
        owner_user_id: conversation.user_id,
        status: "requested" as const,
        grantee_name: name,
        grantee_image: image,
        created_at: now,
        updated_at: now,
      });
    }

    try {
      await ctx.runMutation(internal.notificationRouter.emit, {
        event_type: "permission_request" as const,
        actor_user_id: userId,
        entity_type: "conversation" as const,
        entity_id: conversationId.toString(),
        message: `${name} wants to send messages and run commands in this session`,
        conversation_id: conversationId,
        direct_recipient_id: conversation.user_id,
      });
    } catch {}

    return { level: "requested" as const, grant_id: grantId };
  },
});

// The owner approves or denies a pending request. Approving flips the grant to
// "granted" — the grantee's composer (which subscribes via mySendAccess) lights
// up its send button without a reload.
export const decideSendAccess = mutation({
  args: { grant_id: v.id("collab_grants"), allow: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const grant = await ctx.db.get(args.grant_id);
    if (!grant) throw new Error("Request not found");
    if (grant.owner_user_id.toString() !== userId.toString()) {
      throw new Error("Only the session owner can decide this");
    }

    await ctx.db.patch(args.grant_id, {
      status: args.allow ? ("granted" as const) : ("denied" as const),
      updated_at: Date.now(),
    });
    return { status: args.allow ? "granted" : "denied" };
  },
});

// The owner pulls a previously-granted collaborator's send rights. Co-writing is
// unaffected; only the ability to fire into the session is removed.
export const revokeSendAccess = mutation({
  args: { grant_id: v.id("collab_grants") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const grant = await ctx.db.get(args.grant_id);
    if (!grant) return { status: "gone" };
    if (grant.owner_user_id.toString() !== userId.toString()) {
      throw new Error("Only the session owner can revoke this");
    }

    await ctx.db.patch(args.grant_id, { status: "revoked" as const, updated_at: Date.now() });
    return { status: "revoked" };
  },
});

// The owner's view of who has asked for / holds send access on this session.
// Drives the inline approve/deny card and the "people who can send" list.
export const collabRequests = query({
  // conversation_id comes straight from the URL, so a legacy UUID or otherwise
  // malformed id would fail v.id() arg validation and surface as a server error
  // before the handler can degrade gracefully. Accept a string and normalize —
  // normalizeId returns null for anything that isn't a conversations id, so a
  // bad id reads as "no requests". (Mirrors plans.get / docs.webGet.)
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const conversationId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!conversationId) return [];

    const conversation = await ctx.db.get(conversationId);
    if (!conversation || conversation.user_id.toString() !== userId.toString()) return [];

    const grants = await ctx.db
      .query("collab_grants")
      .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
      .collect();

    return grants
      .filter((g: any) => g.status === "requested" || g.status === "granted")
      .sort((a: any, b: any) => b.updated_at - a.updated_at)
      .map((g: any) => ({
        grant_id: g._id,
        grantee_user_id: g.grantee_user_id,
        grantee_name: g.grantee_name,
        grantee_image: g.grantee_image,
        status: g.status,
        updated_at: g.updated_at,
      }));
  },
});
