// Who is calling a live artifact function, and whether they may: shared by
// liveArtifacts.ts (content) and livePresence.ts (cursors). A leaf: it
// defines no functions, so both entry modules import it without a cycle.
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import { verifyApiToken } from "../apiTokens";
import { requireAccessibleDoc, resolveSessionConversation } from "./access";
import { isArtifactDocType, presenceColor, PRESENCE_TTL_MS } from "@codecast/shared/artifacts";

export type Caller = {
  userId: Id<"users">;
  /** "u:<userId>" for a person, "s:<conversationId>" for an agent session. */
  actor: string;
  name: string;
  kind: "person" | "agent";
  image?: string;
  conversation?: Doc<"conversations"> | null;
};

export const vCaller = { api_token: v.optional(v.string()), session_id: v.optional(v.string()) };

export function userName(user: any): string {
  return user?.name || user?.github_username || user?.email?.split("@")[0] || "Someone";
}

/**
 * The caller of a web or CLI request. A CLI call naming the session it runs
 * in acts as that session (its own name, color and cursor); the session must
 * be one the token's account runs.
 */
export async function resolveCaller(ctx: any, args: { api_token?: string; session_id?: string }): Promise<Caller> {
  let userId: Id<"users"> | null = null;
  if (args.api_token) {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Unauthorized" });
    userId = auth.userId as Id<"users">;
  } else {
    userId = await getAuthUserId(ctx);
  }
  if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Not authenticated" });
  const user = await ctx.db.get(userId);
  const conversation = args.api_token && args.session_id ? await resolveSessionConversation(ctx, userId, args.session_id) : null;
  if (conversation && String(conversation.user_id) === String(userId)) {
    return {
      userId,
      actor: `s:${conversation._id}`,
      name: conversation.short_title || conversation.title || "Agent session",
      kind: "agent",
      conversation,
    };
  }
  return { userId, actor: `u:${userId}`, name: userName(user), kind: "person", image: user?.image || user?.github_avatar_url || undefined };
}

export async function requireLiveDoc(ctx: any, userId: Id<"users">, docId: Id<"docs">): Promise<Doc<"docs">> {
  const doc = await requireAccessibleDoc(ctx, userId, docId);
  if (!isArtifactDocType(doc.doc_type)) throw new ConvexError(`${doc.title} is a ${doc.doc_type}, not a board, sheet or dashboard`);
  if (doc.archived_at) throw new ConvexError("This artifact is archived");
  return doc;
}


/** Upsert one participant's presence row; a new arrival sweeps out the departed. */
export async function upsertPresence(
  ctx: any,
  docId: Id<"docs">,
  caller: Caller,
  actor: string,
  at: { position?: any; selection?: string[]; status?: string },
) {
  const existing = await ctx.db
    .query("live_presence")
    .withIndex("by_doc_actor", (q: any) => q.eq("doc_id", docId).eq("actor", actor))
    .first();
  const fields = {
    kind: caller.kind,
    user_id: caller.userId,
    name: caller.name,
    color: presenceColor(caller.kind === "agent" ? caller.actor : `u:${caller.userId}`, caller.kind),
    image: caller.image,
    session_id: caller.conversation?._id ? String(caller.conversation._id) : undefined,
    session_short_id: (caller.conversation as any)?.short_id ?? undefined,
    position: at.position,
    selection: at.selection?.slice(0, 200),
    status: at.status?.slice(0, 80),
    updated_at: Date.now(),
  };
  if (existing) await ctx.db.patch(existing._id, fields);
  else {
    await ctx.db.insert("live_presence", { doc_id: docId, actor, ...fields });
    // A new arrival sweeps out whoever left without saying so (a closed tab, a finished session).
    const stale = await ctx.db
      .query("live_presence")
      .withIndex("by_doc_updated", (q: any) => q.eq("doc_id", docId).lt("updated_at", Date.now() - PRESENCE_TTL_MS.agent))
      .take(50);
    for (const r of stale) await ctx.db.delete(r._id);
  }
}
