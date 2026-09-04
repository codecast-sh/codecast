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

describe("automatic session tokens", () => {
  test("checks the active account on every heartbeat without a settings gate", () => {
    expect(daemonSource).not.toContain("sessionTokensEnabled");
    expect(daemonSource).toContain("if (isRemoteDevice() || mintFlowActive) return;");
    expect(daemonSource).toMatch(/async function sendHeartbeat[\s\S]*?maybeAutoMintToken\(\);/);
  });
});
