// Codecast's Convex Auth setup. The providers, the redirect allowlist and the
// email dedup callback all live in @platform/auth/convex — they were extracted
// from this file — so what stays here is only what is codecast's: the GitHub
// scopes and profile fields, the iOS bundle id the native Apple token is issued
// for, the relay mutation the desktop app redeems, the OTP email templates, the
// deep link schemes, and the two product hooks (view revision, welcome email).
import { convexAuth } from "@convex-dev/auth/server";
import { createAuthConfig } from "@platform/auth/convex";
import { internal } from "./_generated/api";
import { advanceCurrentUserViewRevision } from "./principalViewRevisions";
import { deliver } from "./emails/send";
import { passwordReset, verifyEmail } from "./emails/templates";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth(
  createAuthConfig({
    redirect: {
      deepLinkSchemes: ["codecast://", "exp+codecast://"],
    },
    github: {
      scope: "read:user user:email repo read:org",
      profile(profile: any, tokens: any) {
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
    },
    // The web redirect flow. Its Services ID credentials come from the
    // deployment env (AUTH_APPLE_ID / AUTH_APPLE_SECRET).
    apple: {},
    // The token the iOS app gets from Apple's own system sheet is issued for
    // the app bundle id, NOT the web Services ID.
    appleNative: { audience: "com.ashotp.codecast" },
    desktopRelay: { claimForDesktop: internal.cliAuth.claimForDesktop },
    password: {
      async sendOtp({ email, code, kind }) {
        await deliver(
          email,
          kind === "password-reset"
            ? passwordReset({ code, email })
            : verifyEmail({ code, email }),
          kind,
        );
      },
    },
    // Convex Auth owns the raw mutation ctx in these callbacks, so they cannot
    // use our wrapped mutation builder. Keep the sole exception explicit.
    async onUserCreated(ctx, { userId, email, name }) {
      await advanceCurrentUserViewRevision(ctx.db as any, userId as any);
      // First time this person exists — greet them. Scheduled so a Resend
      // hiccup can never fail the sign-up transaction.
      if (email) {
        await ctx.scheduler.runAfter(0, internal.emails.send.sendWelcome, { email, name });
      }
    },
    async onUserUpdated(ctx, { userId }) {
      await advanceCurrentUserViewRevision(ctx.db as any, userId as any);
    },
  }),
);
