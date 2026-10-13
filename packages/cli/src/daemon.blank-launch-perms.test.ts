import { describe, expect, test } from "bun:test";
import { buildBlankLaunchArgs } from "./daemon.js";
import type { Config } from "./config/types.js";

// Regression: blank/fresh session spawns (startFreshSessionForDelivery and the
// resume_session→blank fallback) used to build their command from config args
// alone, launching a bare `claude` that inherited the project's non-bypass
// default (dontAsk) and silently denied every tool. They must inject the same
// permission flags as start_session / auto-resume. ct-37483.
describe("buildBlankLaunchArgs", () => {
  test("claude defaults to bypass when nothing is configured", () => {
    const args = buildBlankLaunchArgs("claude", null);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
  });

  test("claude defaults to bypass with an empty config object", () => {
    const args = buildBlankLaunchArgs("claude", {} as Config);
    expect(args.join(" ")).toContain("--permission-mode bypassPermissions");
  });

  test("explicit bypass mode still yields bypass", () => {
    const cfg = { agent_permission_modes: { claude: "bypass" } } as unknown as Config;
    expect(buildBlankLaunchArgs("claude", cfg).join(" ")).toContain("--permission-mode bypassPermissions");
  });

  test("explicit default mode produces the allow-flag (not bare claude)", () => {
    const cfg = { agent_permission_modes: { claude: "default" } } as unknown as Config;
    expect(buildBlankLaunchArgs("claude", cfg)).toContain("--allow-dangerously-skip-permissions");
  });

  test("user-pinned permission flag in claude_args is not double-stacked", () => {
    const cfg = { claude_args: "--permission-mode plan" } as unknown as Config;
    const args = buildBlankLaunchArgs("claude", cfg);
    // The user's choice wins; we don't append a second --permission-mode.
    expect(args.filter((a) => a === "--permission-mode")).toHaveLength(1);
    expect(args).toContain("plan");
    expect(args).not.toContain("bypassPermissions");
  });

  test("user claude_args without a permission flag still gets bypass appended", () => {
    const cfg = { claude_args: "--verbose" } as unknown as Config;
    const args = buildBlankLaunchArgs("claude", cfg);
    expect(args).toContain("--verbose");
    expect(args.join(" ")).toContain("--permission-mode bypassPermissions");
  });

  // Regression: a restart with nothing to resume launched a blank claude with
  // no --session-id. Claude writes no transcript before its first turn, so
  // discovery timed out and the pane never linked (jx7970z, 2026-10-06).
  test("claude carries the assigned session id", () => {
    const args = buildBlankLaunchArgs("claude", null, "0b6c1d52-0000-4000-8000-000000000001");
    expect(args.join(" ")).toContain("--session-id 0b6c1d52-0000-4000-8000-000000000001");
    expect(args.join(" ")).toContain("--permission-mode bypassPermissions");
  });

  test("a session id pinned in claude_args is not overridden", () => {
    const cfg = { claude_args: "--session-id pinned" } as unknown as Config;
    const args = buildBlankLaunchArgs("claude", cfg, "0b6c1d52-0000-4000-8000-000000000001");
    expect(args.filter((a) => a === "--session-id")).toHaveLength(1);
  });

  test("codex defaults to its bypass flag", () => {
    expect(buildBlankLaunchArgs("codex", null)).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("cursor/gemini carry no flags yet", () => {
    expect(buildBlankLaunchArgs("cursor", null)).toEqual([]);
    expect(buildBlankLaunchArgs("gemini", null)).toEqual([]);
  });

  test("opencode defaults to --auto (managed, no TUI permission prompts)", () => {
    expect(buildBlankLaunchArgs("opencode", null)).toEqual(["--auto"]);
    // user-pinned --auto is not doubled
    expect(buildBlankLaunchArgs("opencode", { agent_args: { opencode: "--auto --pure" } } as unknown as Config)).toEqual(["--auto", "--pure"]);
  });

  test("grok defaults to bypass (claude's flag spelling; managed grok can't answer TUI prompts)", () => {
    expect(buildBlankLaunchArgs("grok", null)).toEqual(["--permission-mode", "bypassPermissions"]);
  });

  test("grok: a user-pinned permission mode in agent_args.grok is not double-stacked", () => {
    const cfg = { agent_args: { grok: "--permission-mode acceptEdits" } } as unknown as Config;
    expect(buildBlankLaunchArgs("grok", cfg)).toEqual(["--permission-mode", "acceptEdits"]);
    const approveCfg = { agent_args: { grok: "--always-approve" } } as unknown as Config;
    expect(buildBlankLaunchArgs("grok", approveCfg)).toEqual(["--always-approve"]);
  });

  test("grok: configured args without a permission flag still get bypass appended", () => {
    const cfg = { agent_args: { grok: "--verbose" } } as unknown as Config;
    expect(buildBlankLaunchArgs("grok", cfg)).toEqual(["--verbose", "--permission-mode", "bypassPermissions"]);
  });

  test("muse defaults to --yolo (managed muse can't answer TUI prompts)", () => {
    expect(buildBlankLaunchArgs("muse", null)).toEqual(["--yolo"]);
  });

  test("muse: an explicit default mode opts out of yolo", () => {
    const cfg = { agent_permission_modes: { muse: "default" } } as unknown as Config;
    expect(buildBlankLaunchArgs("muse", cfg)).toEqual([]);
  });

  test("muse: a user-pinned approval mode in agent_args.muse is not double-stacked", () => {
    const cfg = { agent_args: { muse: "--approval-mode never" } } as unknown as Config;
    expect(buildBlankLaunchArgs("muse", cfg)).toEqual(["--approval-mode", "never"]);
    const yoloCfg = { agent_args: { muse: "--yolo" } } as unknown as Config;
    expect(buildBlankLaunchArgs("muse", yoloCfg)).toEqual(["--yolo"]);
  });

  test("muse: configured args without an approval flag still get --yolo appended", () => {
    const cfg = { agent_args: { muse: "--verbose" } } as unknown as Config;
    expect(buildBlankLaunchArgs("muse", cfg)).toEqual(["--verbose", "--yolo"]);
  });
});
