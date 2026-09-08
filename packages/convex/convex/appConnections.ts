// Connection state for the integrations page and the /capabilities Apps tab:
// for each entry in the shared app catalog (`APP_DESCRIPTORS`), at each scope
// the connector supports, is it connected, who connected it, and when.
//
// Two scopes, answered side by side (appDescriptors.ts SCOPE):
//
//   team      the team the caller is looking at (active_team_id, else the
//             home team), counted only with a live membership behind it. With
//             no such team there are NO team entries — a card that said "not
//             connected" for a workspace the caller is not in would be a lie.
//   personal  the caller themself. Always answered for every connector that
//             takes a personal grant, because a personal connection follows
//             its owner into every workspace.
//
// This module only READS. The connect flows live where they always have —
// Slack in slack.ts (getInstallUrl / completeSlackInstall writing
// `slack_installations`), GitHub in githubApp.ts (the App install webhook
// writing `github_app_installations`), Linear and Notion in oauthConnectors.ts,
// Gmail in googleOAuth.ts — and each revoke path is named by id in the answer
// rather than duplicated here.

import { v } from "convex/values";
import { query } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { canRevokeInstallation } from "./githubApp";
import {
  APP_DESCRIPTORS,
  APP_IDS,
  type AppConnectionScope,
  type AppConnectionStatus,
  type AppConnectionsResult,
  type AppId,
} from "@codecast/shared/contracts";
import { Id } from "./_generated/dataModel";

/** The installer's display name — their name, else email, else honest null. */
async function installerName(
  ctx: { db: any },
  userId: Id<"users"> | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? null;
}

/** S1.5 health stamps as the connector writes them; undefined until it has. */
function healthOf(row: { last_webhook_at?: number; last_sync_at?: number; last_error?: string }) {
  if (row.last_webhook_at === undefined && row.last_sync_at === undefined && row.last_error === undefined) return undefined;
  return { last_webhook_at: row.last_webhook_at, last_sync_at: row.last_sync_at, last_error: row.last_error };
}

/** Who is asking, and at which scope. */
type Lens = {
  userId: Id<"users">;
  scope: AppConnectionScope;
  /** Set for the team lens only. */
  teamId?: Id<"teams">;
  isTeamAdmin: boolean;
};

type Connected = Extract<AppConnectionStatus, { status: "connected" }>;

/**
 * One app's connected state at one lens, or null when nothing is connected
 * there. Each branch reads the table its connector writes, by the index that
 * matches the lens.
 */
async function connectedAt(ctx: { db: any }, id: AppId, lens: Lens): Promise<Connected | null> {
  const { userId, scope, teamId } = lens;

  if (id === "linear" || id === "notion") {
    const row =
      scope === "team"
        ? await ctx.db
            .query("app_installations")
            .withIndex("by_provider_team", (q: any) => q.eq("provider", id).eq("team_id", teamId))
            .first()
        : await ctx.db
            .query("app_installations")
            .withIndex("by_provider_user", (q: any) => q.eq("provider", id).eq("scope_user_id", userId))
            .first();
    if (!row || row.pending_confirm_hash) return null;
    return {
      id,
      status: "connected",
      scope,
      by: await installerName(ctx, row.connected_by),
      by_me: String(row.connected_by) === String(userId),
      at: row.created_at,
      detail: row.account_label ?? undefined,
      // Any member may revoke the team's connection; a personal one is the
      // caller's own (it was read by their id), so always theirs to revoke.
      disconnect_id: String(row._id),
      health: healthOf(row),
    };
  }

  if (id === "gmail") {
    // Personal by design: mail belongs to a person, not a workspace.
    const install = await ctx.db
      .query("google_installations")
      .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
      .first();
    if (!install) return null;
    return {
      id,
      status: "connected",
      scope: "personal",
      by: null,
      by_me: true,
      at: install.created_at,
      detail: install.email ?? undefined,
      health: healthOf(install),
      disconnect_id: String(install._id),
    };
  }

  if (id === "slack") {
    // A team install is the one the team's anchor speaks through; a personal
    // install is what a personal anchor speaks through.
    const install =
      scope === "team"
        ? await ctx.db
            .query("slack_installations")
            .withIndex("by_team", (q: any) => q.eq("team_id", teamId))
            .first()
        : await ctx.db
            .query("slack_installations")
            .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
            .first();
    if (!install) return null;
    return {
      id,
      status: "connected",
      scope,
      by: await installerName(ctx, install.installed_by_user_id),
      by_me: String(install.installed_by_user_id) === String(userId),
      at: install.created_at,
      detail: install.workspace_name ?? undefined,
      // No Slack uninstall path exists server-side, so no disconnect_id —
      // the UI shows nothing rather than a dead button.
    };
  }

  // github
  const install =
    scope === "team"
      ? await ctx.db
          .query("github_app_installations")
          .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
          .first()
      : await ctx.db
          .query("github_app_installations")
          .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
          .first();
  if (!install) return null;
  return {
    id,
    status: "connected",
    scope,
    by: await installerName(ctx, install.installed_by_user_id),
    by_me: String(install.installed_by_user_id ?? "") === String(userId),
    at: install.created_at,
    detail: install.account_login,
    // githubApp.deleteInstallation takes this doc id but applies the revoke
    // rule (team admin, or the personal owner), so only a caller it would
    // accept gets it — a plain member would otherwise see a Disconnect button
    // that can only fail.
    disconnect_id: (await canRevokeInstallation(ctx, userId, install)) ? String(install._id) : undefined,
    health: healthOf(install),
  };
}

export const listConnections = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<AppConnectionsResult> => {
    // No global auth gate in this deployment: every function guards itself.
    // An unauthenticated read returns an empty list rather than throwing,
    // because this query is a subscription that outlives a session expiring
    // (same contract as capabilities.webList).
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { apps: [], team: null };

    const user = await ctx.db.get(userId);
    // The routing fallback every workspace resolver here uses (slack.ts
    // callerAnchor, privacy.ts): the team you are looking at, else your home
    // team. The user row can keep pointing at a team after membership lapses,
    // so the pointer only counts with a live membership row behind it —
    // otherwise a former member could keep reading who connected what.
    let teamId: Id<"teams"> | undefined = user?.active_team_id ?? user?.team_id ?? undefined;
    let isTeamAdmin = false;
    if (teamId) {
      const member = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
        .first();
      if (!member) teamId = undefined;
      else isTeamAdmin = member.role === "admin";
    }
    const teamRow = teamId ? await ctx.db.get(teamId) : null;

    const lenses: Lens[] = [
      ...(teamId ? [{ userId, scope: "team" as const, teamId, isTeamAdmin }] : []),
      { userId, scope: "personal" as const, isTeamAdmin: false },
    ];

    const apps: AppConnectionStatus[] = [];
    for (const id of APP_IDS) {
      const descriptor = APP_DESCRIPTORS[id];
      if (descriptor.connectKind === "coming-soon") {
        apps.push({ id, status: "coming_soon" });
        continue;
      }
      for (const lens of lenses) {
        if (!descriptor.scopes.includes(lens.scope)) continue;
        apps.push((await connectedAt(ctx, id, lens)) ?? { id, status: "not_connected", scope: lens.scope });
      }
    }

    return {
      apps,
      team: teamId ? { id: String(teamId), name: teamRow?.name ?? "your team" } : null,
    };
  },
});
