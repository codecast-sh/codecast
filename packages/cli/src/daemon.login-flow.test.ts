import { describe, expect, test } from "bun:test";
import { buildLoginFlowCommand, summarizeLoginPaneTail } from "./daemon.js";

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

// The login pane inherits the daemon's launchd PATH, which lacks ~/.local/bin
// (where the claude binary lives). The command must carry a full PATH itself,
// or the pane dies instantly with "command not found" — reported to the user
// as "the sign-in window closed before completing" (2026-08-26).

describe("buildLoginFlowCommand", () => {
  test("carries an explicit PATH that includes ~/.local/bin", () => {
    const cmd = buildLoginFlowCommand("a@b.com");
    expect(cmd.startsWith("PATH=")).toBe(true);
    expect(cmd).toContain(".local/bin");
    expect(cmd).toContain("claude auth login --claudeai");
    expect(cmd).toContain("--email 'a@b.com'");
  });

  test("keeps the pane alive briefly so the watcher can capture a dying CLI's tail", () => {
    expect(buildLoginFlowCommand(undefined)).toMatch(/; sleep \d+$/);
  });

  test("shell-escapes a hostile email", () => {
    const cmd = buildLoginFlowCommand("a'; rm -rf /; '@b.com");
    expect(cmd).not.toContain("--email a'; rm");
    expect(cmd).toContain("--email 'a'\\''; rm -rf /; '\\''@b.com'");
  });
});
