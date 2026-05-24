import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CODECAST_STATUS_HOOK } from "./statusHook.js";

// Run the installed hook exactly as Claude Code would: pipe a hook-event JSON to
// it with HOME pointed at a scratch dir (no hook-port file, so it takes the
// status-file fallback path) and read back the status it recorded.
let home: string;
let hookFile: string;

function runHook(payload: Record<string, unknown>): { status: string; message?: string; permission_mode?: string } {
  execFileSync("bash", [hookFile], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home },
  });
  const file = path.join(home, ".codecast", "agent-status", `${payload.session_id}.json`);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-hook-"));
  hookFile = path.join(home, "codecast-status.sh");
  fs.writeFileSync(hookFile, CODECAST_STATUS_HOOK, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("codecast-status hook event mapping", () => {
  test("AskUserQuestion blocks the agent -> permission_blocked, not working", () => {
    const out = runHook({
      session_id: "ask-1",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      permission_mode: "bypassPermissions",
    });
    expect(out.status).toBe("permission_blocked");
    // Tool name is carried so the daemon classifies it via SKIP_TOOLS without a
    // transcript read (and never tries to inject a permission Enter/Escape).
    expect(out.message).toBe("AskUserQuestion");
  });

  test("ordinary tool use still reports working", () => {
    const out = runHook({
      session_id: "bash-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    expect(out.status).toBe("working");
    expect(out.message).toBeUndefined();
  });

  test("Stop -> idle and UserPromptSubmit -> thinking are unchanged", () => {
    expect(runHook({ session_id: "stop-1", hook_event_name: "Stop" }).status).toBe("idle");
    expect(runHook({ session_id: "ups-1", hook_event_name: "UserPromptSubmit" }).status).toBe("thinking");
  });
});
