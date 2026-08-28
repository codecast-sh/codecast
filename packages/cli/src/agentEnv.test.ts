import { describe, expect, test } from "bun:test";
import { AGENT_ENV_SCRUB, AGENT_ENV_UNSET_SH, leakedTmuxGlobalMarkers, scrubAgentEnv } from "./agentEnv.js";
import { buildWatchdogShellScript } from "./supervision.js";

// 2026-08-27: the tmux server and the launchd watchdog carried
// CLAUDE_CODE_CHILD_SESSION=1 from the Claude session that started them. Every
// daemon-launched claude inherited it, treated itself as a subagent and turned
// transcript saving off — no JSONL, discovery timed out, six threads stuck at
// 0 messages. Each consumer of the scrub list is pinned here.
describe("agent env scrub", () => {
  test("launch prefix drops every marker and pins persistence on", () => {
    for (const v of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"]) {
      expect(AGENT_ENV_SCRUB).toContain(`-u ${v}`);
    }
    expect(AGENT_ENV_SCRUB).toContain("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1");
    // Pane-content detection keys off this literal head (daemon.ts findLaunchLine).
    expect(AGENT_ENV_SCRUB.startsWith("env -u CLAUDECODE")).toBe(true);
  });

  test("scrubAgentEnv strips the markers and keeps the rest", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "abc", HOME: "/h" };
    scrubAgentEnv(env);
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  test("watchdog script unsets the markers before anything else runs", () => {
    for (const isBinary of [true, false]) {
      const script = buildWatchdogShellScript({ isBinary, watchdogCommand: "cast _watchdog" });
      const lines = script.split("\n").filter((l) => l && !l.startsWith("#"));
      expect(lines[0]).toBe(AGENT_ENV_UNSET_SH);
    }
  });

  test("leakedTmuxGlobalMarkers reads `tmux show-environment -g` output", () => {
    expect(leakedTmuxGlobalMarkers("PATH=/bin\nCLAUDE_CODE_CHILD_SESSION=1\n-DISPLAY\n")).toEqual(["CLAUDE_CODE_CHILD_SESSION"]);
    expect(leakedTmuxGlobalMarkers("PATH=/bin\n")).toEqual([]);
  });
});
