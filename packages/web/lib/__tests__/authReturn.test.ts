// The way back after a sign-in that only looked lost (lib/authReturn).
import { beforeEach, describe, expect, test } from "bun:test";
import { noteAuthLeave, RETURN_TTL_MS, takeAuthReturn } from "../authReturn";

const store = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

describe("authReturn", () => {
  beforeEach(() => store.clear());

  test("returns once to the page left, while recent", () => {
    noteAuthLeave("/conversation/abc?x=1#m", 1_000);
    expect(takeAuthReturn(2_000)).toBe("/conversation/abc?x=1#m");
    expect(takeAuthReturn(2_000)).toBeNull();
  });

  test("an old note is a real sign-out, and landing pages are never a return", () => {
    noteAuthLeave("/tasks", 0);
    expect(takeAuthReturn(RETURN_TTL_MS + 1)).toBeNull();
    for (const path of ["/", "/?r=1", "/welcome", "/login"]) {
      noteAuthLeave(path, 0);
      expect(takeAuthReturn(1)).toBeNull();
    }
  });
});
