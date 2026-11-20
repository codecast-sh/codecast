// Moving an account to a new sign-in address (accountEmail.ts), under
// convex-test so a thrown mutation rolls back as it does in production: the
// code proves the new address before anything moves, a wrong code costs a try
// that stays counted, the old address stays findable, a password sign-in
// follows, and an address another account signs in with is never taken.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules as modules } from "./testModules.testkit";
import { sha256Hex } from "./lib/hash";

type T = ReturnType<typeof convexTest>;

const OLD = "alex@oldco.dev";
const NEW = "alex@newco.dev";

/** A person who signed in with GitHub and also has a password, both on OLD. */
async function person(t: T, over: Record<string, unknown> = {}) {
  const user = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: OLD, name: "Alex", alternate_emails: ["alex@home.example"], ...over } as any);
    await ctx.db.insert("authAccounts", { userId: id, provider: "github", providerAccountId: "4242", emailVerified: OLD } as any);
    await ctx.db.insert("authAccounts", { userId: id, provider: "password", providerAccountId: OLD, secret: "hash" } as any);
    return id;
  });
  return { user, authed: t.withIdentity({ subject: user }) };
}

/** The test cannot read the mailed code, so it sets one it knows. */
async function knownCode(t: T, user: Id<"users">, code = "123456") {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("work_email_codes").withIndex("by_user", (q) => q.eq("user_id", user)).first();
    await ctx.db.patch(row!._id, { code_hash: await sha256Hex(code) });
  });
}
const codeRow = (t: T, user: Id<"users">) =>
  t.run((ctx) => ctx.db.query("work_email_codes").withIndex("by_user", (q) => q.eq("user_id", user)).first());
const logins = (t: T, user: Id<"users">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", user)).collect())
      .map((a) => [a.provider, a.providerAccountId, a.emailVerified ?? null])
      .sort());
const scheduled = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => ({ name: job.name, args: job.args[0] as any })));

