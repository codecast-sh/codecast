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
});
