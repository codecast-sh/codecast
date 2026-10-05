import { browserStorage, returnStash, type ReturnStorage, type StashedReturn } from "./returnStash";

export const SLACK_RETURN_KEY = "codecast-slack-return";
export const SLACK_RETURN_PATH = "/slack/connect";
export const SLACK_SIGN_IN_URL = `/login?reason=slack&return_to=${encodeURIComponent(SLACK_RETURN_PATH)}`;

export type SlackReturn = StashedReturn;
const stash = returnStash(SLACK_RETURN_KEY, "Slack");

export function isSlackReturnUrl(pathname: string, search: string): boolean {
  const params = new URLSearchParams(search);
  return pathname.replace(/\/$/, "") === SLACK_RETURN_PATH && (params.has("code") || params.has("error"));
}

export function stashSlackReturn(
  loc: { pathname: string; search: string; hash: string } = window.location,
  store: ReturnStorage | null | undefined = undefined,
  replace: (url: string) => void = (url) => window.history.replaceState(window.history.state, "", url),
): SlackReturn | null {
  if (!isSlackReturnUrl(loc.pathname, loc.search)) return null;
  const p = new URLSearchParams(loc.search);
  const ret = { code: p.get("code"), state: p.get("state"), error: p.get("error") };
  p.delete("code");
  const rest = p.toString();
  replace(`${SLACK_RETURN_PATH}${rest ? `?${rest}` : ""}${loc.hash}`);
  stash.put(ret, store === undefined ? browserStorage() : store);
  return ret;
}

export function readSlackReturn(search = window.location.search, store: ReturnStorage | null = browserStorage()): SlackReturn | null {
  return stash.read(search, store);
}

export function canResumeSlackReturn(ret: SlackReturn, store: ReturnStorage | null = browserStorage()): boolean {
  return stash.canResume(ret, store);
}

export function clearSlackReturn(ret: SlackReturn, store: ReturnStorage | null = browserStorage()): void {
  stash.clear(ret, store);
}

export function slackProviderRedirect(redirectTo: string): string {
  return redirectTo === SLACK_RETURN_PATH ? SLACK_SIGN_IN_URL : redirectTo;
}
