// Negative handler tests for the permission matrix (plan 008, step 4). Each
// case drives a real exported function through convex-test as a caller who
// must be refused, and asserts nothing was written. The inventory that ranks
// these cells is plans/security-entrypoint-inventory.json.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { hashToken } from "@platform/auth/convex";
import schema from "./schema";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./users.ts": () => import("./users"),
  "./systemConfig.ts": () => import("./systemConfig"),
  "./githubApi.ts": () => import("./githubApi"),
};

async function seedUsers() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const hidden = await ctx.db.insert("users", { name: "Hidden Person", username: "hidden", github_username: "hidden-gh", bio: "private bio", public_profile_enabled: false } as any);
    const open = await ctx.db.insert("users", { name: "Open Person", username: "open", github_username: "open-gh", public_profile_enabled: true } as any);
    const member = await ctx.db.insert("users", { name: "Member", username: "member" } as any);
    return { hidden, open, member };
  });
  return { t, ...ids };
}

describe("anonymous callers", () => {
  test("cannot read a non-public profile card by id, name or handle", async () => {
    const { t, hidden, open } = await seedUsers();
    expect(await t.query(anyApi.users.getUserByUsername, { user_id: hidden })).toBeNull();
    expect(await t.query(anyApi.users.getUserByUsername, { username: "hidden-gh" })).toBeNull();
    expect(await t.query(anyApi.users.getUserByUsername, { username: "Hidden Person" })).toBeNull();
    expect(await t.query(anyApi.users.getUserByUsername, { username: String(hidden) })).toBeNull();
    // A public profile is still readable, and the card carries no secret.
    const card = await t.query(anyApi.users.getUserByUsername, { user_id: open });
    expect(card?.name).toBe("Open Person");
    expect(Object.keys(card ?? {})).not.toContain("github_access_token");
  });

  test("a signed-in viewer still reads a teammate's card", async () => {
    const { t, hidden, member } = await seedUsers();
    const viewer = t.withIdentity({ subject: `${member}|test` });
    expect((await viewer.query(anyApi.users.getUserByUsername, { user_id: hidden }))?.name).toBe("Hidden Person");
  });

  test("cannot drive the GitHub proxies with a token of their choosing", async () => {
    // convex-test runs internal functions too, so the proof is the registered
    // function's visibility: nothing that accepts a caller-supplied GitHub
    // token may be wire callable. Every such helper is internal, and the only
    // callers are server functions that mint the token themselves.
    const githubApi = await import("./githubApi");
    const publicWithToken: string[] = [];
    for (const [name, fn] of Object.entries(githubApi) as Array<[string, any]>) {
      if (!fn || typeof fn !== "object" || !("isPublic" in fn || "isInternal" in fn)) continue;
      const args = typeof fn.exportArgs === "function" ? String(fn.exportArgs()) : "";
      if (fn.isPublic && args.includes("github_access_token")) publicWithToken.push(name);
    }
    expect(publicWithToken).toEqual([]);
    for (const name of ["postPRComment", "submitPRReview", "getUserRepositories", "syncRepositoryCommits"]) {
      expect((githubApi as any)[name].isInternal, name).toBe(true);
      expect((githubApi as any)[name].isPublic, name).toBeFalsy();
    }
  });

  test("cannot move the fleet minimum version without an admin token", async () => {
    const { t, member } = await seedUsers();
    const memberToken = "a".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("api_tokens", { user_id: member, token_hash: await hashToken(memberToken), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any);
    });
    await expect(t.mutation(anyApi.systemConfig.setMinCliVersion, { version: "9.9.9", api_token: "not-a-token" })).rejects.toThrow("Unauthorized");
    await expect(t.mutation(anyApi.systemConfig.setMinCliVersion, { version: "9.9.9", api_token: memberToken })).rejects.toThrow("Admin access required");
    await expect(t.mutation(anyApi.systemConfig.setMinDesktopVersion, { version: "9.9.9", api_token: memberToken })).rejects.toThrow("Admin access required");
    expect(await t.query(anyApi.systemConfig.getMinCliVersion, {})).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("system_config").collect())).toHaveLength(0);
  });
});
