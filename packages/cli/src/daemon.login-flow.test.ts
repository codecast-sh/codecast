import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildLoginFlowCommand, summarizeLoginPaneTail } from "./daemon.js";

const daemonSource = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

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

// A profile sign-in must land in that profile's own credential store, so the
// machine's keychain login is untouched by a repair of one saved account.

describe("buildLoginFlowCommand into a profile store", () => {
  test("exports CLAUDE_SECURESTORAGE_CONFIG_DIR for the login process only", () => {
    const cmd = buildLoginFlowCommand("a@b.com", "/Users/me/.codecast/cc-store/work");
    expect(cmd).toMatch(/^PATH='[^']+' CLAUDE_SECURESTORAGE_CONFIG_DIR='\/Users\/me\/\.codecast\/cc-store\/work' claude auth login --claudeai --email 'a@b.com'; sleep 4$/);
  });

  test("shell-escapes the store dir", () => {
    const cmd = buildLoginFlowCommand(undefined, "/tmp/it's/store");
    expect(cmd).toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR='/tmp/it'\\''s/store' claude auth login");
  });
});

// Per-session credentials are provisioned from the saved snapshots on every
// beat, offline. Nothing in the daemon may hand an OAuth page to the human's
// browser on its own: the only browser opening is a sign-in a person clicked.

describe("per-profile credential stores", () => {
  test("provisions stores on every heartbeat without a settings gate", () => {
    expect(daemonSource).not.toContain("sessionTokensEnabled");
    expect(daemonSource).toMatch(/async function sendHeartbeat[\s\S]*?void ensureProfileStores\("heartbeat"\);/);
  });

  test("never opens a browser unattended", () => {
    expect(daemonSource).not.toContain("setup-token");
    expect(daemonSource).not.toContain("approveMintInBrowser");
    expect(daemonSource).not.toMatch(/spawn\(process\.platform === "darwin" \? "open" : "xdg-open", \[url\]/);
  });
});
