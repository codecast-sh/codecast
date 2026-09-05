import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_ENV_SCRUB, buildResumeEnvPrefix } from "./daemon.js";

// Regression coverage for the auto-resume wedge: `claude --resume` on an old/large
// session (>70min AND >100k tokens) pops an interactive "Resume from summary?" menu.
// A daemon auto-resume has no human at the pane to answer it, so the resume hung
// forever — the agent never connected, and the web stuck-banner watchdog escalated
// to a destructive kill+restart loop that took out the live session. There is no CLI
// flag to skip the prompt, only the CLAUDE_CODE_RESUME_THRESHOLD_* env gates, so the
// resume command must carry them.
describe("buildResumeEnvPrefix", () => {
  test("a resumed cloud worktree gets its reserved port back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-env-"));
    const stateDir = path.join(root, ".codecast/workspaces/cloud-test");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ resourceIndex: 2, ports: { web: 3241 } }));
    try {
      const prefix = buildResumeEnvPrefix("codex", path.join(root, ".codecast/worktrees/cloud-test"));
      expect(prefix).toContain("PORT_WEB='3241'");
      expect(prefix).toContain("AGENT_RESOURCE_INDEX='2'");
      expect(prefix.startsWith(AGENT_ENV_SCRUB)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test("claude resume pushes both resume-prompt thresholds out of reach", () => {
    const prefix = buildResumeEnvPrefix("claude");
    expect(prefix).toContain("env -u CLAUDECODE");
    expect(prefix).toContain("CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999");
    expect(prefix).toContain("CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=999999999999");
  });

  test("codex resume keeps only the env scrub (no Claude-only env)", () => {
    const prefix = buildResumeEnvPrefix("codex");
    expect(prefix).toBe(AGENT_ENV_SCRUB);
    expect(prefix).not.toContain("CLAUDE_CODE_RESUME");
  });

  test("gemini resume keeps only the env scrub", () => {
    expect(buildResumeEnvPrefix("gemini")).toBe(AGENT_ENV_SCRUB);
  });

  // 2026-08-27: the tmux server carried CLAUDE_CODE_CHILD_SESSION=1 from the
  // Claude session that started it. Every daemon-launched claude inherited it,
  // treated itself as a subagent, and turned transcript saving off — no JSONL,
  // discovery timed out, six threads stuck at 0 messages. The scrub must drop
  // the child marker and the foreign session id, not just CLAUDECODE.
  test("scrub drops the child-session marker and foreign session id", () => {
    for (const v of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"]) {
      expect(AGENT_ENV_SCRUB).toContain(`-u ${v}`);
    }
    // Pane-content detection keys off this literal prefix (daemon.ts findLaunchLine).
    expect(AGENT_ENV_SCRUB.startsWith("env -u CLAUDECODE")).toBe(true);
  });

  test("prefix prepends cleanly to a resume command", () => {
    const cmd = `${buildResumeEnvPrefix("claude")} claude --resume abc123`;
    expect(cmd.startsWith("env -u CLAUDECODE ")).toBe(true);
    expect(cmd.endsWith(" claude --resume abc123")).toBe(true);
  });
});
