import type { GenericId } from "convex/values";
import type { ConvexAuthConfig } from "@convex-dev/auth/server";
import { type AuthTables, resolveTables } from "./tables";

export type RedirectParams = {
  /** Deep link prefixes accepted unchanged, e.g. ["codecast://", "exp+codecast://"]. */
  deepLinkSchemes: readonly string[];
  /** The web origin. Default reads process.env.SITE_URL at call time. */
  siteUrl?: string | (() => string | undefined);
};

function resolveSiteUrl(siteUrl: RedirectParams["siteUrl"]): string {
  const raw = typeof siteUrl === "function" ? siteUrl() : siteUrl ?? process.env.SITE_URL;
  return raw?.replace(/\/$/, "") ?? "";
}

export function makeRedirectCallback(params: RedirectParams) {
  return async ({ redirectTo }: { redirectTo: string }): Promise<string> => {
    const invalid = () => new Error(`Invalid redirectTo: ${redirectTo}`);
    if (/[\s\\]/.test(redirectTo) || redirectTo.startsWith("//")) throw invalid();
    const absolute = URL.canParse(redirectTo) ? new URL(redirectTo) : null;
    if (absolute?.username || absolute?.password) throw invalid();
    if (absolute && params.deepLinkSchemes.some((scheme) =>
      /^[a-z][a-z0-9+.-]*:\/\/$/i.test(scheme) &&
      !["http:", "https:"].includes(absolute.protocol) &&
      absolute.protocol === scheme.slice(0, -2).toLowerCase() &&
      redirectTo.startsWith(scheme))) {
      return redirectTo;
    }
    const siteUrl = resolveSiteUrl(params.siteUrl);
    if (!URL.canParse(siteUrl)) throw invalid();
    const site = new URL(siteUrl);
    if (!["http:", "https:"].includes(site.protocol) || site.username || site.password) throw invalid();
    if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) {
      return `${siteUrl}${redirectTo}`;
    }
    if (absolute && absolute.origin === site.origin && ["http:", "https:"].includes(absolute.protocol)) {
      return redirectTo;
    }
    throw invalid();
  };
}

export type UserHooks = {
  /**
   * Runs after a brand new user row is inserted. Codecast advances the view
   * revision and schedules the welcome email here. Runs inside the auth
   * mutation, so use the scheduler for anything that can fail.
   */
  onUserCreated?: (
    ctx: any,
    args: { userId: GenericId<"users">; email?: string; name?: string; profile: Record<string, unknown> },
  ) => Promise<void>;
  /** Runs after an existing row gained profile fields from a later sign-in. */
  onUserUpdated?: (ctx: any, args: { userId: GenericId<"users">; patch: Record<string, unknown> }) => Promise<void>;
};

export type CreateOrUpdateUserParams = UserHooks & {
  tables?: Partial<AuthTables>;
  verifiedCredentialProviders?: readonly string[];
};

export function makeCreateOrUpdateUser(params: CreateOrUpdateUserParams = {}) {
  const tables = resolveTables(params.tables);
  return async (
    ctx: any,
    { existingUserId, profile: rawProfile, type, provider }: Parameters<NonNullable<NonNullable<ConvexAuthConfig["callbacks"]>["createOrUpdateUser"]>>[1],
  ): Promise<GenericId<"users">> => {
    const { emailVerified, phoneVerified, ...profile } = rawProfile;
    const email = typeof profile.email === "string" ? profile.email.toLowerCase().trim() : undefined;
    if (email !== undefined) profile.email = email;
    const verified = emailVerified === true && !!email &&
      (type === "oauth" || type === "verification" ||
        (type === "credentials" && params.verifiedCredentialProviders?.includes(provider.id)));
    let existing = existingUserId ? await ctx.db.get(existingUserId) : null;
    if (!existingUserId && email) {
      const matches = await (ctx.db as any)
        .query(tables.users)
        .withIndex(tables.usersEmailIndex, (q: any) => q.eq("email", email))
        .collect();
      if (type === "credentials" && provider.id === "password" && matches.length > 0) {
        throw new Error("Sign in with your existing method or reset your password");
      }
      const verifiedMatches = [];
      for (const user of matches) {
        const accounts = typeof user.emailVerificationTime === "number" ? [] : await ctx.db.query("authAccounts")
          .withIndex("userIdAndProvider", (q: any) => q.eq("userId", user._id)).collect();
        if (typeof user.emailVerificationTime === "number" || accounts.some((account: any) =>
          typeof account.emailVerified === "string" && account.emailVerified.trim().toLowerCase() === email)) {
          verifiedMatches.push(user);
        }
      }
      if (verified && verifiedMatches.length === 1) existing = verifiedMatches[0];
    }
    if (existing) {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(profile)) {
        if (v != null && existing[k] == null) patch[k] = v;
      }
      if (verified && (!existing.email || existing.email.toLowerCase().trim() === email) && existing.emailVerificationTime == null) {
        patch.emailVerificationTime = Date.now();
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
        await params.onUserUpdated?.(ctx, { userId: existing._id, patch });
      }
      return existing._id;
    }
    if (existingUserId) throw new Error("Account user no longer exists");
    const userId = await ctx.db.insert(tables.users, {
      ...profile,
      ...(verified ? { emailVerificationTime: Date.now() } : {}),
      created_at: Date.now(),
    });
    await params.onUserCreated?.(ctx, {
      userId,
      email,
      name: typeof profile.name === "string" ? profile.name : undefined,
      profile,
    });
    return userId;
  };
}
