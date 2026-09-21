import { afterEach, describe, expect, test } from "bun:test";
import { canResumeSlackReturn, clearSlackReturn, isSlackReturnUrl, readSlackReturn, slackProviderRedirect, SLACK_RETURN_KEY, SLACK_SIGN_IN_URL, stashSlackReturn } from "../slackReturn";

function memStore() {
  const m = new Map<string, string>();
  return { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
}

const loc = { pathname: "/slack/connect", search: "?code=abc&state=xyz", hash: "" };
afterEach(() => {
  const pending = readSlackReturn("", null);
  if (pending) clearSlackReturn(pending, null);
});

describe("Slack return storage", () => {
  test("removes only the Slack code and retains the connection across reads and a login reload", () => {
    const store = memStore();
    let replaced = "";
    const ret = stashSlackReturn({ ...loc, search: loc.search + "&other=kept", hash: "#fragment" }, store, (u) => { replaced = u; })!;
    expect(replaced).toBe("/slack/connect?state=xyz&other=kept#fragment");
    expect(readSlackReturn("?state=xyz", store)).toEqual(ret);
    expect(readSlackReturn("", store)).toEqual(ret);
    expect(canResumeSlackReturn(ret, store)).toBe(true);
    clearSlackReturn(ret, null);
    expect(readSlackReturn("", store)).toEqual(ret);
    clearSlackReturn(ret, store);
    expect(readSlackReturn("", store)).toBeNull();
  });

  test("does not let a different state take an older pending connection", () => {
    const store = memStore();
    stashSlackReturn(loc, store, () => {});
    expect(readSlackReturn("?state=different", store)).toBeNull();
  });

  test("settling an older request cannot clear a newer return", () => {
    const store = memStore();
    const old = stashSlackReturn(loc, store, () => {})!;
    const next = stashSlackReturn({ ...loc, search: "?code=next&state=new" }, store, () => {})!;
    clearSlackReturn(old, store);
    expect(readSlackReturn("", store)).toEqual(next);
    expect(canResumeSlackReturn(next, store)).toBe(true);
  });

  test("captures cancellation without a code and normalizes the trailing slash", () => {
    const store = memStore();
    let replaced = "";
    const ret = stashSlackReturn({ ...loc, pathname: "/slack/connect/", search: "?error=access_denied&state=xyz" }, store, (u) => { replaced = u; });
    expect(ret).toEqual({ code: null, state: "xyz", error: "access_denied" });
    expect(replaced).toBe("/slack/connect?error=access_denied&state=xyz");
  });

  test("never exposes Slack's code to the login library when storage is blocked", () => {
    let replaced = "";
    const store = { ...memStore(), setItem() {
      expect(replaced).toBe("/slack/connect?state=xyz");
      throw new Error("storage blocked");
    } };
    const ret = stashSlackReturn(loc, store, (u) => { replaced = u; })!;
    expect(replaced).toBe("/slack/connect?state=xyz");
    expect(readSlackReturn("", store)).toEqual(ret);
    expect(canResumeSlackReturn(ret, store)).toBe(false);
  });

  test.each(["broken json", "null", "{}", '{"code":{},"state":"s","error":null}'])("ignores corrupt stored data: %s", (value) => {
    const store = memStore();
    store.setItem(SLACK_RETURN_KEY, value);
    expect(readSlackReturn("", store)).toBeNull();
  });

  test("leaves login authorization codes alone without overwriting the Slack return", () => {
    const store = memStore();
    const ret = stashSlackReturn(loc, store, () => {})!;
    let replaced = false;
    expect(stashSlackReturn({ ...loc, pathname: "/login", search: "?code=github-code" }, store, () => { replaced = true; })).toBeNull();
    expect(replaced).toBe(false);
    expect(readSlackReturn("", store)).toEqual(ret);
    expect(isSlackReturnUrl("/slack/connect", "?slack=connected")).toBe(false);
    expect(slackProviderRedirect("/slack/connect")).toBe(SLACK_SIGN_IN_URL);
    expect(slackProviderRedirect("/inbox")).toBe("/inbox");
  });
});
