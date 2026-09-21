import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { convexAuth } from "@convex-dev/auth/server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAuthConfig } from "./createAuthConfig";
import { makeRedirectCallback } from "./callbacks";
import { makeFakeDb } from "./testDb";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let network: ReturnType<typeof spyOn>;
let githubEmailStatus = 200;
let githubEmails = [{ email: "verified@example.test", verified: true, primary: true }];
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture", alg: "RS256", use: "sig" };
  network = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
    if (String(input) === "https://api.github.com/user") return Response.json({ id: 12, login: "owner", email: "unverified@example.test" });
    if (String(input) === "https://api.github.com/user/emails") return Response.json(githubEmails, { status: githubEmailStatus });
    if (String(input) !== "https://appleid.apple.com/auth/keys") throw new Error(`Unexpected network: ${input}`);
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);
});
afterAll(() => network.mockRestore());

async function token(claims: Record<string, unknown> = {}, subject = "new-apple") {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer("https://appleid.apple.com").setAudience("fixture.app").setSubject(subject)
    .setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
}

function fixture(verify = false, tables: Record<string, any[]> = {}) {
  const sent: any[] = [];
  const config = createAuthConfig({
    redirect: { deepLinkSchemes: ["codecast://"], siteUrl: "https://codecast.sh" },
    appleNative: { audience: "fixture.app" },
    github: { scope: "read:user user:email" },
    password: { emailVerification: verify, sendOtp: async (args) => { sent.push(args); } },
  });
  const db = makeFakeDb({ users: [{ _id: "victim", email: "victim@example.test", emailVerificationTime: 1 }], ...tables });
  const auth = convexAuth(config);
  const ctx: any = { db, auth: { getUserIdentity: async () => null, config } };
  ctx.runMutation = async (_ref: unknown, args: unknown) => (auth.store as any)._handler(ctx, args);
  const provider = (id: string) => {
    const raw = (config.providers as any[]).find((p) => (p.options?.id ?? p.id) === id);
    return { ...raw, ...raw.options };
  };
  return { db, ctx, sent, provider };
}

