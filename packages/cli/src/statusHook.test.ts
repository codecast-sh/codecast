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

type HookRecord = {
  status: string;
  ts: number;
  message?: string;
  permission_mode?: string;
  transcript_path?: string;
  session_boundary?: string;
  turn_completed_at?: string;
};

function statusFile(sessionId: unknown): string {
  return path.join(home, ".codecast", "agent-status", `${sessionId}.json`);
}

function runHookRaw(payload: Record<string, unknown>): void {
  execFileSync("bash", [hookFile], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home },
  });
}

function runHook(payload: Record<string, unknown>): HookRecord {
  runHookRaw(payload);
  return JSON.parse(fs.readFileSync(statusFile(payload.session_id), "utf-8"));
}

// An event the hook maps to no status writes nothing at all, so the caller can
// only ask whether a record appeared.
function reported(payload: Record<string, unknown>): boolean {
  runHookRaw(payload);
  return fs.existsSync(statusFile(payload.session_id));
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

  // ct-49533. A Stop is the one event that names the end of a lead turn. The
  // daemon may then settle the session as "waiting" for its open background
  // work, after which the status stops moving — the stamp is what still tells
  // one turn from the next.
  test("Stop stamps when the lead turn ended", () => {
    const out = runHook({ session_id: "stop-stamp", hook_event_name: "Stop" });
    expect(out.status).toBe("idle");
    // Seconds, on the same clock as ts, so the daemon converts both alike.
    expect(Number(out.turn_completed_at)).toBe(out.ts);
    expect(out.session_boundary).toBeUndefined();
  });

  // ct-49533. Before this, a resume reported nothing: the row kept a status
  // from before the session was restarted, and the settle classifier filled
  // the vacuum with a verdict for a turn that never happened.
  for (const source of ["startup", "resume", "clear"]) {
    test(`SessionStart source=${source} settles the row as a session boundary`, () => {
      const out = runHook({ session_id: `start-${source}`, hook_event_name: "SessionStart", source });
      expect(out.status).toBe("idle");
      expect(out.session_boundary).toBe("1");
      // No turn ended, so there is nothing to stamp.
      expect(out.turn_completed_at).toBeUndefined();
    });
  }

  test("SessionStart source=compact still reports working", () => {
    // An auto-compact runs INSIDE a turn that then resumes.
    const out = runHook({ session_id: "start-compact", hook_event_name: "SessionStart", source: "compact" });
    expect(out.status).toBe("working");
    expect(out.session_boundary).toBeUndefined();
  });

  test("SessionStart with an unknown source reports nothing", () => {
    expect(reported({ session_id: "start-unknown", hook_event_name: "SessionStart", source: "vscode" })).toBe(false);
  });

  // A manual /compact ends at an idle prompt and emits no Stop, so PostCompact
  // is the pane's only clearing signal. An auto compact resumes its turn and
  // emits its own Stop, so it must claim nothing.
  test("PostCompact trigger=manual is a boundary; auto reports nothing", () => {
    const out = runHook({ session_id: "postcompact-manual", hook_event_name: "PostCompact", trigger: "manual" });
    expect(out.status).toBe("idle");
    expect(out.session_boundary).toBe("1");
    expect(reported({ session_id: "postcompact-auto", hook_event_name: "PostCompact", trigger: "auto" })).toBe(false);
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

// The sidecar's file name is built out of the session id the hook payload carries,
// so an id that walks out of ~/.codecast/ask-input drops the questions payload
// wherever it points (ct-49677). These run the real bash + python3 the hook emits.
describe("codecast-status hook rejects a traversing session id", () => {
  let scratch: string;
  let script: string;

  function run(sessionId: string): number {
    const res = Bun.spawnSync({
      cmd: ["bash", script],
      stdin: Buffer.from(JSON.stringify({
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] },
      })),
      env: { ...process.env, HOME: scratch, CODECAST_DIR: path.join(scratch, ".codecast") },
    });
    return res.exitCode ?? -1;
  }

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-hook-traversal-"));
    script = path.join(scratch, "codecast-status.sh");
    fs.writeFileSync(script, CODECAST_STATUS_HOOK, { mode: 0o755 });
    // An EXISTING directory outside ~/.codecast — os.replace onto a missing
    // directory would fail on its own, which would hide the hole.
    fs.mkdirSync(path.join(scratch, "target"), { recursive: true });
    fs.mkdirSync(path.join(scratch, ".codecast", "ask-input"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("../../target/evil writes nothing, in or out of the ask-input dir", () => {
    // Claude Code discards a hook that fails, so the exit status must stay 0.
    expect(run("../../target/evil")).toBe(0);
    expect(fs.readdirSync(path.join(scratch, "target"))).toEqual([]);
    expect(fs.readdirSync(path.join(scratch, ".codecast", "ask-input"))).toEqual([]);
  });

  test("a leading dot, a separator and an over-long id are all refused", () => {
    for (const id of [".hidden", "a/b", "..", "x".repeat(129)]) {
      expect(run(id), id).toBe(0);
    }
    expect(fs.readdirSync(path.join(scratch, ".codecast", "ask-input"))).toEqual([]);
  });

  test("a uuid-shaped id still gets its sidecar", () => {
    const id = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
    expect(run(id)).toBe(0);
    const sc = JSON.parse(fs.readFileSync(path.join(scratch, ".codecast", "ask-input", `${id}.json`), "utf-8"));
    expect(sc.questions[0].question).toBe("Which?");
  });

  // The check has to run before the path is built, not after: a guard placed on
  // the write itself would still leave the mkstemp/os.replace pair reachable.
  test("the id check precedes the sidecar's os.replace in the emitted script", () => {
    const checkAt = CODECAST_STATUS_HOOK.indexOf("safe_sid = bool(re.fullmatch(");
    const replaceAt = CODECAST_STATUS_HOOK.indexOf("os.replace(");
    expect(checkAt).toBeGreaterThan(-1);
    expect(replaceAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(replaceAt);
    // …and the sidecar block is actually gated on it.
    expect(CODECAST_STATUS_HOOK).toContain("if safe_sid and ev in ('PreToolUse', 'PermissionRequest')");
  });

  // Three copies of one rule now decide the same question: this python check, the
  // shell guard on the status-file fallback, and isSafeStatusSessionId in the
  // daemon. A copy that drifts is a hole, so pin them to one character class.
  // Read from source rather than imported, so the hook suite stays free of the
  // daemon's module graph.
  test("python, shell and daemon spell the id rule the same way", () => {
    const CLASS = "[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}";
    expect(CODECAST_STATUS_HOOK).toContain(`re.fullmatch('${CLASS}', sid)`);
    expect(CODECAST_STATUS_HOOK).toContain('""|[!A-Za-z0-9_-]*|*[!A-Za-z0-9._-]*) exit 0 ;;');
    // ct-49531 moves the const from daemon.ts into statusSpool.ts; accept either home.
    const homes = ["daemon.ts", "statusSpool.ts"]
      .map(f => path.join(import.meta.dir, f))
      .filter(p => fs.existsSync(p))
      .map(p => fs.readFileSync(p, "utf-8"));
    expect(homes.some(src => src.includes(`SAFE_STATUS_SESSION_ID = /^${CLASS}$/`))).toBe(true);
  });
});
