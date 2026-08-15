// The app library — the services a workspace can connect so agents can act
// through them (the /capabilities Apps tab).
//
// This module is the CATALOG, not the wiring. Each descriptor names a service,
// says in plain words what an agent can do once it is connected, and names
// which of the existing connect flows the button runs. The flows themselves
// already exist elsewhere and are not duplicated here:
//
//   oauth-popup         Slack's "Add to Slack" flow (convex/slack.ts
//                       getInstallUrl / completeSlackInstall).
//   github-app-install  The GitHub App install URL (github.com/apps/<slug>/
//                       installations/new; convex/githubApp.ts stores the
//                       installation the webhook reports back).
//   coming-soon         No connector exists yet. The card renders, says so,
//                       and is not clickable. Gmail, Linear and Notion sit
//                       here until their connectors land (Gmail: ct-43101).
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
      "Act on repositories with a scoped token instead of a personal one",
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
      "File an issue from a failing test or a found bug",
      "Move the issue when the fixing PR merges",
      "Pull an issue's description into the session working on it",
    ],
    connectKind: "oauth-popup",
    scope: "team",
  },
  notion: {
    id: "notion",
    name: "Notion",
    tagline: "Read and write the docs your team lives in.",
    bullets: [
      "Turn a session's findings into a page",
      "Answer questions from the docs you share with it",
      "Keep a runbook current as the system changes",
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
    };
