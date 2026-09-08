// The `state` a GitHub App install carries from the button to the install
// callback (convex/http.ts `/api/github-app/callback`). Three places used to
// spell it: the web install URL, the CLI's connect-url action and the callback
// that reads it back. One builder and one parser here, so the workspace an
// installation binds to cannot drift between them.
//
// The state is NOT signed (the callback binds an installation only when the
// named installer really belongs to the named team, or IS the personal owner),
// so it carries identity, never authority.

import { isAppConnectionScope, type AppConnectionScope } from "./appDescriptors";

export interface GithubAppInstallState {
  user_id: string;
  scope: AppConnectionScope;
  /** Present for a team install: the team the installation binds to. */
  team_id?: string;
}

/**
 * The state for an install at `scope`. A team install needs a team; with none
 * there is nothing to bind to, and the answer is null rather than a state the
 * callback would refuse.
 */
export function githubAppInstallState(args: {
  userId: string;
  scope: AppConnectionScope;
  teamId?: string | null;
}): string | null {
  if (args.scope === "team" && !args.teamId) return null;
  const state: GithubAppInstallState =
    args.scope === "team"
      ? { user_id: args.userId, scope: "team", team_id: args.teamId! }
      : { user_id: args.userId, scope: "personal" };
  return btoa(JSON.stringify(state));
}

/**
 * Read a state back. Installs minted before scopes existed carry only
 * `team_id` and `user_id`; those read as team installs. Anything without a
 * user, or a team install without a team, is null — "bind to nothing" is the
 * only safe reading of a state that names no owner.
 */
export function parseGithubAppInstallState(raw: string | null | undefined): GithubAppInstallState | null {
  if (!raw) return null;
  let data: any;
  try {
    data = JSON.parse(atob(raw));
  } catch {
    return null;
  }
  if (!data || typeof data.user_id !== "string") return null;
  const scope: AppConnectionScope = isAppConnectionScope(data.scope) ? data.scope : "team";
  if (scope === "personal") return { user_id: data.user_id, scope };
  if (typeof data.team_id !== "string" || !data.team_id) return null;
  return { user_id: data.user_id, scope, team_id: data.team_id };
}

/** The install URL for the App named by `slug`, carrying `state`. */
export function githubAppInstallUrlFor(slug: string, state: string): string {
  return `https://github.com/apps/${slug}/installations/new?state=${state}`;
}
