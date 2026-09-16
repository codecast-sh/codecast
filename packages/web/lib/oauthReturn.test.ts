import { describe, expect, test } from "bun:test";
import {
  OAUTH_STARTED_KEY,
  OAUTH_STARTED_TTL_MS,
  oauthJustFailed,
} from "./oauthReturn";

function memStore(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    data,
  };
}

describe("oauthJustFailed", () => {
  test("a leftover OAuth code in the URL is a failed bounce", () => {
    expect(oauthJustFailed("?code=abc", Date.now(), memStore())).toBe(true);
  });

  test("a recent start flag without a session is a failed bounce", () => {
    const now = 1_000_000;
    const store = memStore({ [OAUTH_STARTED_KEY]: String(now - 5_000) });
    expect(oauthJustFailed("", now, store)).toBe(true);
    expect(store.getItem(OAUTH_STARTED_KEY)).toBeNull();
  });

  test("a stale start flag is ignored", () => {
    const now = 1_000_000;
    const store = memStore({ [OAUTH_STARTED_KEY]: String(now - OAUTH_STARTED_TTL_MS - 1) });
    expect(oauthJustFailed("", now, store)).toBe(false);
  });

  test("no flag and no code is a normal signed-out visit", () => {
    expect(oauthJustFailed("", Date.now(), memStore())).toBe(false);
  });
});


