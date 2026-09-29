import { describe, expect, test } from "bun:test";
import { writeShareLink } from "./conversations";
import { checkConversationAccess } from "./privacy";

// One link, one permission: "anyone with the link" is the token, and turning it
// off must kill every copy of the link, never leave the old one working.
function ctxFor(rows: Record<string, unknown>[]) {
  const byId = new Map(rows.map((r) => [r._id as string, r]));
  return {
    byId,
    db: {
      normalizeId: (_table: string, id: string) => (byId.has(id) ? id : null),
      async get(id: string) { return byId.get(id) ?? null; },
      async patch(id: string, patch: Record<string, unknown>) { byId.set(id, { ...byId.get(id), ...patch }); },
      query(_table: string) {
        let token: unknown;
        const q = { eq: (_f: string, v: unknown) => ((token = v), q) };
        return {
          withIndex(_i: string, fn: (q: unknown) => unknown) {
            fn(q);
            return { async first() { return [...byId.values()].find((r) => r.share_token === token) ?? null; } };
          },
        };
      },
    },
  };
}

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-9222-222222222222";
const conv = () => ({ _id: "c1", user_id: "owner", is_private: true, share_token: OLD, profile_pinned_at: 5 });
const access = (ctx: any, token: string) => checkConversationAccess(ctx, null, ctx.byId.get("c1"), token);

describe("writeShareLink", () => {
  test("off clears the token and the profile pin, so the old link stops working", async () => {
    const ctx = ctxFor([conv()]);
    expect(await access(ctx, OLD)).toBe("shared");
    await writeShareLink(ctx as any, "owner" as any, "c1", null);
    expect(ctx.byId.get("c1")!.share_token).toBeUndefined();
    expect(ctx.byId.get("c1")!.profile_pinned_at).toBeUndefined();
    expect(await access(ctx, OLD)).toBe("denied");
  });

  test("back on takes the new token; the revoked one stays dead", async () => {
    const ctx = ctxFor([conv()]);
    await writeShareLink(ctx as any, "owner" as any, "c1", null);
    await writeShareLink(ctx as any, "owner" as any, "c1", NEW);
    expect(await access(ctx, OLD)).toBe("denied");
    expect(await access(ctx, NEW)).toBe("shared");
  });

  test("refuses a weak token and one another conversation holds", async () => {
    const ctx = ctxFor([{ ...conv(), share_token: undefined }, { _id: "c2", user_id: "other", share_token: NEW }]);
    await expect(writeShareLink(ctx as any, "owner" as any, "c1", "abc")).rejects.toThrow("Invalid share token");
    await expect(writeShareLink(ctx as any, "owner" as any, "c1", NEW)).rejects.toThrow("Invalid share token");
    expect(ctx.byId.get("c1")!.share_token).toBeUndefined();
  });

  test("only the owner can change it", async () => {
    const ctx = ctxFor([conv()]);
    await expect(writeShareLink(ctx as any, "someone_else" as any, "c1", null)).rejects.toThrow("Unauthorized");
    expect(ctx.byId.get("c1")!.share_token).toBe(OLD);
  });
});
