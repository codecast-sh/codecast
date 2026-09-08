// One entry point for `cast integrations connect|disconnect <provider>`.
//
// Every provider already has a connect flow and a revoke path; what none of
// them had was a way in that authenticates with an api_token instead of a
// browser session. So this module resolves the caller from the token and then
// DELEGATES — it holds no OAuth logic, no URL formats and no token handling of
// its own. A second copy of any of those is precisely the drift that would let
// the CLI connect one team while the web card reports another.
//
// docs/architecture/issue-sync.md S10.

import { v } from "convex/values";
import { action, internalMutation } from "./functions";
import { api, internal } from "./_generated/api";
import { verifyApiToken } from "./apiTokens";
import { deleteInstallationRows, requireInstallationRevoker } from "./githubApp";
import {
  APP_DESCRIPTORS,
  githubAppInstallState,
  githubAppInstallUrlFor,
  isAppConnectionScope,
  type AppConnectionScope,
  type AppId,
} from "@codecast/shared/contracts";

/** The scope a CLI call named, defaulting to team like the web buttons do. */
function scopeArg(raw: string | undefined, provider: AppId): AppConnectionScope | { error: string } {
  const scope: AppConnectionScope = isAppConnectionScope(raw) ? raw : "team";
  const supported = APP_DESCRIPTORS[provider].scopes;
  if (!supported.includes(scope)) {
    return { error: `${APP_DESCRIPTORS[provider].name} connects at ${supported.join(" or ")} scope only` };
  }
  return scope;
}

/** CLI spellings the user may type, mapped to the catalog id. */
const PROVIDER_ALIASES: Record<string, AppId> = {
  slack: "slack",
  github: "github",
  gmail: "gmail",
  google: "gmail",
  mail: "gmail",
  linear: "linear",
  notion: "notion",
};

function resolveProvider(raw: string): AppId | null {
  return PROVIDER_ALIASES[raw.trim().toLowerCase()] ?? null;
}

const unknownProvider = (raw: string) => ({
  ok: false as const,
  error: `Unknown integration "${raw}" — try slack, github, gmail, linear or notion`,
});

/* ==========================================================================
 * Connect
 * ========================================================================== */

export const cliConnectUrl = action({
  args: { api_token: v.string(), provider: v.string(), scope: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const provider = resolveProvider(args.provider);
    if (!provider) return unknownProvider(args.provider);
    const scope = scopeArg(args.scope, provider);
    if (typeof scope !== "string") return { ok: false, error: scope.error };

    if (provider === "linear" || provider === "notion") {
      return await ctx.runAction(api.oauthConnectors.getConnectUrl, {
        provider,
        scope,
        api_token: args.api_token,
      });
    }
    if (provider === "gmail") {
      return await ctx.runAction(api.googleOAuth.getConnectUrl, { api_token: args.api_token });
    }
    if (provider === "slack") {
      return await ctx.runAction(api.slack.getInstallUrl, {
        api_token: args.api_token,
        scope_type: scope === "team" ? "team" : "user",
      });
    }

    // GitHub is an App INSTALL, not an OAuth authorize: there is no code
    // exchange and no scope list, only a state the install webhook reads back
    // (githubAppInstallState, shared with the web button and the callback).
    const me: any = await ctx.runQuery(internal.oauthConnectors.resolveTeam, {
      api_token: args.api_token,
    });
    if (!me?.user_id) return { ok: false, error: "not signed in" };
    const state = githubAppInstallState({
      userId: String(me.user_id),
      scope,
      teamId: me.team_id ? String(me.team_id) : null,
    });
    if (!state) return { ok: false, error: "Join or create a team first, or connect GitHub with --personal" };
    return { ok: true, url: githubAppInstallUrlFor(process.env.GITHUB_APP_SLUG || "codecast-sh", state) };
  },
});

/* ==========================================================================
 * Disconnect
 * ========================================================================== */

export const cliDisconnect = action({
  args: { api_token: v.string(), provider: v.string(), scope: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const provider = resolveProvider(args.provider);
    if (!provider) return unknownProvider(args.provider);

    // The connection card is the source of truth for WHICH row a disconnect
    // acts on, so the CLI reads the same answer the web renders — including
    // its rule that a non-admin gets no github disconnect_id at all. With no
    // scope named, the one connected entry is the target; two connected
    // entries need the caller to say which.
    const { apps }: { apps: any[] } = await ctx.runQuery(api.appConnections.listConnections, {
      api_token: args.api_token,
    });
    const entries = apps.filter((a) => a.id === provider);
    if (entries.length === 0) return { ok: false, error: "not signed in" };
    const connected = entries.filter((a) => a.status === "connected");
    const app = isAppConnectionScope(args.scope)
      ? entries.find((a) => a.scope === args.scope)
      : connected.length === 1
        ? connected[0]
        : undefined;
    if (!app && connected.length > 1) {
      return { ok: false, error: `${provider} is connected at team and personal scope — name one with --personal or --team` };
    }
    if (!app || app.status !== "connected") return { ok: false, error: `${provider} is not connected` };
    if (!app.disconnect_id) {
      return {
        ok: false,
        error:
          provider === "slack"
            ? "Slack has no server-side uninstall — remove the Codecast app from the Slack workspace"
            : `Disconnecting ${provider} needs a team admin`,
      };
    }

    if (provider === "gmail") {
      return await ctx.runAction(api.googleOAuth.disconnect, {
        api_token: args.api_token,
        installation_id: app.disconnect_id,
      });
    }
    if (provider === "linear" || provider === "notion") {
      const me: any = await ctx.runQuery(internal.oauthConnectors.resolveTeam, {
        api_token: args.api_token,
      });
      if (!me?.user_id) return { ok: false, error: "not signed in" };
      return await ctx.runMutation(internal.oauthConnectors.deleteConnection, {
        user_id: String(me.user_id),
        installation_id: app.disconnect_id,
      });
    }
    return await ctx.runMutation(internal.integrations.deleteGithubInstallation, {
      api_token: args.api_token,
      installation_id: app.disconnect_id,
    });
  },
});

/** githubApp.deleteInstallation's twin for a token-authenticated caller: the
 *  same revoke rule, the same rows removed. */
export const deleteGithubInstallation = internalMutation({
  args: { api_token: v.string(), installation_id: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { ok: false, error: "Unauthorized" };
    const rowId = ctx.db.normalizeId("github_app_installations", args.installation_id);
    if (!rowId) return { ok: false, error: "no_such_installation" };
    const install = await ctx.db.get(rowId);
    if (!install) return { ok: true };
    await requireInstallationRevoker(ctx, auth.userId, install);
    await deleteInstallationRows(ctx, install);
    return { ok: true };
  },
});
