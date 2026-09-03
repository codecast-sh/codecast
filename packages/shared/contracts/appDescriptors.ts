// The app library — the services a workspace can connect so agents can act
// through them (the /capabilities Apps tab).
//
// This module is the CATALOG, not the wiring. Each descriptor names a service,
// says in plain words what an agent can do once it is connected, and names
// which of the existing connect flows the button runs. The flows themselves
// already exist elsewhere and are not duplicated here:
//
//   oauth-popup         An authorize round trip in a popup. Slack runs its own
//                       "Add to Slack" flow (convex/slack.ts getInstallUrl /
//                       completeSlackInstall), Gmail runs convex/googleOAuth.ts,
//                       and Linear and Notion share the generic connector in
//                       convex/oauthConnectors.ts (one PROVIDERS entry each).
//   github-app-install  The GitHub App install URL (github.com/apps/<slug>/
//                       installations/new; convex/githubApp.ts stores the
//                       installation the webhook reports back).
//   coming-soon         No connector exists yet. The card renders, says so,
//                       and is not clickable. No app sits here today; the kind
//                       stays for the next service that arrives before its
//                       connector does.
//
// Connection STATE is not in this file either — `appConnections.listConnections`
// (convex) answers that per workspace, in the `AppConnectionStatus` shape below,
// by joining the tables the connect flows already write.

export const APP_IDS = ["slack", "github", "gmail", "linear", "notion"] as const;

export type AppId = (typeof APP_IDS)[number];

/** Which existing connect flow the card's button runs. */
export type AppConnectKind = "oauth-popup" | "github-app-install" | "coming-soon";

/** Who a connection belongs to once made: the whole team, or one person. */
export type AppConnectionScope = "team" | "personal";

export interface AppDescriptor {
  id: AppId;
  name: string;
  /** One line under the name: what connecting this service is for. */
  tagline: string;
  /**
   * What an agent can concretely do once the service is connected. Three at
   * most, each a real action of the shipped (or planned) connector — never a
   * generic marketing claim.
   */
  bullets: readonly string[];
  connectKind: AppConnectKind;
  /** The scope the shipped connect flow binds to. */
  scope: AppConnectionScope;
}

export const APP_DESCRIPTORS: Record<AppId, AppDescriptor> = {
  slack: {
    id: "slack",
    name: "Slack",
    tagline: "Let agents answer and post where your team already talks.",
    bullets: [
      "Post a summary to the channel you link",
      "Wake when someone @mentions it and reply in the thread",
      "Read the thread it was mentioned in for context",
    ],
    connectKind: "oauth-popup",
    scope: "team",
  },
  github: {
    id: "github",
    name: "GitHub",
    tagline: "Give agents the repositories your team works in.",
    bullets: [
      "Run triggers when a PR opens, gets a comment, or merges",
      "Import a repository's issues as tasks and write changes back",
      "Limit access to the repositories you pick at install",
    ],
    connectKind: "github-app-install",
    scope: "team",
  },
  gmail: {
    id: "gmail",
    name: "Gmail",
    tagline: "Point an agent at an inbox you own.",
    bullets: [
      "Summarize what arrived since you last looked",
      "Draft replies for your review — never send on its own",
      "Label and file mail by rules you state",
    ],
    connectKind: "oauth-popup",
    scope: "personal",
  },
  linear: {
    id: "linear",
    name: "Linear",
    tagline: "Keep issues in step with the code agents ship.",
    bullets: [
      "Import a team or project as a codecast project, issues as tasks",
      "Write a task's title, status, assignee and comments back to the issue",
      "Hand an issue to an agent when it takes the label you choose",
    ],
    connectKind: "oauth-popup",
    scope: "team",
  },
  notion: {
    id: "notion",
    name: "Notion",
    tagline: "Hold the grant now; the reading and writing lands next.",
    bullets: [
      "Connect the workspace and pick the pages you share",
      "No agent surface reads Notion yet — the grant just waits here",
    ],
    connectKind: "oauth-popup",
    scope: "team",
  },
};

/**
 * One app's connection state for the caller's workspace, as
 * `appConnections.listConnections` reports it. Three honest shapes:
 *
 *   coming_soon    no connector exists — nothing to check.
 *   not_connected  a connector exists and this workspace has no row.
 *   connected      who connected it, when, and at which scope. `by` is null
 *                  when the installer's account no longer resolves — absence,
 *                  never a made-up name.
 */
export type AppConnectionStatus =
  | { id: AppId; status: "coming_soon" }
  | { id: AppId; status: "not_connected" }
  | {
      id: AppId;
      status: "connected";
      scope: AppConnectionScope;
      by: string | null;
      by_me: boolean;
      at: number;
      /** The external account it is bound to (Slack workspace name, GitHub org). */
      detail?: string;
      /**
       * Present when an existing revoke path can take this connection down FOR
       * THIS CALLER — the id that path accepts (GitHub: the
       * `github_app_installations` doc id `githubApp.deleteInstallation` takes,
       * handed only to team admins because that mutation rejects everyone
       * else). Absent when no revoke path exists (Slack) or the caller lacks
       * the role, and the UI then shows no Disconnect at all rather than a
       * button that can only fail.
       */
      disconnect_id?: string;
      /**
       * Liveness of the connection itself, as the connector stamps it
       * (docs/architecture/issue-sync.md S1.5: `last_webhook_at`,
       * `last_sync_at` and `last_error` on `app_installations` /
       * `github_app_installations`). Absent means the connector does not
       * stamp health yet — the UI then says nothing rather than reporting a
       * silence it cannot distinguish from a failure.
       */
      health?: {
        last_webhook_at?: number;
        last_sync_at?: number;
        last_error?: string;
      };
    };
