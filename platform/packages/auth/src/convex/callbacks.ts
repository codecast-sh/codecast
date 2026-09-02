// The two convexAuth callbacks that matter: the deep link allowlist and the
// email dedup on user creation.
import type { GenericId } from "convex/values";
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

/**
 * Accepts the deep link schemes unchanged, resolves paths and query strings
 * against the site URL, accepts absolute URLs under the site URL, and throws on
 * everything else.
 */
export function makeRedirectCallback(params: RedirectParams) {
  return async ({ redirectTo }: { redirectTo: string }): Promise<string> => {
    if (params.deepLinkSchemes.some((scheme) => redirectTo.startsWith(scheme))) {
      return redirectTo;
    }
    const siteUrl = resolveSiteUrl(params.siteUrl);
    if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) {
      return `${siteUrl}${redirectTo}`;
    }
    if (redirectTo.startsWith(siteUrl)) {
      return redirectTo;
    }
    throw new Error(`Invalid redirectTo: ${redirectTo}`);
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

export type CreateOrUpdateUserParams = UserHooks & { tables?: Partial<AuthTables> };

/**
 * Dedupe users by email across providers. Without this, signing in via a
 * second provider (GitHub then Apple, password then OAuth) creates a new users
 * row even when the email is the same, leaving orphan CLI sessions and
 * conversations stamped under a duplicate id.
 */
export function makeCreateOrUpdateUser(params: CreateOrUpdateUserParams = {}) {
  const tables = resolveTables(params.tables);
  return async (
    ctx: any,
    { existingUserId, profile }: { existingUserId: GenericId<"users"> | null; profile: Record<string, any> },
  ): Promise<GenericId<"users">> => {
    if (existingUserId) return existingUserId;
    const email = profile.email?.toLowerCase().trim();
    if (email) {
      // ctx.db is typed as GenericMutationCtx<AnyDataModel> in this callback, so
      // the custom email index isn't visible to TS. The app defines it in its
      // schema at users.
      const existing = await (ctx.db as any)
        .query(tables.users)
        .withIndex(tables.usersEmailIndex, (q: any) => q.eq("email", email))
        .first();
      if (existing) {
        // Patch in any newly provided profile fields the existing row lacks
        // (e.g. github_username learned from a later OAuth sign-in).
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(profile)) {
          if (v == null) continue;
          if ((existing as any)[k] == null) patch[k] = v;
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, patch);
          await params.onUserUpdated?.(ctx, { userId: existing._id, patch });
        }
        return existing._id;
      }
    }
    const userId = await ctx.db.insert(tables.users, {
      ...(profile as any),
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
