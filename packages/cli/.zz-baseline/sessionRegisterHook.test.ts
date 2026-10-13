import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SESSION_REGISTER_HOOK } from "./sessionRegisterHook.js";

let home: string;
let hookFile: string;
let bin: string;

function run(payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): void {
  execFileSync("bash", [hookFile], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
  });
}

function claim(sessionId: string): { pid: number; tty: string; launch_token: string } {
  return JSON.parse(fs.readFileSync(path.join(home, ".codecast", "session-registry", `${sessionId}.json`), "utf-8"));
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-session-register-"));
  hookFile = path.join(home, "session-register.sh");
  fs.writeFileSync(hookFile, SESSION_REGISTER_HOOK, { mode: 0o755 });
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

describe("session-register hook", () => {
  test("writes a claim from session_id without python3", () => {
    run({ session_id: "reg-1", hook_event_name: "UserPromptSubmit" });
    const c = claim("reg-1");
    expect(c.tty).toBe("ttys001");
    expect(typeof c.pid).toBe("number");
    expect(c.pid).toBeGreaterThan(0);
  });

  test("accepts grok camelCase sessionId", () => {
    run({ sessionId: "reg-camel", hook_event_name: "SessionStart" });
    expect(claim("reg-camel").tty).toBe("ttys001");
  });

  test("GROK_SESSION_ID fills in when the payload has no id", () => {
    run({ hook_event_name: "SessionStart" }, { GROK_SESSION_ID: "reg-env" });
    expect(claim("reg-env").tty).toBe("ttys001");
  });

  test("forwards the launch token", () => {
    run({ session_id: "reg-tok", hook_event_name: "SessionStart" }, { CODECAST_LAUNCH_TOKEN: "tok-abc" });
    expect(claim("reg-tok").launch_token).toBe("tok-abc");
  });

  test("a live claim is left alone on UserPromptSubmit", () => {
    const id = "reg-live";
    const dir = path.join(home, ".codecast", "session-registry");
    fs.mkdirSync(dir, { recursive: true });
    const existing = { pid: process.pid, tty: "ttys999", ts: 1, term: "test", launch_token: "old" };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(existing));
    run({ session_id: id, hook_event_name: "UserPromptSubmit" });
    expect(claim(id)).toEqual(existing);
  });

  test("a dead-pid claim is rewritten", () => {
    const id = "reg-dead";
    const dir = path.join(home, ".codecast", "session-registry");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ pid: 99999999, tty: "ttys000", ts: 1, term: "test", launch_token: "" }));
    run({ session_id: id, hook_event_name: "UserPromptSubmit" });
    expect(claim(id).tty).toBe("ttys001");
    expect(claim(id).pid).not.toBe(99999999);
  });
});
