import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildLoginFlowCommand, buildMintFlowCommand, summarizeLoginPaneTail } from "./daemon.js";

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
// browser on its own: the only browser openings are a sign-in a person
// clicked (start_login) and a token mint a person started (switch_account
// {mint}), and both run only from their command handlers.

describe("per-profile credential stores", () => {
  test("provisions stores on every heartbeat without a settings gate", () => {
    expect(daemonSource).not.toContain("sessionTokensEnabled");
    expect(daemonSource).toMatch(/async function sendHeartbeat[\s\S]*?void ensureProfileStores\("heartbeat"\);/);
  });

  test("never opens a browser unattended", () => {
    // The one default-browser opener belongs to the mint watcher, which only
    // a command starts; no agent-browser detour approves anything by itself.
    expect(daemonSource).not.toContain("approveMintInBrowser");
    const openers = daemonSource.match(/openInDefaultBrowser\(/g) ?? [];
    expect(openers).toHaveLength(2); // the definition and the mint watcher's call
    // Each flow is started from its command handler and nowhere else.
    expect(daemonSource.match(/startLoginFlow\(/g) ?? []).toHaveLength(2);
    expect(daemonSource).toMatch(/case "start_login"[\s\S]{0,1500}startLoginFlow\(/);
  });
});

// The mint pane has the same PATH problem as the login pane, and $BROWSER is
// pointed at the hook that records the sign-in URL for the daemon to open and
// report (the web offers the page again from it).

describe("buildMintFlowCommand", () => {
  test("runs setup-token with $BROWSER pointed at the URL hook, PATH carried, grace sleep appended", () => {
    const cmd = buildMintFlowCommand("/Users/me/.codecast/mint-browser-hook.sh");
    expect(cmd).toMatch(/^PATH='[^']+' BROWSER='\/Users\/me\/\.codecast\/mint-browser-hook\.sh' claude setup-token; sleep 4$/);
  });

  test("a hook path with a quote cannot break out of the shell word", () => {
    const cmd = buildMintFlowCommand("/tmp/it's/hook.sh");
    expect(cmd).toContain("BROWSER='/tmp/it'\\''s/hook.sh' claude setup-token");
  });
});

// A mint opens a browser sign-in, so it is a guided act a person starts from
// Settings (switch_account {mint}) and never something the daemon does on its
// own: the automatic mint is what opened claude.ai windows at random
// (2026-09-10), and it cannot work for more than the one account the browser
// is signed into.
describe("minting is never automatic", () => {
  test("no heartbeat or timer starts a mint; only the switch_account command does", () => {
    expect(daemonSource).not.toMatch(/autoMint/i);
    const calls = daemonSource.match(/startMintFlow\(/g) ?? [];
    // The definition and the one call in the command handler.
    expect(calls).toHaveLength(2);
    expect(daemonSource).toMatch(/parsed\.mint[\s\S]{0,200}startMintFlow\(parsed\.mint/);
  });
});
