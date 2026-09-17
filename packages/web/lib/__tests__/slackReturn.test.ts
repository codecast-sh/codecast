import { describe, expect, test } from "bun:test";
import { isSlackReturnUrl, stashSlackReturn, takeSlackReturn } from "../slackReturn";

function memStore() {
  const m = new Map<string, string>();
  return { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
}

describe("slackReturn", () => {
  test("lifts Slack's code out of the URL and hands it to the connect page once", () => {
    const store = memStore();
    let replaced = "";
    const ret = stashSlackReturn({ pathname: "/slack/connect", search: "?code=abc&state=xyz", hash: "" }, store, (u) => { replaced = u; });
    expect(ret).toEqual({ code: "abc", state: "xyz", error: null });
    expect(replaced).toBe("/slack/connect?state=xyz");
    expect(takeSlackReturn(store)).toEqual({ code: "abc", state: "xyz", error: null });
    expect(takeSlackReturn(store)).toBeNull();
  });
  test("leaves every other URL alone, including other OAuth returns with a code", () => {
    const store = memStore();
    let replaced: string | null = null;
    expect(stashSlackReturn({ pathname: "/login", search: "?code=gh", hash: "" }, store, (u) => { replaced = u; })).toBeNull();
    expect(stashSlackReturn({ pathname: "/slack/connect", search: "?slack=connected", hash: "" }, store, (u) => { replaced = u; })).toBeNull();
    expect(replaced).toBeNull();
    expect(isSlackReturnUrl("/slack/connect", "?code=1")).toBe(true);
  });
});
