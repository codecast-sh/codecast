import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { THREAD_STATE_NUDGE_MSGS } from "@codecast/shared/contracts";
import { USER_PROMPT_HOOK, USER_PROMPT_HOOK_FILE } from "./userPromptHook.js";

let home: string;
let hookFile: string;
let bin: string;

function transcript(sessionId: string, messages: number): string {
  const file = path.join(home, `${sessionId}.jsonl`);
  const lines: string[] = ['{"type":"file-history-snapshot","x":1}'];
  for (let i = 0; i < messages; i++) {
    lines.push(i % 2 ? '{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}' : '{"type":"user","message":{"content":"hi"}}');
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function run(sessionId: string, extra: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}): string {
  return execFileSync("bash", [hookFile], {
    input: JSON.stringify({
      session_id: sessionId,
      hook_event_name: "UserPromptSubmit",
      transcript_path: extra.transcript_path ?? transcript(sessionId, Number(extra.messages ?? 0)),
      ...extra,
    }),
    env: { ...process.env, HOME: home, CODECAST_DIR: path.join(home, ".codecast"), PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
  }).toString();
}

function status(sessionId: string): { status: string } {
  return JSON.parse(fs.readFileSync(path.join(home, ".codecast", "agent-status", `${sessionId}.json`), "utf-8"));
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-prompt-hook-"));
  // The reminder jobs run only while their Agent Features entry is on.
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ state_enabled: true, work_enabled: true }, null, 2));
  hookFile = path.join(home, USER_PROMPT_HOOK_FILE);
  fs.writeFileSync(hookFile, USER_PROMPT_HOOK, { mode: 0o755 });
  bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\necho PYTHON_CALLED >&2\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh
if [ "$1" = "-o" ] && [ "$2" = "comm=" ]; then echo claude; exit 0; fi
if [ "$1" = "-o" ] && [ "$2" = "ppid=" ]; then echo 1; exit 0; fi
if [ "$1" = "-o" ] && [ "$2" = "tty=" ]; then echo ttys001; exit 0; fi
exit 0
`, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("codecast-prompt.sh folds the four UserPromptSubmit jobs", () => {
  test("reports thinking without python3", () => {
    expect(run("ups-1").trim()).toBe("");
    expect(status("ups-1").status).toBe("thinking");
  });

  test("writes a session-registry claim", () => {
    run("ups-reg");
    const claim = JSON.parse(fs.readFileSync(path.join(home, ".codecast", "session-registry", "ups-reg.json"), "utf-8"));
    expect(claim.tty).toBe("ttys001");
    expect(claim.pid).toBeGreaterThan(0);
  });

  test("a successful status curl still runs the other jobs", () => {
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codecast", "hook-port"), "9");
    const id = "ups-curl";
    fs.mkdirSync(path.join(home, ".codecast", "task-pulse"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codecast", "task-pulse", `${id}.json`), JSON.stringify({ task: "ct-1" }));
    run(id);
    expect(fs.readFileSync(path.join(home, ".codecast", "task-pulse", "counters", id), "utf-8").trim()).toBe("1");
    fs.unlinkSync(path.join(bin, "curl"));
    fs.unlinkSync(path.join(home, ".codecast", "hook-port"));
  });

  test("emits the task pulse on the 8th turn", () => {
    const id = "ups-pulse";
    fs.mkdirSync(path.join(home, ".codecast", "task-pulse"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codecast", "task-pulse", `${id}.json`), JSON.stringify({ task: "ct-9", plan: "pl-2" }));
    for (let i = 0; i < 7; i++) expect(run(id)).not.toContain("<task-reminder>");
    expect(run(id)).toContain("<task-reminder>You are working on task ct-9, plan pl-2.");
  });

  test("injects a stale thread-state reminder, not a block", () => {
    const id = "ups-state";
    fs.mkdirSync(path.join(home, ".codecast", "thread-state"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codecast", "thread-state", `${id}.json`), JSON.stringify({ at: Date.now() }));
    run(id, { messages: 0 });
    const out = run(id, { messages: THREAD_STATE_NUDGE_MSGS + 3 });
    expect(out.startsWith("<thread-state>")).toBe(true);
    expect(out).not.toContain('"decision":"block"');
  });
});
