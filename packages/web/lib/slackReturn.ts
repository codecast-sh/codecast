// Slack sends the person back to /slack/connect?code=…&state=…. The auth
// library (@convex-dev/auth) reads ANY `code` in the URL at boot as one of its
// own sign in codes, tries to redeem it, fails, and signs the session out: the
// connect page then never runs and the person lands on the marketing home.
// So the code is lifted out of the URL before the auth provider mounts and
// handed to the connect page through session storage. Same tab, one use.
export const SLACK_RETURN_KEY = "codecast-slack-return";

export type SlackReturn = { code: string | null; state: string | null; error: string | null };

export function isSlackReturnUrl(pathname: string, search: string): boolean {
  return pathname === "/slack/connect" && new URLSearchParams(search).has("code");
}

/** Move Slack's code out of the URL and into session storage. Call before React mounts. */
export function stashSlackReturn(
  loc: { pathname: string; search: string; hash: string } = window.location,
  store: Pick<Storage, "setItem"> | null = "sessionStorage" in globalThis ? sessionStorage : null,
  replace: (url: string) => void = (url) => window.history.replaceState(window.history.state, "", url),
): SlackReturn | null {
  if (!isSlackReturnUrl(loc.pathname, loc.search)) return null;
  const p = new URLSearchParams(loc.search);
  const ret: SlackReturn = { code: p.get("code"), state: p.get("state"), error: p.get("error") };
  try {
    store?.setItem(SLACK_RETURN_KEY, JSON.stringify(ret));
  } catch {
    return null; // private mode: the page will read the URL, and the library may win the race
  }
  p.delete("code");
  const rest = p.toString();
  replace(`${loc.pathname}${rest ? `?${rest}` : ""}${loc.hash}`);
  return ret;
}

/** The stashed return, once. */
export function takeSlackReturn(
  store: Pick<Storage, "getItem" | "removeItem"> | null = "sessionStorage" in globalThis ? sessionStorage : null,
): SlackReturn | null {
  try {
    const raw = store?.getItem(SLACK_RETURN_KEY);
    if (!raw) return null;
    store?.removeItem(SLACK_RETURN_KEY);
    return JSON.parse(raw) as SlackReturn;
  } catch {
    return null;
  }
}
