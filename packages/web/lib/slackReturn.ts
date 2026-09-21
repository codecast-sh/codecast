import { captureException } from "@sentry/react";

export const SLACK_RETURN_KEY = "codecast-slack-return";
export const SLACK_RETURN_PATH = "/slack/connect";
export const SLACK_SIGN_IN_URL = `/login?reason=slack&return_to=${encodeURIComponent(SLACK_RETURN_PATH)}`;

export type SlackReturn = { code: string | null; state: string | null; error: string | null };
type ReturnStorage = Pick<Storage, "setItem" | "getItem" | "removeItem">;
let memoryReturn: SlackReturn | null = null;

function browserStorage(): ReturnStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch (error) {
    captureException(error);
    return null;
  }
}

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
  memoryReturn = ret;
  p.delete("code");
  const rest = p.toString();
  replace(`${SLACK_RETURN_PATH}${rest ? `?${rest}` : ""}${loc.hash}`);
  const storage = store === undefined ? browserStorage() : store;
  try {
    storage?.setItem(SLACK_RETURN_KEY, JSON.stringify(ret));
  } catch (error) {
    captureException(error);
  }
  return ret;
}

function storedReturn(store: ReturnStorage | null): SlackReturn | null {
  try {
    const raw = store?.getItem(SLACK_RETURN_KEY);
    if (!raw) return null;
    const ret = JSON.parse(raw);
    if (!ret || ![ret.code, ret.state, ret.error].every((v) => v === null || typeof v === "string")) return null;
    return ret;
  } catch {
    captureException(new Error("Could not read the pending Slack connection"));
    return null;
  }
}

function sameReturn(a: SlackReturn | null, b: SlackReturn): boolean {
  return !!a && a.code === b.code && a.state === b.state && a.error === b.error;
}

export function readSlackReturn(search = window.location.search, store: ReturnStorage | null = browserStorage()): SlackReturn | null {
  const ret = memoryReturn ?? storedReturn(store);
  const state = new URLSearchParams(search).get("state");
  return ret && (state === null || state === ret.state) ? ret : null;
}

export function canResumeSlackReturn(ret: SlackReturn, store: ReturnStorage | null = browserStorage()): boolean {
  return sameReturn(storedReturn(store), ret);
}

export function clearSlackReturn(ret: SlackReturn, store: ReturnStorage | null = browserStorage()): void {
  if (sameReturn(memoryReturn, ret)) memoryReturn = null;
  try {
    if (sameReturn(storedReturn(store), ret)) store?.removeItem(SLACK_RETURN_KEY);
  } catch (error) {
    captureException(error);
  }
}

export function slackProviderRedirect(redirectTo: string): string {
  return redirectTo === SLACK_RETURN_PATH ? SLACK_SIGN_IN_URL : redirectTo;
}
