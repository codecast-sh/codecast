// The two ways a person's name is shown, kept side by side so they cannot
// drift. Inside the team a teammate is known by whatever names them best, an
// address included. To anyone outside it (a share link's holder, a guest in
// a huddle) a person is a name they chose to show, never their address and
// never an id.

type NamedUser = { name?: string | null; github_username?: string | null; email?: string | null } | null | undefined;

/** A teammate's name as the team sees it. */
export function displayName(user: NamedUser): string {
  return user?.name || user?.github_username || user?.email || "Someone";
}

/** A person's name as an outsider may see it, or null when they have shown
 *  none (the caller picks its own fallback). Never the email. */
export function publicName(user: NamedUser): string | null {
  return user?.name || user?.github_username || null;
}
