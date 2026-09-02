// The two custom credentials providers and the OTP email provider factory.
import { createAccount, retrieveAccount } from "@convex-dev/auth/server";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { Email } from "@convex-dev/auth/providers/Email";
import { alphabet, generateRandomString } from "oslo/crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { GenericId } from "convex/values";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

export type AppleNativeParams = {
  /** The iOS app bundle id. The native token's audience is this, NOT the web Services ID. */
  audience: string;
  /** Provider id the client passes to signIn(). Default "apple-native". */
  id?: string;
};

// Native "Sign in with Apple": the iOS app presents Apple's own system sheet
// (expo-apple-authentication) and sends us the resulting identity token. We
// verify it here instead of running the web redirect OAuth flow, which on a
// native app depends on a Services ID Return URL match and an in-app browser:
// fragile, and the source of the App Store 2.1 rejection.
export function appleNativeProvider(params: AppleNativeParams) {
  const id = params.id ?? "apple-native";
  const jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  return ConvexCredentials({
    id,
    authorize: async (args: Record<string, unknown>, ctx: any) => {
      const idToken = args.idToken as string | undefined;
      if (!idToken) throw new Error("Missing Apple identity token");
      // Verify signature against Apple's public keys + the standard claims.
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: APPLE_ISSUER,
        audience: params.audience,
      });
      const appleSub = payload.sub;
      if (!appleSub) throw new Error("Apple identity token missing subject");
      // Apple only returns name/email on the FIRST authorization; fall back to the
      // token's email (present when the user shares it) on later sign-ins.
      const tokenEmail = typeof payload.email === "string" ? payload.email : undefined;
      const email = ((args.email as string | undefined) ?? tokenEmail)?.toLowerCase().trim();
      const name = (args.fullName as string | undefined)?.trim() || email?.split("@")[0];

      // Returning user: the (provider, appleSub) account already exists.
      try {
        const existing = await retrieveAccount(ctx, {
          provider: id,
          account: { id: appleSub },
        });
        return { userId: existing.user._id };
      } catch {
        // No account yet; fall through to create one.
      }

      // New account. shouldLinkViaEmail folds this into an existing user with the
      // same (Apple verified) email, so signing in via Apple after GitHub/password
      // doesn't mint a duplicate user. The createOrUpdateUser callback is the
      // second layer of the same dedup.
      const created = await createAccount(ctx, {
        provider: id,
        account: { id: appleSub },
        profile: { email, name } as any,
        shouldLinkViaEmail: true,
      });
      return { userId: created.user._id };
    },
  });
}

export type DesktopRelayParams = {
  /**
   * The app's `internal.cliAuth.claimForDesktop` reference (built by
   * makeCliAuthFunctions). Called with `{ nonce }`, answers `{ userId } | null`.
   */
  claimForDesktop: any;
  /** Provider id. Default "desktop-relay". */
  id?: string;
};

// Desktop app sign-in: the Electron window is a blank browser profile with no
// provider cookies, so running OAuth inside it strands the user on provider
// login walls. Instead the desktop opens the user's system browser at
// /auth/cli?mode=desktop with a one time nonce; the signed in browser deposits
// a relay grant (cliAuth.deposit), and the desktop redeems it here for a normal
// first class session. The claim is single use with a short TTL, and it
// consumes the relayed api token in the same transaction, so nothing long
// lived is minted along the way.
export function desktopRelayProvider(params: DesktopRelayParams) {
  return ConvexCredentials({
    id: params.id ?? "desktop-relay",
    authorize: async (args: Record<string, unknown>, ctx: any) => {
      const nonce = args.nonce;
      if (typeof nonce !== "string" || nonce.length < 32) {
        throw new Error("Missing desktop sign-in nonce");
      }
      const claimed = await ctx.runMutation(params.claimForDesktop, { nonce });
      if (!claimed) throw new Error("Desktop sign-in was not authorized");
      return { userId: claimed.userId as GenericId<"users"> };
    },
  });
}

export type OtpKind = "password-reset" | "verify-email";

/** Inject the app's email sender. @platform/email can plug in here. */
export type SendOtp = (args: { email: string; code: string; kind: OtpKind }) => Promise<void>;

export const OTP_MAX_AGE_SECONDS = 60 * 15;

export function generateOtpCode(): string {
  return generateRandomString(6, alphabet("0-9", "A-Z"));
}

/** Six character code from 0-9A-Z, valid fifteen minutes, delivered through `sendOtp`. */
export function otpEmailProvider(id: string, kind: OtpKind, sendOtp: SendOtp) {
  return Email({
    id,
    maxAge: OTP_MAX_AGE_SECONDS,
    async generateVerificationToken() {
      return generateOtpCode();
    },
    async sendVerificationRequest({ identifier: email, token }) {
      await sendOtp({ email, code: token, kind });
    },
  });
}
