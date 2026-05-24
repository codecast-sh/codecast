import { describe, expect, test } from "bun:test";
import { buildResumeEnvPrefix } from "./daemon.js";

// Regression coverage for the auto-resume wedge: `claude --resume` on an old/large
// session (>70min AND >100k tokens) pops an interactive "Resume from summary?" menu.
// A daemon auto-resume has no human at the pane to answer it, so the resume hung
// forever — the agent never connected, and the web stuck-banner watchdog escalated
// to a destructive kill+restart loop that took out the live session. There is no CLI
// flag to skip the prompt, only the CLAUDE_CODE_RESUME_THRESHOLD_* env gates, so the
// resume command must carry them.
describe("buildResumeEnvPrefix", () => {
  test("claude resume pushes both resume-prompt thresholds out of reach", () => {
    const prefix = buildResumeEnvPrefix("claude");
    expect(prefix).toContain("env -u CLAUDECODE");
    expect(prefix).toContain("CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999");
    expect(prefix).toContain("CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=999999999999");
  });

  test("codex resume keeps only the CLAUDECODE strip (no Claude-only env)", () => {
    const prefix = buildResumeEnvPrefix("codex");
    expect(prefix).toBe("env -u CLAUDECODE");
    expect(prefix).not.toContain("CLAUDE_CODE_RESUME");
  });

  test("gemini resume keeps only the CLAUDECODE strip", () => {
    expect(buildResumeEnvPrefix("gemini")).toBe("env -u CLAUDECODE");
  });

  test("prefix prepends cleanly to a resume command", () => {
    const cmd = `${buildResumeEnvPrefix("claude")} claude --resume abc123`;
    expect(cmd.startsWith("env -u CLAUDECODE ")).toBe(true);
    expect(cmd.endsWith(" claude --resume abc123")).toBe(true);
  });
});
