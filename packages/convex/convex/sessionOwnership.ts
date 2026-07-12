import { mutation, internalMutation } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { checkConversationAccess } from "./privacy";

// Second-party session ownership: assign a human OWNER to a session run by a
// different member's account (the Aivery flow: a Mr Bot fix session parks with
// a "ready to ship?" question and self-owns onto the responsible founder, whose
// inbox then treats it as actionable). Ownership only affects where a session
// SURFACES and who may reply from the web composer — the send/steer mechanics
// (pending_messages) are unchanged. Besides this explicit path, a cross-user
// send into an UNOWNED session auto-owns it onto the sender (performSessionSend).

type OwnerInfo = { user_id: string; name: string | null; email: string | null };

// The mutation body, factored out so tests can drive it with an explicit
// authUserId (mirrors performSessionSend).
export async function performSetSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string | null }
): Promise<{ ok: true; short_id: string; owner: OwnerInfo | null }> {
  // Runner-or-team, exactly cast send's access rule: the running account may
  // (re)assign its own sessions, and any teammate may claim/reassign a session
  // they can already see. A merely share-linked viewer may not.
  const conversation = await findConversationByAnyRefWhere(ctx, args.session_id, async (candidate) => {
    const access = await checkConversationAccess(ctx, authUserId, candidate);
    return access === "owner" || access === "team";
  });
  if (!conversation) {
    throw new Error(
      `No session found for "${args.session_id}" (you can only set an owner on your own sessions or sessions shared with your team)`
    );
  }
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);

  const ownerRef = args.owner?.trim() ?? null;
  if (!ownerRef) {
    await ctx.db.patch(conversation._id, { owner_user_id: undefined });
    return { ok: true, short_id: shortId, owner: null };
  }

  let ownerUser: any = null;
  if (ownerRef.toLowerCase() === "me") {
    ownerUser = await ctx.db.get(authUserId);
  } else {
    if (!conversation.team_id) {
      throw new Error(`Session ${shortId} has no team — an owner must be a teammate. Use "me" to claim it yourself.`);
    }
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", conversation.team_id))
      .collect();
    const members = (
      await Promise.all(memberships.map((m: any) => ctx.db.get(m.user_id)))
    ).filter(Boolean) as any[];
    const needle = ownerRef.toLowerCase();
    // Exact email, then exact name, then a UNIQUE substring match — scripts pass
    // exact emails; the looser tiers are for humans at the CLI.
    ownerUser =
      members.find((u) => (u.email || "").toLowerCase() === needle) ??
      members.find((u) => (u.name || "").toLowerCase() === needle) ??
      null;
    if (!ownerUser) {
      const fuzzy = members.filter(
        (u) => (u.name || "").toLowerCase().includes(needle) || (u.email || "").toLowerCase().includes(needle)
      );
      if (fuzzy.length === 1) ownerUser = fuzzy[0];
      else if (fuzzy.length > 1) {
        const names = fuzzy.map((u) => u.name || u.email).join(", ");
        throw new Error(`"${args.owner}" matches multiple team members (${names}) — use an exact email`);
      }
    }
    if (!ownerUser) {
      throw new Error(`No team member found matching "${args.owner}"`);
    }
  }

  // Bots may CALL this to park a session on a human (the Aivery flow), but may
  // never BE the owner — ownership means "this human's inbox is responsible,"
  // and nobody reads a bot's inbox.
  if (ownerUser.is_bot) {
    throw new Error(
      `${ownerUser.name || ownerUser.email || "That user"} is an agent account — sessions can only be owned by a human team member`
    );
  }

  await ctx.db.patch(conversation._id, { owner_user_id: ownerUser._id });
  return {
    ok: true,
    short_id: shortId,
    owner: { user_id: ownerUser._id.toString(), name: ownerUser.name ?? null, email: ownerUser.email ?? null },
  };
}

// Admin: flag a full agent member account (e.g. Mr Bot) as is_bot so the
// ownership guards apply to it. Anchor identities get the flag at creation;
// agent accounts that predate it (or are created by plain signup) need this
// one-off. Run via `npx convex run sessionOwnership:flagBotAccount '{"ref":"…"}'`.
// Idempotent; `ref` matches exact email, exact name, or unique substring.
export const flagBotAccount = internalMutation({
  args: { ref: v.string() },
  handler: async (ctx, args) => {
    const needle = args.ref.trim().toLowerCase();
    const users = await ctx.db.query("users").collect();
    const matches = users.filter(
      (u: any) =>
        (u.email || "").toLowerCase() === needle ||
        (u.name || "").toLowerCase() === needle ||
        (u.email || "").toLowerCase().includes(needle) ||
        (u.name || "").toLowerCase().includes(needle)
    );
    // Prefer exact hits so a substring can't shadow an exact match.
    const exact = matches.filter(
      (u: any) => (u.email || "").toLowerCase() === needle || (u.name || "").toLowerCase() === needle
    );
    const pool = exact.length > 0 ? exact : matches;
    if (pool.length !== 1) {
      const names = pool.map((u: any) => `${u.name ?? "?"} <${u.email ?? "?"}>`).join(", ");
      throw new Error(
        pool.length === 0
          ? `No user matching "${args.ref}"`
          : `"${args.ref}" matches multiple users (${names}) — use an exact email`
      );
    }
    const user = pool[0];
    if (!user.is_bot) await ctx.db.patch(user._id, { is_bot: true });
    return { user_id: user._id.toString(), name: user.name ?? null, email: user.email ?? null, already_flagged: !!user.is_bot };
  },
});

export const setSessionOwner = mutation({
  args: {
    // Any session ref: short_id (jx…), Claude session UUID, or conversation _id.
    session_id: v.string(),
    // Team member email (exact, preferred for scripts) or name; "me" to claim
    // for the caller; null/absent to clear (disown).
    owner: v.optional(v.union(v.string(), v.null())),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    return performSetSessionOwner(ctx, authUserId, {
      session_id: args.session_id,
      owner: args.owner ?? null,
    });
  },
});
