// Chrome iOS GitHub OAuth can bounce the user back unsigned-in. We stamp a
// short-lived flag at the click so AuthGuard can send them to /login with an
// honest reason instead of the marketing homepage.

export const OAUTH_STARTED_KEY = "codecast-oauth-started";
export const OAUTH_STARTED_TTL_MS = 2 * 60 * 1000;

export function markOAuthStarted(now = Date.now()): void {
  try {
    sessionStorage.setItem(OAUTH_STARTED_KEY, String(now));
  } catch {
    // Private mode can throw; the server-side iOS OAuth patch is the real fix.
  }
}

export function oauthJustFailed(
  search = typeof window === "undefined" ? "" : window.location.search,
  now = Date.now(),
  store: Pick<Storage, "getItem" | "removeItem"> | null = "sessionStorage" in globalThis
    ? sessionStorage
    : null,
): boolean {
  if (new URLSearchParams(search).has("code")) return true;
  if (!store) return false;
  try {
    const started = Number(store.getItem(OAUTH_STARTED_KEY));
    if (!started) return false;
    store.removeItem(OAUTH_STARTED_KEY);
    return now - started < OAUTH_STARTED_TTL_MS;
  } catch {
    return false;
  }
}
