// The `state` a GitHub App install carries from the button to the install
// callback (convex/http.ts `/api/github-app/callback`).
//
// It is an OPAQUE SINGLE-USE NONCE and nothing else. The state used to carry
// the workspace and the user the installation binds to, base64 JSON that
// anyone could write: a forged state named any Codecast principal, and the
// callback bound an installation to it. The nonce names an install intent the
// server minted for an authenticated caller (githubApp.getInstallUrl), so the
// callback reads identity out of its own database instead of out of the
// request.
//
// Holding the nonce is still not proof that the caller controls the
// installation; the callback establishes that separately through GitHub's
// user-token flow.

/** How long an install intent stays usable after the button is clicked. */
export const GITHUB_INSTALL_INTENT_TTL_MS = 15 * 60 * 1000;

/** A fresh install nonce: 48 hex characters of CSPRNG output. */
export function newGithubAppInstallNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The nonce a callback's `state` names, or null when the state is not one —
 * including every legacy identity-carrying state, which now binds nothing.
 */
export function parseGithubAppInstallState(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  return /^[0-9a-f]{48}$/.test(raw) ? raw : null;
}

/** The install URL for the App named by `slug`, carrying `state`. */
export function githubAppInstallUrlFor(slug: string, state: string): string {
  return `https://github.com/apps/${slug}/installations/new?state=${state}`;
}
