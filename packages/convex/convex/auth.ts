import { convexAuth, createAccount, retrieveAccount } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { Email } from "@convex-dev/auth/providers/Email";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import GitHub from "@auth/core/providers/github";
import Apple from "@auth/core/providers/apple";
import { alphabet, generateRandomString } from "oslo/crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { advanceCurrentUserViewRevision } from "./principalViewRevisions";
import { deliver } from "./emails/send";
import { passwordReset, verifyEmail } from "./emails/templates";

// Native "Sign in with Apple": the iOS app presents Apple's own system sheet
// (expo-apple-authentication) and sends us the resulting identity token. We
// verify it here instead of running the web-redirect OAuth flow, which on a
// native app depends on a Services-ID Return URL match and an in-app browser —
// fragile, and the source of the App Store 2.1 rejection. The token's audience
// for the native flow is the app bundle id, NOT the web Services ID.
const APPLE_NATIVE_AUDIENCE = "com.ashotp.codecast";
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

const AppleNative = ConvexCredentials({
  id: "apple-native",
  authorize: async (params: Record<string, unknown>, ctx: any) => {
    const idToken = params.idToken as string | undefined;
    if (!idToken) throw new Error("Missing Apple identity token");
    // Verify signature against Apple's public keys + the standard claims.
    const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: APPLE_NATIVE_AUDIENCE,
    });
    const appleSub = payload.sub;
    if (!appleSub) throw new Error("Apple identity token missing subject");
    // Apple only returns name/email on the FIRST authorization; fall back to the
    // token's email (present when the user shares it) on later sign-ins.
    const tokenEmail = typeof payload.email === "string" ? payload.email : undefined;
    const email = ((params.email as string | undefined) ?? tokenEmail)?.toLowerCase().trim();
    const name = (params.fullName as string | undefined)?.trim() || email?.split("@")[0];

    // Returning user — the (provider, appleSub) account already exists.
    try {
      const existing = await retrieveAccount(ctx, {
        provider: "apple-native",
        account: { id: appleSub },
      });
      return { userId: existing.user._id };
    } catch {
      // No account yet — fall through to create one.
    }

    // New account. shouldLinkViaEmail folds this into an existing user with the
    // same (Apple-verified) email, so signing in via Apple after GitHub/password
    // doesn't mint a duplicate user. The createOrUpdateUser callback below is the
    // second layer of the same dedup.
    const created = await createAccount(ctx, {
      provider: "apple-native",
      account: { id: appleSub },
      profile: { email, name } as any,
      shouldLinkViaEmail: true,
    });
    return { userId: created.user._id };
  },
});

// Desktop app sign-in (GitHub issue #20): the Electron window is a blank
// browser profile — no Google/GitHub cookies — so running OAuth inside it
// strands the user on provider login walls. Instead the desktop opens the
// user's system browser at /auth/cli?mode=desktop with a one-time nonce; the
// signed-in browser deposits a relay grant (cliAuth.deposit), and the desktop
// redeems it here for a normal first-class session. The claim is single-use
// with a short TTL, and it consumes the relayed api token in the same
// transaction, so nothing long-lived is minted along the way.
const DesktopRelay = ConvexCredentials({
  id: "desktop-relay",
  authorize: async (params: Record<string, unknown>, ctx: any) => {
    const nonce = params.nonce;
    if (typeof nonce !== "string" || nonce.length < 32) {
      throw new Error("Missing desktop sign-in nonce");
    }
    const claimed = await ctx.runMutation(internal.cliAuth.claimForDesktop, { nonce });
    if (!claimed) throw new Error("Desktop sign-in was not authorized");
    return { userId: claimed.userId as Id<"users"> };
  },
});

const ResendOTPPasswordReset = Email({
  id: "resend-otp-password-reset",
  maxAge: 60 * 15,
  async generateVerificationToken() {
    return generateRandomString(6, alphabet("0-9", "A-Z"));
  },
  async sendVerificationRequest({ identifier: email, token }) {
    await deliver(email, passwordReset({ code: token, email }), "password-reset");
  },
});

const ResendOTPVerify = Email({
  id: "resend-otp-verify",
  maxAge: 60 * 15,
  async generateVerificationToken() {
    return generateRandomString(6, alphabet("0-9", "A-Z"));
  },
  async sendVerificationRequest({ identifier: email, token }) {
    await deliver(email, verifyEmail({ code: token, email }), "verify-email");
  },
});

