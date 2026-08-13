// The ONE place the GitHub App install URL is minted. Two surfaces start the
// install (settings/integrations/github-app, the /capabilities Apps tab); a
// second copy of the OAuth state format is exactly the divergence that would
// hurt later, so both call this.

/** The fields of the current user this helper reads. */
export interface GithubInstallUser {
  _id: string;
  team_id?: string;
  active_team_id?: string;
}

/**
 * The workspace a GitHub App install binds to for this user: the team they are
 * looking at, else their home team — the SAME resolution the server uses to
 * answer "is GitHub connected" (`appConnections.listConnections`,
 * `active_team_id ?? team_id`). Resolving differently here would install into
 * one team while the card reports another and never flips to Connected.
 */
export function githubAppInstallTeam(user: GithubInstallUser): string | undefined {
  return user.active_team_id ?? user.team_id;
}

/**
 * The App install URL, carrying the team and user in the `state` the install
 * webhook reads back (`convex/http.ts` github callback). Null when the user has
 * no team — there is nothing to bind the installation to.
 */
export function githubAppInstallUrl(user: GithubInstallUser): string | null {
  const teamId = githubAppInstallTeam(user);
  if (!teamId) return null;
  const state = btoa(JSON.stringify({ team_id: teamId, user_id: user._id }));
  const appSlug = import.meta.env.VITE_GITHUB_APP_SLUG || "codecast-sh";
  return `https://github.com/apps/${appSlug}/installations/new?state=${state}`;
}
