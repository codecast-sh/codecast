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
import { requireTeamAdmin } from "./lib/access";
import { verifyApiToken } from "./apiTokens";
import type { AppId } from "@codecast/shared/contracts";

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
  args: { api_token: v.string(), provider: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const provider = resolveProvider(args.provider);
    if (!provider) return unknownProvider(args.provider);

    if (provider === "linear" || provider === "notion") {
      return await ctx.runAction(api.oauthConnectors.getConnectUrl, {
        provider,
        api_token: args.api_token,
      });
    }
    if (provider === "gmail") {
      return await ctx.runAction(api.googleOAuth.getConnectUrl, { api_token: args.api_token });
    }
    if (provider === "slack") {
      return await ctx.runAction(api.slack.getInstallUrl, {
        api_token: args.api_token,
        scope_type: "team",
      });
    }

    // GitHub is an App INSTALL, not an OAuth authorize: there is no code
    // exchange and no scope list, only a state the install webhook reads back.
    // Same format as the web's githubAppInstallUrl (packages/web/lib/
    // githubAppInstall.ts) — the webhook parses one shape, so both mint one.
    const me: any = await ctx.runQuery(internal.oauthConnectors.resolveTeam, {
      api_token: args.api_token,
    });
    if (!me?.user_id) return { ok: false, error: "not signed in" };
    if (!me?.team_id) return { ok: false, error: "Join or create a team first — GitHub binds to a team" };
    const state = btoa(JSON.stringify({ team_id: String(me.team_id), user_id: String(me.user_id) }));
    const slug = process.env.GITHUB_APP_SLUG || "codecast-sh";
    return { ok: true, url: `https://github.com/apps/${slug}/installations/new?state=${state}` };
  },
});

/* ==========================================================================
 * Disconnect
 * ========================================================================== */

export const cliDisconnect = action({
  args: { api_token: v.string(), provider: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const provider = resolveProvider(args.provider);
    if (!provider) return unknownProvider(args.provider);

    // The connection card is the source of truth for WHICH row a disconnect
    // acts on, so the CLI reads the same answer the web renders — including
    // its rule that a non-admin gets no github disconnect_id at all.
    const { apps }: { apps: any[] } = await ctx.runQuery(api.appConnections.listConnections, {
      api_token: args.api_token,
    });
    const app = apps.find((a) => a.id === provider);
    if (!app) return { ok: false, error: "not signed in" };
    if (app.status !== "connected") return { ok: false, error: `${provider} is not connected` };
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
 *  same admin rule, the same two rows removed. */
export const deleteGithubInstallation = internalMutation({
  args: { api_token: v.string(), installation_id: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { ok: false, error: "Unauthorized" };
    const rowId = ctx.db.normalizeId("github_app_installations", args.installation_id);
    if (!rowId) return { ok: false, error: "no_such_installation" };
    const install = await ctx.db.get(rowId);
    if (!install) return { ok: true };
    await requireTeamAdmin(ctx as any, auth.userId, install.team_id);

    await ctx.db.delete(rowId);
    const token = await ctx.db
      .query("github_installation_tokens")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", install.installation_id))
      .first();
    if (token) await ctx.db.delete(token._id);
    return { ok: true };
  },
});