describe("moving an account to a new address", () => {
  test("the code mailed to the new address moves the account, its password sign-in and nothing else", async () => {
    const t = convexTest(schema, modules);
    const { user, authed } = await person(t);

    expect(await authed.mutation(api.accountEmail.requestEmailChange, { email: "  Alex@NewCo.dev " })).toEqual({ sent_to: NEW });
    // Mailed to the new address, worded as a move, and nothing has moved yet.
    const mail = (await scheduled(t)).find((job) => job.name === getFunctionName(internal.teamDiscovery.deliverWorkEmailCode))!;
    expect(mail.args).toMatchObject({ email: NEW, moving: true });
    expect((await t.run((ctx) => ctx.db.get(user)))?.email).toBe(OLD);

    await knownCode(t, user);
    expect(await authed.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "123456" })).toEqual({ changed: true, email: NEW });

    const after = (await t.run((ctx) => ctx.db.get(user)))!;
    expect(after.email).toBe(NEW);
    expect(after.emailVerificationTime).toBeGreaterThan(0);
    // The address it left is still the person's, after the ones already there.
    expect(after.alternate_emails).toEqual(["alex@home.example", OLD]);
    // The password sign-in is typed as the new address; GitHub is keyed by GitHub's id and stays.
    expect(await logins(t, user)).toEqual([["github", "4242", OLD], ["password", NEW, NEW]]);
    expect(await codeRow(t, user)).toBeNull();
    // The old address is told.
    const notice = (await scheduled(t)).find((job) => job.name === getFunctionName(internal.emails.send.sendEmailChanged))!;
    expect(notice.args).toMatchObject({ old_email: OLD, new_email: NEW });
  });

  test("an address already among the person's others is promoted, not listed twice", async () => {
    const t = convexTest(schema, modules);
    const { user, authed } = await person(t, { alternate_emails: [NEW, "alex@home.example"] });
    await authed.mutation(api.accountEmail.requestEmailChange, { email: NEW });
    await knownCode(t, user);
    await authed.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "123456" });
    const after = (await t.run((ctx) => ctx.db.get(user)))!;
    expect(after.email).toBe(NEW);
    expect(after.alternate_emails).toEqual(["alex@home.example", OLD]);
  });

  test("an account with no address gains one", async () => {
    const t = convexTest(schema, modules);
    const user = await t.run((ctx) => ctx.db.insert("users", { name: "Gil" } as any));
    const authed = t.withIdentity({ subject: user });
    await authed.mutation(api.accountEmail.requestEmailChange, { email: NEW });
    await knownCode(t, user);
    expect(await authed.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "123456" })).toEqual({ changed: true, email: NEW });
    const after = (await t.run((ctx) => ctx.db.get(user)))!;
    expect([after.email, after.alternate_emails]).toEqual([NEW, []]);
    // No address was left, so there is nobody to tell.
    expect((await scheduled(t)).some((job) => job.name === getFunctionName(internal.emails.send.sendEmailChanged))).toBe(false);
  });

  test("a wrong code costs a try that stays counted, and five close the code", async () => {
    const t = convexTest(schema, modules);
    const { user, authed } = await person(t);
    await authed.mutation(api.accountEmail.requestEmailChange, { email: NEW });
    await knownCode(t, user);

    for (let tries = 1; tries <= 5; tries++) {
      expect(await authed.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "000000" })).toEqual({ changed: false, error: "That code is not right" });
      // Committed: the count survives the call that made it.
      expect((await codeRow(t, user))?.attempts).toBe(tries);
    }
    // The right digits no longer open it.
    await expect(authed.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "123456" })).rejects.toThrow(/Too many tries/);
    expect((await t.run((ctx) => ctx.db.get(user)))?.email).toBe(OLD);
  });

  test("a code opens only the address it was mailed to", async () => {
    const t = convexTest(schema, modules);
    const { user, authed } = await person(t);

    // A code for the new address neither proves the current one nor moves the account elsewhere.
    await authed.mutation(api.accountEmail.requestEmailChange, { email: NEW });
    await knownCode(t, user);
    await expect(authed.mutation(api.teamDiscovery.confirmWorkEmailCode, { code: "123456" })).rejects.toThrow(/expired/);
    await expect(authed.mutation(api.accountEmail.confirmEmailChange, { email: "alex@elsewhere.dev", code: "123456" })).rejects.toThrow(/expired/);
    expect((await t.run((ctx) => ctx.db.get(user)))?.emailVerificationTime).toBeUndefined();

    // A code for the current address does not move the account.
    await authed.mutation(api.teamDiscovery.sendWorkEmailCode, {});
    await knownCode(t, user);
    await expect(authed.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "123456" })).rejects.toThrow(/expired/);
    expect((await t.run((ctx) => ctx.db.get(user)))?.email).toBe(OLD);
  });

  test("an address another account signs in with is refused, asked or confirmed", async () => {
    const t = convexTest(schema, modules);
    const { user, authed } = await person(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { email: "taken@newco.dev" } as any);
      const stranger = await ctx.db.insert("users", { name: "No primary" } as any);
      await ctx.db.insert("authAccounts", { userId: stranger, provider: "password", providerAccountId: "login@newco.dev", secret: "hash" } as any);
    });
    await expect(authed.mutation(api.accountEmail.requestEmailChange, { email: "taken@newco.dev" })).rejects.toThrow(/Another account/);
    await expect(authed.mutation(api.accountEmail.requestEmailChange, { email: "login@newco.dev" })).rejects.toThrow(/Another account/);
    await expect(authed.mutation(api.accountEmail.requestEmailChange, { email: OLD })).rejects.toThrow(/already your sign-in address/);
    await expect(authed.mutation(api.accountEmail.requestEmailChange, { email: "not an address" })).rejects.toThrow(/does not look like/);
    expect(await codeRow(t, user)).toBeNull();

    // Taken between the ask and the code: the move is refused and nothing changes.
    await authed.mutation(api.accountEmail.requestEmailChange, { email: NEW });
    await knownCode(t, user);
    await t.run((ctx) => ctx.db.insert("users", { email: NEW } as any));
    await expect(authed.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "123456" })).rejects.toThrow(/Another account/);
    expect((await t.run((ctx) => ctx.db.get(user)))?.email).toBe(OLD);
    expect(await logins(t, user)).toEqual([["github", "4242", OLD], ["password", OLD, null]]);
  });

  test("nobody signed in can ask", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.accountEmail.requestEmailChange, { email: NEW })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "123456" })).rejects.toThrow(/Not authenticated/);
  });

  test("a team stays open to the old domain until its admin switches it to the new one", async () => {
    const t = convexTest(schema, modules);
    const { user, authed } = await person(t);
    const team = await t.run(async (ctx) => {
      const id = await ctx.db.insert("teams", { name: "Newco", invite_code: "NEWCO123", created_at: 1, discoverable_domain: "oldco.dev" } as any);
      await ctx.db.insert("team_memberships", { user_id: user, team_id: id, role: "admin", joined_at: 1 } as any);
      return id;
    });
    await authed.mutation(api.accountEmail.requestEmailChange, { email: NEW });
    await knownCode(t, user);
    await authed.mutation(api.accountEmail.confirmEmailChange, { email: NEW, code: "123456" });

    expect(await authed.query(api.teamDiscovery.discoverySettings, { team_id: team })).toEqual({ enabled_domain: "oldco.dev", admin_domain: "newco.dev", admin_domain_proven: true });
    expect(await authed.mutation(api.teamDiscovery.setDiscoverable, { team_id: team, enabled: true })).toEqual({ domain: "newco.dev" });
    expect((await t.run((ctx) => ctx.db.get(team)))?.discoverable_domain).toBe("newco.dev");
  });
});
