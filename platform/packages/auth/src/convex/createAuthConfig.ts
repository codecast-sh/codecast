// Build the object passed to convexAuth(). The app's auth.ts becomes:
//
//   export const { auth, signIn, signOut, store, isAuthenticated } =
//     convexAuth(createAuthConfig({ ...params }));
import type { ConvexAuthConfig } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import GitHub from "@auth/core/providers/github";
import Apple from "@auth/core/providers/apple";
import Google from "@auth/core/providers/google";
import { makeCreateOrUpdateUser, makeRedirectCallback, type RedirectParams, type UserHooks } from "./callbacks";
import {
  appleNativeProvider,
  desktopRelayProvider,
  otpEmailProvider,
  type AppleNativeParams,
  type DesktopRelayParams,
  type SendOtp,
} from "./providers";
import type { AuthTables } from "./tables";

export const DEFAULT_SESSION_TOTAL_MS = 1000 * 60 * 60 * 24 * 365 * 10; // 10 years
export const DEFAULT_SESSION_INACTIVE_MS = 1000 * 60 * 60 * 24 * 365 * 2; // 2 years
export const DEFAULT_JWT_DURATION_MS = 1000 * 60 * 60 * 24 * 365; // 1 year

export type GitHubProfile = Record<string, any>;
export type GitHubTokens = { access_token?: string; [k: string]: unknown };

/** The default GitHub profile mapping: the four standard fields and nothing else. */
export function basicGitHubProfile(profile: GitHubProfile) {
  return {
    id: String(profile.id),
    email: profile.email,
    name: profile.name ?? profile.login,
    image: profile.avatar_url,
  };
}

/** The Apple web redirect flow profile mapping. Apple sends the name only once. */
export function appleWebProfile(profile: Record<string, any>) {
  return {
    id: profile.sub,
    email: profile.email,
    name: profile.name
      ? `${profile.name.firstName ?? ""} ${profile.name.lastName ?? ""}`.trim()
      : profile.email?.split("@")[0],
    image: undefined,
  };
}

export type AuthConfigParams = UserHooks & {
  /** Redirect allowlist (deep link schemes and the site URL). */
  redirect: RedirectParams;
  tables?: Partial<AuthTables>;
  session?: { totalDurationMs?: number; inactiveDurationMs?: number };
  jwt?: { durationMs?: number };
  /**
   * Omit to leave Google out. Credentials come from the deployment env
   * (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, read by `@auth/core`). The
   * default scope is basic profile ("openid email profile"); the default
   * profile mapping is `@auth/core`'s (id, email, name, image).
   */
  google?: {
    /** OAuth scopes, space separated. Default: the provider's basic profile scope. */
    scope?: string;
    /** Which profile fields land on the user row. */
    profile?: (profile: Record<string, any>) => Record<string, unknown>;
  };
  /** Omit to leave GitHub out. */
  github?: {
    /** OAuth scopes, space separated. Codecast: "read:user user:email repo read:org". */
    scope: string;
    /** Which profile fields land on the user row. Default: id, email, name, image. */
    profile?: (profile: GitHubProfile, tokens: GitHubTokens) => Record<string, unknown>;
  };
  /** Omit to leave the Apple web redirect flow out. */
  apple?: { profile?: (profile: Record<string, any>) => Record<string, unknown> };
  /** Omit to leave the native Apple provider out. */
  appleNative?: AppleNativeParams;
  /** Omit to leave the desktop relay provider out. */
  desktopRelay?: DesktopRelayParams;
  /** Omit to leave Password out. */
  password?: {
    sendOtp: SendOtp;
    /**
     * Require email verification at sign-up. Changes the client flow (the
     * signup page must collect the emailed code), so it ships dark. Default
     * reads process.env.AUTH_EMAIL_VERIFICATION === "1".
     */
    emailVerification?: boolean;
    resetProviderId?: string;
    verifyProviderId?: string;
  };
};

export function createAuthConfig(params: AuthConfigParams): ConvexAuthConfig {
  const providers: any[] = [];

  if (params.google) {
    const { scope, profile } = params.google;
    providers.push(
      Google({
        ...(scope ? { authorization: { params: { scope } } } : {}),
        ...(profile
          ? {
              profile(raw: any) {
                return profile(raw) as any;
              },
            }
          : {}),
      }),
    );
  }
  if (params.github) {
    const mapProfile = params.github.profile ?? basicGitHubProfile;
    providers.push(
      GitHub({
        authorization: { params: { scope: params.github.scope } },
        profile(profile: any, tokens: any) {
          return mapProfile(profile, tokens) as any;
        },
      }),
    );
  }
  if (params.apple) {
    const mapProfile = params.apple.profile ?? appleWebProfile;
    providers.push(
      Apple({
        profile(profile: any) {
          return mapProfile(profile) as any;
        },
      }),
    );
  }
  if (params.appleNative) providers.push(appleNativeProvider(params.appleNative));
  if (params.desktopRelay) providers.push(desktopRelayProvider(params.desktopRelay));
  if (params.password) {
    const { sendOtp } = params.password;
    const emailVerificationEnabled =
      params.password.emailVerification ?? process.env.AUTH_EMAIL_VERIFICATION === "1";
    const reset = otpEmailProvider(
      params.password.resetProviderId ?? "resend-otp-password-reset",
      "password-reset",
      sendOtp,
    );
    const verify = otpEmailProvider(
      params.password.verifyProviderId ?? "resend-otp-verify",
      "verify-email",
      sendOtp,
    );
    providers.push(
      Password({
        reset,
        ...(emailVerificationEnabled ? { verify } : {}),
      }),
    );
  }

  return {
    session: {
      totalDurationMs: params.session?.totalDurationMs ?? DEFAULT_SESSION_TOTAL_MS,
      inactiveDurationMs: params.session?.inactiveDurationMs ?? DEFAULT_SESSION_INACTIVE_MS,
    },
    jwt: {
      durationMs: params.jwt?.durationMs ?? DEFAULT_JWT_DURATION_MS,
    },
    callbacks: {
      redirect: makeRedirectCallback(params.redirect),
      createOrUpdateUser: makeCreateOrUpdateUser({
        tables: params.tables,
        onUserCreated: params.onUserCreated,
        onUserUpdated: params.onUserUpdated,
      }) as any,
    },
    providers,
  };
}