const password = "fixture-secret-123";
describe("installed auth library identity persistence", () => {
  test("signed Apple claims beat a victim email supplied by the caller", async () => {
    const f = fixture();
    const result = await f.provider("apple-native").authorize({ idToken: await token({ email: "owner@example.test", email_verified: "true" }), email: "victim@example.test" }, f.ctx);
    expect(result.userId).not.toBe("victim");
    expect((await f.db.get(result.userId)).email).toBe("owner@example.test");
    expect(f.db._tables.authAccounts[0]).toMatchObject({ userId: result.userId, providerAccountId: "new-apple", emailVerified: "owner@example.test" });
  });

  test.each([{}, { email: "victim@example.test" }, { email: "victim@example.test", email_verified: false }, { email: "victim@example.test", email_verified: "false" }])("missing or unverified token email grants no existing identity: %j", async (claims) => {
    const f = fixture();
    const result = await f.provider("apple-native").authorize({ idToken: await token(claims), email: "victim@example.test" }, f.ctx);
    expect(result.userId).not.toBe("victim");
    expect((await f.db.get(result.userId)).emailVerificationTime).toBeUndefined();
    expect(f.db._tables.authAccounts[0].emailVerified).toBeUndefined();
  });

  test("verified Apple links the unique verified owner and stores proof outside the user profile", async () => {
    const f = fixture();
    const result = await f.provider("apple-native").authorize({ idToken: await token({ email: "VICTIM@example.test", email_verified: true }) }, f.ctx);
    expect(result.userId).toBe("victim");
    expect((await f.db.get("victim")).emailVerified).toBeUndefined();
  });

  test("a fresh linked OAuth sign-in stamps proof without changing its subject owner", async () => {
    const f = fixture(false, {
      users: [{ _id: "legacy", email: "owner@example.test" }, { _id: "victim", email: "victim@example.test", emailVerificationTime: 1 }],
      authAccounts: [{ _id: "github-account", userId: "legacy", provider: "github", providerAccountId: "42" }],
      authVerifiers: [{ _id: "verifier", signature: "fixture-signature" }],
    });
    await f.ctx.runMutation("auth:store", { args: {
      type: "userOAuth", provider: "github", providerAccountId: "42", signature: "fixture-signature",
      profile: { email: "owner@example.test", emailVerified: true, name: "Owner" },
    } });
    expect((await f.db.get("github-account")).userId).toBe("legacy");
    expect((await f.db.get("legacy")).emailVerificationTime).toBeNumber();
    const apple = await f.provider("apple-native").authorize({ idToken: await token({ email: "owner@example.test", email_verified: true }) }, f.ctx);
    expect(apple.userId).toBe("legacy");
    expect(f.db._tables.users).toHaveLength(2);
  });

  test("a legacy mailbox verification receipt permits legitimate linking", async () => {
    const f = fixture(false, {
      users: [{ _id: "victim", email: "victim@example.test" }],
      authAccounts: [{ _id: "legacy-password", provider: "password", providerAccountId: "victim@example.test", userId: "victim", emailVerified: "victim@example.test" }],
    });
    const result = await f.provider("apple-native").authorize({ idToken: await token({ email: "victim@example.test", email_verified: true }) }, f.ctx);
    expect(result.userId).toBe("victim");
    expect((await f.db.get("victim")).emailVerificationTime).toBeNumber();
  });

  test("ambiguous verified users never resolve by insertion order", async () => {
    const f = fixture(false, { users: [
      { _id: "first", email: "victim@example.test", emailVerificationTime: 1 },
      { _id: "second", email: "victim@example.test", emailVerificationTime: 2 },
    ] });
    const result = await f.provider("apple-native").authorize({ idToken: await token({ email: "victim@example.test", email_verified: true }) }, f.ctx);
    expect(["first", "second"]).not.toContain(result.userId);
    expect(f.db._patched.filter((p: any) => ["first", "second"].includes(p._id))).toEqual([]);
  });

  test.each(["issuer", "audience", "expired", "signature"])("invalid Apple %s leaves account persistence untouched", async (kind) => {
    const signer = kind === "signature" ? (await generateKeyPair("RS256")).privateKey : keys.privateKey;
    const idToken = await new SignJWT({ email: "victim@example.test", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" }).setSubject("new-apple")
      .setIssuer(kind === "issuer" ? "https://evil.test" : "https://appleid.apple.com")
      .setAudience(kind === "audience" ? "different.app" : "fixture.app")
      .setExpirationTime(kind === "expired" ? "-5m" : "5m").sign(signer);
    const f = fixture();
    await expect(f.provider("apple-native").authorize({ idToken }, f.ctx)).rejects.toThrow();
    expect(f.db._inserted).toEqual([]);
    expect(f.db._patched).toEqual([]);
  });

  test("a returning Apple subject retains its owner with absent or changed email", async () => {
    const f = fixture(false, { users: [{ _id: "original" }, { _id: "victim", email: "victim@example.test", emailVerificationTime: 1 }], authAccounts: [{ _id: "apple-account", userId: "original", provider: "apple-native", providerAccountId: "linked-apple" }] });
    for (const claims of [{}, { email: "victim@example.test", email_verified: true }]) {
      expect(await f.provider("apple-native").authorize({ idToken: await token(claims, "linked-apple"), email: "victim@example.test" }, f.ctx)).toEqual({ userId: "original" });
    }
    expect(f.db._inserted).toEqual([]);
    expect(f.db._patched).toEqual([]);
  });

  test("Apple relay email stays usable and an unverified existing user is never adopted", async () => {
    const f = fixture(false, { users: [{ _id: "unverified", email: "relay@privaterelay.appleid.com" }] });
    const result = await f.provider("apple-native").authorize({ idToken: await token({ email: "relay@privaterelay.appleid.com", email_verified: true }) }, f.ctx);
    expect(result.userId).not.toBe("unverified");
    expect((await f.db.get(result.userId)).email).toBe("relay@privaterelay.appleid.com");
  });

  test.each([false, true])("password signup never attaches credentials to an existing identity (verification %s)", async (verify) => {
    const f = fixture(verify);
    await expect(f.provider("password").authorize({ flow: "signUp", email: "victim@example.test", password, emailVerified: true }, f.ctx)).rejects.toThrow();
    expect(f.db._tables.authAccounts ?? []).toEqual([]);
    expect(f.db._patched).toEqual([]);
  });

  test("password signup and login remain usable with verification disabled", async () => {
    const f = fixture();
    const params = { email: "new@example.test", password, redirectTo: "/" };
    const result = await f.provider("password").authorize({ ...params, flow: "signUp" }, f.ctx);
    expect(result.userId).not.toBe("victim");
    expect(await f.provider("password").authorize({ ...params, flow: "signIn" }, f.ctx)).toEqual(result);
    expect((await f.db.get(result.userId)).emailVerificationTime).toBeUndefined();
    expect(f.db._tables.authAccounts[0].secret).not.toBe(password);
    await expect(f.provider("password").authorize({ ...params, flow: "signUp", password: "different-password" }, f.ctx)).rejects.toThrow();
    expect(f.db._tables.authAccounts).toHaveLength(1);
  });

  test("enabled verification sends a code, blocks the session, then verifies through the library", async () => {
    const f = fixture(true, { users: [] });
    const params = { email: "new@example.test", password, redirectTo: "/" };
    expect(await f.provider("password").authorize({ ...params, flow: "signUp" }, f.ctx)).toBeNull();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].kind).toBe("verify-email");
    expect(f.db._tables.authSessions ?? []).toEqual([]);
    const result = await f.provider("password").authorize({ flow: "email-verification", email: params.email, code: f.sent[0].code }, f.ctx);
    expect(result.userId).toBe(f.db._tables.users[0]._id);
    expect(f.db._tables.users[0].emailVerificationTime).toBeNumber();
    expect(f.db._tables.authAccounts[0].emailVerified).toBe(params.email);
    expect(f.db._tables.users[0].emailVerified).toBeUndefined();
  });

  test("password recovery requires the delivered code and preserves the account", async () => {
    const f = fixture(false, { users: [] });
    const params = { email: "new@example.test", password, redirectTo: "/" };
    const initial = await f.provider("password").authorize({ ...params, flow: "signUp" }, f.ctx);
    await f.provider("password").authorize({ flow: "reset", email: params.email, redirectTo: "/" }, f.ctx);
    await expect(f.provider("password").authorize({ flow: "reset-verification", email: params.email, code: "WRONG1", newPassword: "new-fixture-password" }, f.ctx)).rejects.toThrow();
    const reset = await f.provider("password").authorize({ flow: "reset-verification", email: params.email, code: f.sent[0].code, newPassword: "new-fixture-password" }, f.ctx);
    expect(reset.userId).toBe(initial.userId);
    expect(await f.provider("password").authorize({ flow: "signIn", email: params.email, password: "new-fixture-password" }, f.ctx)).toEqual(initial);
  });
});