// Requiring email verification at password sign-up changes the client flow
// (the signup page must collect the emailed code), so it ships dark: the web
// UI handles the verification step first, then this env var flips it on in
// the Convex dashboard. Enabling it before the web UI ships would strand
// password signups.
const emailVerificationEnabled = process.env.AUTH_EMAIL_VERIFICATION === "1";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  session: {
    totalDurationMs: 1000 * 60 * 60 * 24 * 365 * 10, // 10 years
    inactiveDurationMs: 1000 * 60 * 60 * 24 * 365 * 2, // 2 years
  },
  jwt: {
    durationMs: 1000 * 60 * 60 * 24 * 365, // 1 year
  },
  callbacks: {
    async redirect({ redirectTo }) {
      if (redirectTo.startsWith("codecast://") || redirectTo.startsWith("exp+codecast://")) {
        return redirectTo;
      }
      const siteUrl = process.env.SITE_URL?.replace(/\/$/, "") ?? "";
      if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) {
        return `${siteUrl}${redirectTo}`;
      }
      if (redirectTo.startsWith(siteUrl)) {
        return redirectTo;
      }
      throw new Error(`Invalid redirectTo: ${redirectTo}`);
    },
    // Dedupe users by email across providers. Without this, signing in via
    // a second provider (GitHub then Apple, password then OAuth, etc.)
    // creates a new users row even when the email is the same — leaving
    // orphan CLI sessions and conversations stamped under a duplicate id.
    // We had exactly one such case in prod (jasoncbenn@gmail.com).
    async createOrUpdateUser(ctx, { existingUserId, profile }) {
      if (existingUserId) return existingUserId;
      const email = profile.email?.toLowerCase().trim();
      if (email) {
        // ctx.db is typed as GenericMutationCtx<AnyDataModel> in this
        // callback, so the custom `email` index isn't visible to TS — cast
        // to access it. (Index is defined in schema.ts at users.)
        const existing = await (ctx.db as any)
          .query("users")
          .withIndex("email", (q: any) => q.eq("email", email))
          .first();
        if (existing) {
          // Patch in any newly-provided profile fields the existing row lacks
          // (e.g. github_username learned from a later OAuth sign-in).
          const patch: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(profile)) {
            if (v == null) continue;
            if ((existing as any)[k] == null) patch[k] = v;
          }
          if (Object.keys(patch).length > 0) {
            await ctx.db.patch(existing._id, patch);
            // Convex Auth owns this raw mutation callback, so it cannot use our
            // wrapped mutation builder. Keep the sole exception explicit.
            await advanceCurrentUserViewRevision(ctx.db as any, existing._id);
          }
          return existing._id;
        }
      }
      const userId = await ctx.db.insert("users", {
        ...(profile as any),
        created_at: Date.now(),
      });
      await advanceCurrentUserViewRevision(ctx.db as any, userId as any);
      // First time this person exists — greet them. Scheduled so a Resend
      // hiccup can never fail the sign-up transaction.
      if (email) {
        await ctx.scheduler.runAfter(0, internal.emails.send.sendWelcome, {
          email,
          name: typeof profile.name === "string" ? profile.name : undefined,
        });
      }
      return userId;
    },
  },
  providers: [
    GitHub({
      authorization: {
        params: {
          scope: "read:user user:email repo read:org",
        },
      },
      profile(profile, tokens) {
        return {
          id: String(profile.id),
          email: profile.email,
          name: profile.name ?? profile.login,
          image: profile.avatar_url,
          github_id: String(profile.id),
          github_username: profile.login,
          github_avatar_url: profile.avatar_url,
          github_access_token: tokens.access_token,
        };
      },
    }),
    Apple({
      profile(profile) {
        return {
          id: profile.sub,
          email: profile.email,
          name: profile.name
            ? `${profile.name.firstName ?? ""} ${profile.name.lastName ?? ""}`.trim()
            : profile.email?.split("@")[0],
          image: undefined,
        };
      },
    }),
    AppleNative,
    DesktopRelay,
    Password({
      reset: ResendOTPPasswordReset,
      ...(emailVerificationEnabled ? { verify: ResendOTPVerify } : {}),
    }),
  ],
});
