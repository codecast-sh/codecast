import { describe, expect, test } from "bun:test";
import { generateShareLink, revokeShareLink } from "./conversations";
import { checkConversationAccess } from "./privacy";

// One link, one permission: "anyone with the link" is the token, and turning it
// off must kill every copy of the link, never leave the old one working.
function ctxFor(userId: string, row: Record<string, unknown>) {
  const rows = new Map([[row._id as string, row]]);
  return {
    rows,
    auth: { async getUserIdentity() { return { subject: `${userId}|session` }; } },
    db: {
      async get(id: string) { return rows.get(id) ?? null; },
      async patch(id: string, patch: Record<string, unknown>) { rows.set(id, { ...rows.get(id), ...patch }); },
    },
  };
}

const conv = () => ({ _id: "c1", user_id: "owner", is_private: true, share_token: "old-token", profile_pinned_at: 5 });

describe("revokeShareLink", () => {
  test("clears the token and the profile pin, so the old link stops working", async () => {
    const ctx = ctxFor("owner", conv());
    expect(await checkConversationAccess(ctx as any, null, ctx.rows.get("c1") as any, "old-token")).toBe("shared");
    await expect((revokeShareLink as any)._handler(ctx, { conversation_id: "c1" })).resolves.toEqual({ revoked: true });
    const after = ctx.rows.get("c1")!;
    expect(after.share_token).toBeUndefined();
    expect(after.profile_pinned_at).toBeUndefined();
    expect(await checkConversationAccess(ctx as any, null, after as any, "old-token")).toBe("denied");
  });

  test("turning the link back on mints a new token; the revoked one stays dead", async () => {
    const ctx = ctxFor("owner", conv());
    await (revokeShareLink as any)._handler(ctx, { conversation_id: "c1" });
    const token = await (generateShareLink as any)._handler(ctx, { conversation_id: "c1" });
    expect(token).not.toBe("old-token");
    const row = ctx.rows.get("c1") as any;
    expect(await checkConversationAccess(ctx as any, null, row, "old-token")).toBe("denied");
    expect(await checkConversationAccess(ctx as any, null, row, token)).toBe("shared");
  });

  test("only the owner can revoke", async () => {
    const ctx = ctxFor("someone_else", conv());
    await expect((revokeShareLink as any)._handler(ctx, { conversation_id: "c1" })).rejects.toThrow("Unauthorized");
    expect(ctx.rows.get("c1")!.share_token).toBe("old-token");
  });
});
