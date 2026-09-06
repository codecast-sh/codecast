// The statusline script runs several times a second while a turn streams, so
// the two things worth proving are what it does NOT do: post a payload with no
// rate_limits, and spawn anything on a throttled tick. Both are shell control
// flow, so the real script is executed by a real shell — every one the machine
// has — with `curl` and `date` replaced by recorders on PATH.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CODECAST_STATUSLINE_HOOK, STATUSLINE_MIN_POST_INTERVAL_S } from "./statuslineHook.js";

let dir: string;
let hook: string;
let bin: string;
let home: string;

// The shape verified against Claude Code 2.1.263 on 2026-09-06.
function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "f03e4098-8b2b-44e0-9370-de3b4fc2edd0",
    cwd: "/tmp/p",
    model: { id: "claude-sonnet-5", display_name: "Sonnet 5" },
    version: "2.1.263",
    cost: { total_cost_usd: 0.04, total_duration_ms: 17462, total_api_duration_ms: 1897 },
    rate_limits: {
      five_hour: { used_percentage: 0, resets_at: 1788759000 },
      seven_day: { used_percentage: 32, resets_at: 1789016400 },
    },
    ...over,
  });
}

// /bin/sh is bash in POSIX mode on macOS and dash on most Linux boxes, and the
// two disagree about arithmetic on a malformed constant — dash makes it fatal.
// Both are exercised where both exist.
const SHELLS = ["/bin/sh", "/bin/dash"].filter((s) => fs.existsSync(s));
let shell: string;

function run(stdin: string, env: Record<string, string> = {}): { stdout: string; status: number } {
  const r = spawnSync(shell, [hook], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: dir, ...env },
  });
  return { stdout: r.stdout, status: r.status ?? -1 };
}

function calls(name: string): string[] {
  try {
    return fs.readFileSync(path.join(dir, `${name}.log`), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-statusline-"));
  home = path.join(dir, "home");
  hook = path.join(dir, "codecast-statusline.sh");
  bin = path.join(dir, "bin");
  fs.writeFileSync(hook, CODECAST_STATUSLINE_HOOK, { mode: 0o755 });
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codecast", "hook-port"), "45999\n");
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh\ncat >/dev/null 2>&1\nprintf '%s\\n' "$*" >>"${dir}/curl.log"\nexit 0\n`,
    { mode: 0o755 },
  );
  // Answers a fixed epoch so the fallback clock is exercised, not just counted.
  fs.writeFileSync(
    path.join(bin, "date"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${dir}/date.log"\nprintf '%s\\n' "\${CC_FAKE_EPOCH:-1788759000}"\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const shellBin of SHELLS) describe(`codecast statusline hook (${shellBin})`, () => {
  beforeEach(() => { shell = shellBin; });

  test("forwards a rate_limits payload and prints nothing", () => {
    const r = run(payload());
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
    const [curl] = calls("curl");
    expect(curl).toContain("http://127.0.0.1:45999/hook/statusline?account=");
    expect(curl).toContain("--data-binary @-");
  });

  test("a payload with no rate_limits spawns nothing", () => {
    const noLimits = JSON.parse(payload());
    delete noLimits.rate_limits;
    expect(run(JSON.stringify(noLimits)).status).toBe(0);
    expect(calls("curl")).toEqual([]);
    expect(calls("date")).toEqual([]);
  });

  test("empty stdin spawns nothing", () => {
    expect(run("").status).toBe(0);
    expect(calls("curl")).toEqual([]);
  });

  // The clock is the payload's own total_duration_ms, so a throttled tick costs
  // one shell and no process at all — the reason this can run 3x/second.
  test("throttles to one post per interval without spawning date", () => {
    const at = (ms: number) => payload({ cost: { total_duration_ms: ms } });
    run(at(1_000));
    run(at(1_000 + (STATUSLINE_MIN_POST_INTERVAL_S - 1) * 1000));
    expect(calls("curl")).toHaveLength(1);
    run(at(1_000 + STATUSLINE_MIN_POST_INTERVAL_S * 1000));
    expect(calls("curl")).toHaveLength(2);
    expect(calls("date")).toEqual([]);
  });

  test("the throttle is per session", () => {
    run(payload());
    run(payload({ session_id: "aaaaaaaa-1111-2222-3333-444444444444" }));
    expect(calls("curl")).toHaveLength(2);
  });

  // A tick the daemon could not receive must not push the next allowed post out
  // — otherwise a daemon restart costs a whole interval of silence.
  test("no daemon port means no post and no stamp", () => {
    fs.rmSync(path.join(home, ".codecast", "hook-port"));
    run(payload());
    expect(calls("curl")).toEqual([]);
    fs.writeFileSync(path.join(home, ".codecast", "hook-port"), "45999");
    run(payload());
    expect(calls("curl")).toHaveLength(1);
  });

  test("carries the session's account when one was pinned", () => {
    run(payload(), { CODECAST_CC_ACCOUNT: "union" });
    expect(calls("curl")[0]).toContain("?account=union");
  });

  test("drops an account name that could not be a profile", () => {
    run(payload(), { CODECAST_CC_ACCOUNT: "a&b; rm -rf /" });
    expect(calls("curl")[0]).toContain("?account=");
    expect(calls("curl")[0]).not.toContain("rm -rf");
  });

  test("a session id that could name another file is dropped", () => {
    run(payload({ session_id: "../../etc/passwd" }));
    expect(calls("curl")).toEqual([]);
  });

  // A schema change that moves or renames total_duration_ms must not stop the
  // feed: the wall clock takes over and the throttle still holds.
  test("falls back to the wall clock when the payload carries no duration", () => {
    const noCost = JSON.parse(payload());
    delete noCost.cost;
    const body = JSON.stringify(noCost);
    run(body, { CC_FAKE_EPOCH: "1788759000" });
    run(body, { CC_FAKE_EPOCH: String(1788759000 + STATUSLINE_MIN_POST_INTERVAL_S - 1) });
    expect(calls("date")).toHaveLength(2);
    expect(calls("curl")).toHaveLength(1);
    run(body, { CC_FAKE_EPOCH: String(1788759000 + STATUSLINE_MIN_POST_INTERVAL_S) });
    expect(calls("curl")).toHaveLength(2);
  });
});
