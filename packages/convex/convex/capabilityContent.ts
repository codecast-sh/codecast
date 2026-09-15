// Markdown bodies for skills / commands / subagents / snippets.
//
// The fleet inventory cannot carry them: a loaded machine's skills tree is
// megabytes, and the 256KB row budget would drop the machine from the mirror
// rather than store the documents. They ride a sidecar on the heartbeat, one
// small batch per beat, and the reader fetches a single row when a card opens.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { identityText, sanitizeReported } from "./capabilityState";
import {
  MAX_CONTENT_BATCH,
  MAX_CONTENT_BODY_CHARS,
  MAX_NAME_CHARS,
  capDb,
} from "./capabilitiesSchema";

export const reportCapabilityContents = mutation({
  args: {
    api_token: v.string(),
    items: v.array(
      v.object({
        kind: v.string(),
        name: v.string(),
        hash: v.string(),
        body: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const db = capDb(ctx.db);
    const now = Date.now();
    let stored = 0;
    let unchanged = 0;
    for (const raw of args.items.slice(0, MAX_CONTENT_BATCH)) {
      const kind = identityText(raw.kind, 40);
      const name = identityText(raw.name, MAX_NAME_CHARS);
      if (!kind || !name) continue;
      const truncated = raw.body.length > MAX_CONTENT_BODY_CHARS;
      const body = sanitizeReported(raw.body, MAX_CONTENT_BODY_CHARS, "body");
      if (!body) continue;
      const hash = identityText(raw.hash, 32) ?? "";
      const existing = await db
        .query("capability_content")
        .withIndex("by_user_kind_name", (q: any) =>
          q.eq("user_id", auth.userId).eq("kind", kind).eq("name", name),
        )
        .first();
      if (existing) {
        if (existing.body_hash === hash && existing.body === body) {
          unchanged += 1;
          continue;
        }
        await db.patch(existing._id, {
          body,
          body_hash: hash,
          truncated: truncated || undefined,
          updated_at: now,
        });
        stored += 1;
        continue;
      }
      await db.insert("capability_content", {
        user_id: auth.userId as unknown as string,
        kind,
        name,
        body,
        body_hash: hash,
        truncated: truncated || undefined,
        updated_at: now,
      });
      stored += 1;
    }
    return { stored, unchanged };
  },
});

export const webCapabilityContent = query({
  args: {
    kind: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const kind = identityText(args.kind, 40);
    const name = identityText(args.name, MAX_NAME_CHARS);
    if (!kind || !name) return null;
    const row = await capDb(ctx.db)
      .query("capability_content")
      .withIndex("by_user_kind_name", (q: any) =>
        q.eq("user_id", userId).eq("kind", kind).eq("name", name),
      )
      .first();
    if (!row) return null;
    return {
      kind: row.kind,
      name: row.name,
      body: row.body,
      truncated: row.truncated === true,
      updated_at: row.updated_at,
    };
  },
});
