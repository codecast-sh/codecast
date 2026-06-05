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

function runHook(payload: Record<string, unknown>): { status: string; message?: string; permission_mode?: string; transcript_path?: string } {
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

  // CC >= 2.1.x fires a first-class PermissionRequest event with the real tool
  // name + input. The daemon turns this into the web Approve/Deny card, so the
  // hook must report permission_blocked and carry "Tool: preview" as the message.
  test("PermissionRequest for Edit -> permission_blocked with tool name + preview", () => {
    const out = runHook({
      session_id: "perm-edit",
      hook_event_name: "PermissionRequest",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/notes.txt", old_string: "a", new_string: "b" },
      permission_mode: "default",
    });
    expect(out.status).toBe("permission_blocked");
    // Daemon splits the tool off the first token; the preview gives the card detail.
    expect(out.message).toBe("Edit: /tmp/notes.txt");
    expect(out.permission_mode).toBe("default");
  });

  test("PermissionRequest for Bash carries the command as preview", () => {
    const out = runHook({
      session_id: "perm-bash",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm -rf build", description: "clean" },
    });
    expect(out.status).toBe("permission_blocked");
    expect(out.message).toBe("Bash: rm -rf build");
  });

  // AskUserQuestion arrives via PermissionRequest too; it must be tagged by name so
  // the daemon routes it to needs-input (and never suppresses it in bypass mode).
  test("PermissionRequest for AskUserQuestion -> tagged by name", () => {
    const out = runHook({
      session_id: "perm-auq",
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which?", options: [] }] },
      permission_mode: "bypassPermissions",
    });
    expect(out.status).toBe("permission_blocked");
    expect(out.message).toBe("AskUserQuestion");
  });

  // The legacy Notification path must still forward the transcript_path (so the
  // daemon can resolve the tool) — the old block silently produced an empty EXTRA
  // because of unescaped double quotes inside the bash -c "..." python.
  test("Notification permission_prompt forwards transcript_path, not the generic message", () => {
    const out = runHook({
      session_id: "perm-notif",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs your permission",
      transcript_path: "/tmp/session.jsonl",
    });
    expect(out.status).toBe("permission_blocked");
    expect(out.transcript_path).toBe("/tmp/session.jsonl");
    // The generic, tool-less message must not be forwarded — it would poison the
    // daemon's first-token tool extraction (yielding a bogus "Claude" tool).
    expect(out.message).toBeUndefined();
  });
});

// A pending AskUserQuestion buffers its tool_input out of the JSONL, so the hook drops
// the real questions in a per-session sidecar the daemon reads to build a full-fidelity
// card. These run the actual bash+python and assert the file lands (or doesn't).
describe("codecast-status hook AskUserQuestion sidecar", () => {
  function readSidecar(sessionId: string): any {
    const p = path.join(home, ".codecast", "ask-input", `${sessionId}.json`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }
  function sidecarExists(sessionId: string): boolean {
    return fs.existsSync(path.join(home, ".codecast", "ask-input", `${sessionId}.json`));
  }

  test("PreToolUse AskUserQuestion writes the full tool_input questions", () => {
    const questions = [{
      question: "Where should the button live?",
      header: "Scope",
      options: [
        { label: "Global", description: "every route" },
        { label: "Sessions page", description: "all filters" },
      ],
      multiSelect: false,
    }];
    runHook({
      session_id: "sidecar-auq",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions },
      permission_mode: "bypassPermissions",
    });
    const sc = readSidecar("sidecar-auq");
    expect(sc.questions).toEqual(questions);          // descriptions + header + multiSelect intact
    expect(typeof sc.ts).toBe("number");
  });

  test("PermissionRequest AskUserQuestion also writes the sidecar", () => {
    runHook({
      session_id: "sidecar-perm",
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] },
    });
    expect(readSidecar("sidecar-perm").questions[0].question).toBe("Which?");
  });

  test("ordinary tools never write a sidecar", () => {
    runHook({ session_id: "sidecar-bash", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(sidecarExists("sidecar-bash")).toBe(false);
  });
});