describe("redirect boundaries", () => {
  const redirect = makeRedirectCallback({ deepLinkSchemes: ["codecast://", "exp+codecast://"], siteUrl: "https://codecast.sh/" });
  test.each(["https://codecast.sh.evil.test/", "https://codecast.sh@evil.test/", "//evil.test/", "/\\evil.test/", "http://codecast.sh/", "javascript:alert(1)", "https://codecast.sh:444/", "https://user@codecast.sh/"])("rejects %s", async (redirectTo) => {
    await expect(redirect({ redirectTo })).rejects.toThrow("Invalid redirectTo");
  });
  test.each(["/inbox", "?code=123", "https://codecast.sh/auth/callback", "codecast://auth/callback", "exp+codecast://auth/callback"])("preserves intended target %s", async (redirectTo) => {
    expect(await redirect({ redirectTo })).toContain(redirectTo);
  });
  test("missing SITE_URL fails closed for web URLs", async () => {
    await expect(makeRedirectCallback({ deepLinkSchemes: [], siteUrl: () => undefined })({ redirectTo: "https://evil.test/" })).rejects.toThrow("Invalid redirectTo");
  });
});


describe("OAuth proof sources", () => {
  function providers() {
    const config = createAuthConfig({
      redirect: { deepLinkSchemes: [], siteUrl: "https://codecast.sh" },
      github: { scope: "read:user user:email" },
      google: {},
      apple: {},
    });
    return (config.providers as any[]).map((p) => ({ ...p, ...p.options }));
  }

  test("GitHub chooses verified email records instead of public profile text", async () => {
    const github = providers().find((p) => p.id === "github");
    githubEmails = [{ email: "unverified@example.test", verified: false, primary: true }, { email: "verified@example.test", verified: true, primary: false }];
    const raw = await github.userinfo.request({ tokens: { access_token: "fixture-only" } });
    expect(github.profile(raw, {})).toMatchObject({ email: "verified@example.test", emailVerified: true });
    githubEmails = [{ email: "unverified@example.test", verified: false, primary: true }];
    const unverified = await github.userinfo.request({ tokens: { access_token: "fixture-only" } });
    expect(github.profile(unverified, {})).toMatchObject({ email: undefined, emailVerified: false });
  });

  test("GitHub email endpoint failure preserves subject login without inventing email proof", async () => {
    const github = providers().find((p) => p.id === "github");
    githubEmailStatus = 403;
    const raw = await github.userinfo.request({ tokens: { access_token: "fixture-only" } });
    githubEmailStatus = 200;
    expect(github.profile(raw, {})).toMatchObject({ id: "12", email: undefined, emailVerified: false });
  });

  test("Google and Apple web require provider verification claims", () => {
    const all = providers();
    for (const id of ["google", "apple"]) {
      const provider = all.find((p) => p.id === id);
      expect(provider.profile({ sub: "subject", email: "owner@example.test", email_verified: false }).emailVerified).toBe(false);
      expect(provider.profile({ sub: "subject", email: "owner@example.test", email_verified: true }).emailVerified).toBe(true);
    }
    expect(all.find((p) => p.id === "apple").profile({ sub: "subject", email: "owner@example.test", email_verified: "false" }).emailVerified).toBe(false);
  });
});
