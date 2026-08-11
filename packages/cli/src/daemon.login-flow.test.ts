import { describe, expect, test } from "bun:test";
import { summarizeLoginPaneTail } from "./daemon.js";

// The login-flow watcher reports the dying pane's last meaningful line as the
// rejection reason — the CLI's own words are the most honest "why" available.

describe("summarizeLoginPaneTail", () => {
  test("returns the last non-empty line, whitespace collapsed", () => {
    const pane = [
      "Opening browser to sign in…",
      "",
      "  Login cancelled.   ",
      "",
      "",
    ].join("\n");
    expect(summarizeLoginPaneTail(pane)).toBe("Login cancelled.");
  });

  test("empty pane yields null (caller supplies its own fallback)", () => {
    expect(summarizeLoginPaneTail("")).toBeNull();
    expect(summarizeLoginPaneTail("\n  \n\n")).toBeNull();
  });

  test("caps runaway lines so the reason stays banner-sized", () => {
    const long = "x".repeat(500);
    expect(summarizeLoginPaneTail(long)?.length).toBe(160);
  });
});
