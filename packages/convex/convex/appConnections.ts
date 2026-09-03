// Connection state for the /capabilities Apps tab: for each entry in the shared
// app catalog (`APP_DESCRIPTORS`), is it connected in the caller's workspace,
// who connected it, when, and at which scope.
//
// This module only READS. The connect flows live where they always have —
// Slack in slack.ts (getInstallUrl / completeSlackInstall writing
// `slack_installations`), GitHub in githubApp.ts (the App install webhook
// writing `github_app_installations`) — and the one existing revoke path
// (githubApp.deleteInstallation) is named by id in the answer rather than
// duplicated here.

import { v } from "convex/values";
import { query } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { APP_DESCRIPTORS, APP_IDS, type AppConnectionStatus } from "@codecast/shared/contracts";
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

export const listConnections = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ apps: AppConnectionStatus[] }> => {
    // No global auth gate in this deployment: every function guards itself.
    // An unauthenticated read returns an empty list rather than throwing,
    // because this query is a subscription that outlives a session expiring
    // (same contract as capabilities.webList).
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { apps: [] };

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

    const apps: AppConnectionStatus[] = [];
    for (const id of APP_IDS) {
      const descriptor = APP_DESCRIPTORS[id];
      if (descriptor.connectKind === "coming-soon") {
        apps.push({ id, status: "coming_soon" });
        continue;
      }

      if (id === "linear" || id === "notion") {
        // Team-scoped connectors from oauthConnectors.ts share one table.
        const row = teamId
          ? await ctx.db
              .query("app_installations")
              .withIndex("by_provider_team", (q: any) => q.eq("provider", id).eq("team_id", teamId))
              .first()
          : null;
        if (!row || row.pending_confirm_hash) {
          apps.push({ id, status: "not_connected" });
        } else {
          const connector = await ctx.db.get(row.connected_by);
          apps.push({
            id,
            status: "connected",
            scope: "team",
            by: (connector as any)?.name ?? (connector as any)?.email ?? null,
            by_me: String(row.connected_by) === String(userId),
            at: row.created_at,
            detail: row.account_label ?? undefined,
            disconnect_id: String(row._id),
            health: healthOf(row),
          });
        }
        continue;
      }

      if (id === "gmail") {
        // Personal by design: mail belongs to a person, not a workspace. The
        // google_installations row is scoped to the caller alone.
        const install = await ctx.db
          .query("google_installations")
          .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
          .first();
        if (!install) {
          apps.push({ id, status: "not_connected" });
        } else {
          apps.push({
            id,
            status: "connected",
            scope: "personal",
            by: null,
            by_me: true,
            at: install.created_at,
            detail: install.email ?? undefined,
            disconnect_id: String(install._id),
          });
        }
        continue;
      }

      if (id === "slack") {
        // A workspace can hold a team install and a personal one; the team
        // install is the one the team's anchor speaks through, so it wins the
        // card. The personal install still reports when it is all there is.
        const teamInstall = teamId
          ? await ctx.db
              .query("slack_installations")
              .withIndex("by_team", (q: any) => q.eq("team_id", teamId))
              .first()
          : null;
        const install =
          teamInstall ??
          (await ctx.db
            .query("slack_installations")
            .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
            .first());
        if (!install) {
          apps.push({ id, status: "not_connected" });
          continue;
        }
        apps.push({
          id,
          status: "connected",
          scope: install.team_id ? "team" : "personal",
          by: await installerName(ctx, install.installed_by_user_id),
          by_me: String(install.installed_by_user_id) === String(userId),
          at: install.created_at,
          detail: install.workspace_name ?? undefined,
          // No Slack uninstall path exists server-side, so no disconnect_id —
          // the UI shows nothing rather than a dead button.
        });
        continue;
      }

      // github — installations bind to a team only.
      const install = teamId
        ? await ctx.db
            .query("github_app_installations")
            .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
            .first()
        : null;
      if (!install) {
        apps.push({ id, status: "not_connected" });
        continue;
      }
      apps.push({
        id,
        status: "connected",
        scope: "team",
        by: await installerName(ctx, install.installed_by_user_id),
        by_me: String(install.installed_by_user_id ?? "") === String(userId),
        at: install.created_at,
        detail: install.account_login,
        // githubApp.deleteInstallation takes this doc id but rejects non-admins
        // (requireTeamAdmin), so only an admin gets it — a plain member would
        // otherwise see a Disconnect button that can only fail.
        disconnect_id: isTeamAdmin ? String(install._id) : undefined,
        health: healthOf(install),
      });
    }

    return { apps };
  },
});
