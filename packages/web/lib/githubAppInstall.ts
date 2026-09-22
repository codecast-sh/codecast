// Which workspace a GitHub App install belongs to, as the web reads it. The
// install URL itself is minted server-side (githubApp.getInstallUrl), because
// its `state` is an intent bound to the authenticated caller; what stays here
// is the team resolution the card renders beside the button.

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
