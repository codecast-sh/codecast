import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AGENT_ENV_SCRUB,
  AGENT_ENV_UNSET_SH,
  ensureClaudeSettingsPersistence,
  leakedTmuxGlobalMarkers,
  planClaudeSettingsPersistence,
  scrubAgentEnv,
} from "./agentEnv.js";
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

// The settings-level pin: ~/.claude/settings.json `env` applies to every
// claude on the machine (verified live 2026-08-28: an inherited
// CLAUDE_CODE_CHILD_SESSION no longer disables transcript saving). The daemon
// asserts it on boot, `cast doctor` re-asserts and reports it.
describe("claude settings persistence pin", () => {
  const PIN = '"CLAUDE_CODE_FORCE_SESSION_PERSISTENCE": "1"';

  test("no file: plans a fresh settings.json with just the pin", () => {
    const text = planClaudeSettingsPersistence(null)!;
    expect(JSON.parse(text)).toEqual({ env: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" } });
  });

  test("adds the pin to an existing env block, keeping the file's indent", () => {
    const text = planClaudeSettingsPersistence('{\n    "env": {\n        "A": "b"\n    },\n    "model": "opus"\n}\n')!;
    expect(JSON.parse(text)).toEqual({ env: { A: "b", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" }, model: "opus" });
    expect(text).toContain('\n    "env"'); // 4-space indent preserved
    expect(text.endsWith("\n")).toBe(true);
  });

  test("creates the env block when the file has none", () => {
    const text = planClaudeSettingsPersistence('{\n  "model": "opus"\n}')!;
    expect(JSON.parse(text)).toEqual({ model: "opus", env: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" } });
    expect(text).toContain('\n  "env"'); // 2-space indent preserved
  });

  test("no-op when pinned, when authored to another value, and on junk", () => {
    expect(planClaudeSettingsPersistence(`{"env": {${PIN}}}`)).toBeNull();
    // An existing value — even an opt-out — is the user's, not ours to rewrite.
    expect(planClaudeSettingsPersistence('{"env": {"CLAUDE_CODE_FORCE_SESSION_PERSISTENCE": "0"}}')).toBeNull();
    expect(planClaudeSettingsPersistence("not json")).toBeNull();
    expect(planClaudeSettingsPersistence("[1,2]")).toBeNull();
  });

  test("ensureClaudeSettingsPersistence creates, then converges", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pin-"));
    try {
      expect(ensureClaudeSettingsPersistence(home)).toBe("wrote");
      const file = path.join(home, ".claude", "settings.json");
      expect(JSON.parse(fs.readFileSync(file, "utf-8")).env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe("1");
      expect(ensureClaudeSettingsPersistence(home)).toBe("already-pinned");
      fs.writeFileSync(file, '{"env": {"CLAUDE_CODE_FORCE_SESSION_PERSISTENCE": ""}}');
      expect(ensureClaudeSettingsPersistence(home)).toBe("left-alone");
      fs.writeFileSync(file, "{broken");
      expect(ensureClaudeSettingsPersistence(home)).toBe("unparseable");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
