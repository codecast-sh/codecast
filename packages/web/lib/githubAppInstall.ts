// The ONE place the web mints the GitHub App install URL. The state format
// itself is shared with the CLI's connect-url action and the install callback
// (`githubAppInstallState` in shared contracts), so the workspace an
// installation binds to cannot drift between the three.

import {
  githubAppInstallState,
  githubAppInstallUrlFor,
  type AppConnectionScope,
} from "@codecast/shared/contracts";

/** The fields of the current user this helper reads. */
export interface GithubInstallUser {
  _id: string;
  team_id?: string;
  active_team_id?: string;
}

/**
 * The team a TEAM install binds to for this user: the team they are looking
 * at, else their home team — the SAME resolution the server uses to answer
 * "is GitHub connected" (`appConnections.listConnections`,
 * `active_team_id ?? team_id`). Resolving differently here would install into
 * one team while the card reports another and never flips to Connected.
 */
export function githubAppInstallTeam(user: GithubInstallUser): string | undefined {
  return user.active_team_id ?? user.team_id;
}

/**
 * The App install URL at `scope`, carrying the workspace and user in the
 * `state` the install callback reads back (`convex/http.ts`). Null for a team
 * install when the user has no team — there is nothing to bind it to. A
 * personal install needs no team.
 */
export function githubAppInstallUrl(user: GithubInstallUser, scope: AppConnectionScope = "team"): string | null {
  const state = githubAppInstallState({ userId: user._id, scope, teamId: githubAppInstallTeam(user) });
  if (!state) return null;
  return githubAppInstallUrlFor(import.meta.env.VITE_GITHUB_APP_SLUG || "codecast-sh", state);
}
