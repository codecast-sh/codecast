import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";

// The same materialization convexAuth applies at runtime (provider_utils
// materializeProvider): deep merge `options` into the provider, so ids and
// authorization params read as deployed.
function materializeProvider(provider: any): any {
  const isObject = (x: any) => x && typeof x === "object" && !Array.isArray(x);
  const merge = (target: any, source: any): any => {
    if (!isObject(source)) return target;
    for (const key of Object.keys(source)) {
      if (isObject(source[key])) {
        if (!isObject(target[key])) target[key] = {};
        merge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  };
  const { options, ...rest } = provider;
  return merge({ ...rest }, options);
}
import { createAuthConfig, DEFAULT_JWT_DURATION_MS, DEFAULT_SESSION_INACTIVE_MS, DEFAULT_SESSION_TOTAL_MS } from "./createAuthConfig";

// Codecast's parameters, exactly as its convex/auth.ts sets them. The config
// this produces must match the donor: same provider ids in the same order,
// same durations, same redirect allowlist, same email dedup behavior.
function codecastConfig(hooks: { created: any[]; updated: any[]; sent: any[] }) {
  return createAuthConfig({
    redirect: { deepLinkSchemes: ["codecast://", "exp+codecast://"], siteUrl: "https://codecast.sh/" },
    github: {
      scope: "read:user user:email repo read:org",
      profile: (profile, tokens) => ({
        id: String(profile.id),
        email: profile.email,
        name: profile.name ?? profile.login,
        image: profile.avatar_url,
        github_id: String(profile.id),
        github_username: profile.login,
        github_avatar_url: profile.avatar_url,
        github_access_token: tokens.access_token,
      }),
    },
    apple: {},
    appleNative: { audience: "com.ashotp.codecast" },
    desktopRelay: { claimForDesktop: "internal.cliAuth.claimForDesktop" },
    password: {
      sendOtp: async (args) => { hooks.sent.push(args); },
      emailVerification: false,
    },
    onUserCreated: async (_ctx, args) => { hooks.created.push(args); },
    onUserUpdated: async (_ctx, args) => { hooks.updated.push(args); },
  });
}

function hooks() {
  return { created: [] as any[], updated: [] as any[], sent: [] as any[] };
}

describe("createAuthConfig with codecast's parameters", () => {
  test("produces the donor's five providers, in order", () => {
    const config = codecastConfig(hooks());
    const ids = (config.providers as any[]).map((p) => materializeProvider(p).id);
    expect(ids).toEqual(["github", "apple", "apple-native", "desktop-relay", "password"]);
  });

  test("keeps the donor's session and JWT durations", () => {
    const config = codecastConfig(hooks());
    expect(config.session).toEqual({
      totalDurationMs: 1000 * 60 * 60 * 24 * 365 * 10,
      inactiveDurationMs: 1000 * 60 * 60 * 24 * 365 * 2,
    });
    expect(config.jwt).toEqual({ durationMs: 1000 * 60 * 60 * 24 * 365 });
    expect(DEFAULT_SESSION_TOTAL_MS).toBe(config.session!.totalDurationMs!);
    expect(DEFAULT_SESSION_INACTIVE_MS).toBe(config.session!.inactiveDurationMs!);
    expect(DEFAULT_JWT_DURATION_MS).toBe(config.jwt!.durationMs!);
  });

  test("github carries codecast's scopes and profile fields", () => {
    const config = codecastConfig(hooks());
    const github = materializeProvider((config.providers as any[])[0]) as any;
    expect(github.authorization.params.scope).toBe("read:user user:email repo read:org");
    const row = github.profile(
      { id: 42, login: "octo", name: null, email: "o@x.io", avatar_url: "https://a/v.png" },
      { access_token: "gho_x" },
    );
    expect(row).toEqual({
      id: "42",
      email: "o@x.io",
      name: "octo",
      image: "https://a/v.png",
      github_id: "42",
      github_username: "octo",
      github_avatar_url: "https://a/v.png",
      github_access_token: "gho_x",
    });
  });

  test("google (whisk's provider) materializes with the basic profile default", () => {
    const config = createAuthConfig({
      redirect: { deepLinkSchemes: [], siteUrl: "https://mail.app" },
      google: {},
    });
    const ids = (config.providers as any[]).map((p) => materializeProvider(p).id);
    expect(ids).toEqual(["google"]);
    // No scope override: @auth/core's basic profile scope stands.
    const google = materializeProvider((config.providers as any[])[0]) as any;
    expect(google.authorization?.params?.scope).toBeUndefined();
  });

  test("redirect is the donor's allowlist", async () => {
    const redirect = codecastConfig(hooks()).callbacks!.redirect!;
    expect(await redirect({ redirectTo: "codecast://inbox" })).toBe("codecast://inbox");
    expect(await redirect({ redirectTo: "exp+codecast://auth/callback" })).toBe("exp+codecast://auth/callback");
    expect(await redirect({ redirectTo: "/inbox?x=1" })).toBe("https://codecast.sh/inbox?x=1");
    expect(await redirect({ redirectTo: "?return_to=/a" })).toBe("https://codecast.sh?return_to=/a");
    expect(await redirect({ redirectTo: "https://codecast.sh/settings" })).toBe("https://codecast.sh/settings");
    await expect(redirect({ redirectTo: "https://evil.example/x" })).rejects.toThrow("Invalid redirectTo");
  });

  test("createOrUpdateUser dedupes by lowercased email and patches missing fields", async () => {
    const h = hooks();
    const cb = codecastConfig(h).callbacks!.createOrUpdateUser!;
    const db = makeFakeDb({
      users: [{ _id: "users_1", email: "jane@x.io", name: "Jane", created_at: 1 }],
    });
    const ctx = { db, scheduler: { runAfter: async () => {} } } as any;

    const id = await cb(ctx, {
      existingUserId: null,
      profile: { email: "Jane@X.io ", name: "Jane", github_username: "jane", image: null },
      type: "oauth",
      provider: {} as any,
    } as any);
    expect(id).toBe("users_1" as any);
    expect(db._inserted).toEqual([]);
    expect(db._patched).toEqual([{ _id: "users_1", patch: { github_username: "jane" } }]);
    expect(h.updated).toEqual([{ userId: "users_1", patch: { github_username: "jane" } }]);
    expect(h.created).toEqual([]);
  });

  test("createOrUpdateUser inserts a new user and runs onUserCreated once", async () => {
    const h = hooks();
    const cb = codecastConfig(h).callbacks!.createOrUpdateUser!;
    const db = makeFakeDb({ users: [] });
    const ctx = { db } as any;
    const id = await cb(ctx, {
      existingUserId: null,
      profile: { email: "new@x.io", name: "New" },
    } as any);
    expect(db._inserted.length).toBe(1);
    expect(db._inserted[0].doc.email).toBe("new@x.io");
    expect(typeof db._inserted[0].doc.created_at).toBe("number");
    expect(h.created).toEqual([{ userId: id, email: "new@x.io", name: "New", profile: { email: "new@x.io", name: "New" } }]);
  });

  test("an existing user id short circuits", async () => {
    const cb = codecastConfig(hooks()).callbacks!.createOrUpdateUser!;
    const db = makeFakeDb({ users: [] });
    expect(await cb({ db } as any, { existingUserId: "users_9", profile: { email: "a@b.c" } } as any)).toBe("users_9" as any);
    expect(db._inserted).toEqual([]);
  });

  test("password reset provider sends a six character 0-9A-Z code through sendOtp", async () => {
    const h = hooks();
    const password = materializeProvider((codecastConfig(h).providers as any[])[4]) as any;
    const reset = materializeProvider(password.reset) as any;
    expect(reset.id).toBe("resend-otp-password-reset");
    expect(reset.maxAge).toBe(900);
    const code = await reset.generateVerificationToken();
    expect(code).toMatch(/^[0-9A-Z]{6}$/);
    await reset.sendVerificationRequest({ identifier: "p@x.io", token: code });
    expect(h.sent).toEqual([{ email: "p@x.io", code, kind: "password-reset" }]);
  });

  test("email verification stays dark unless asked for", () => {
    const dark = materializeProvider((codecastConfig(hooks()).providers as any[])[4]) as any;
    expect(dark.verify).toBeUndefined();
    const lit = createAuthConfig({
      redirect: { deepLinkSchemes: [] },
      password: { sendOtp: async () => {}, emailVerification: true },
    });
    const p = materializeProvider((lit.providers as any[])[0]) as any;
    expect(materializeProvider(p.verify).id).toBe("resend-otp-verify");
  });
});
