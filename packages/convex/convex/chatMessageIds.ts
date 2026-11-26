import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";

// The CLI prints messages by a short id prefix, so each message-id field of a
// team chat request (http.ts /cli/chat/*) is resolved to the full id first
// (chat.resolveMessageRef); the function still checks access itself.
export async function withChatMessageIds(ctx: any, body: any, ...fields: string[]) {
  for (const field of fields) {
    if (typeof body?.[field] !== "string") continue;
    const { id, error } = await ctx.runQuery(internal.chat.resolveMessageRef, {
      api_token: body.api_token, ref: body[field],
    });
    if (!id) throw new ConvexError({ code: "NOT_FOUND", message: error });
    body[field] = id;
  }
  return body;
}
