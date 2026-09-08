// The statusline script runs several times a second while a turn streams, and
// it both draws the bar and feeds the daemon. So there are three things worth
// proving: the line it draws, that it never posts a payload with no
// rate_limits, and that a throttled tick spawns nothing while still drawing.
// All of it is shell control flow, so the real script is executed by a real
// shell — every one the machine has — with `curl` and `date` replaced by
// recorders on PATH.

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
    session_id: SID,
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

// The fake `date` answers this, so the reset countdowns are a known distance
// from the payload's resets_at: 1h to the five-hour window, 3d and 30m to the
// weekly one.
const NOW = 1788755400;

function run(stdin: string, env: Record<string, string> = {}): { stdout: string; status: number } {
  const r = spawnSync(shell, [hook], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: dir, ...env },
  });
  return { stdout: r.stdout, status: r.status ?? -1 };
}

const SID = "f03e4098-8b2b-44e0-9370-de3b4fc2edd0";
const stampDir = () => path.join(home, ".codecast", "statusline");
const stampFile = (sid = SID) => path.join(stampDir(), sid);

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
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${dir}/date.log"\nprintf '%s\\n' "\${CC_FAKE_EPOCH:-${NOW}}"\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const shellBin of SHELLS) describe(`codecast statusline hook (${shellBin})`, () => {
  beforeEach(() => { shell = shellBin; });

  test("forwards a rate_limits payload and draws it as one line", () => {
    const r = run(payload());
    expect(r.stdout).toBe("session 0%, resets in 1h \u00b7 week 32%, resets in 3d\n");
    expect(r.status).toBe(0);
    const [curl] = calls("curl");
    expect(curl).toContain("http://127.0.0.1:45999/hook/statusline?account=");
    expect(curl).toContain("--data-binary @-");
  });

  // Claude Code reserves the row whatever we print, and the bar sits in the
  // user's own theme — so the line carries no escape sequence and no glyph the
  // font may not have.
  test("the line is plain text: no colour, no emoji, one line", () => {
    const out = run(payload(), { CODECAST_CC_ACCOUNT: "union" }).stdout;
    expect(out).toBe("union \u00b7 session 0%, resets in 1h \u00b7 week 32%, resets in 3d\n");
    expect(out).not.toContain("\u001b");
    expect(out.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("a window whose reset has already passed shows only its percentage", () => {
    const spent = payload({
      rate_limits: {
        five_hour: { used_percentage: 100, resets_at: NOW - 60 },
        seven_day: { used_percentage: 32, resets_at: 1789016400 },
      },
    });
    expect(run(spent).stdout).toBe("session 100% \u00b7 week 32%, resets in 3d\n");
  });

  test("a payload carrying one window draws that one", () => {
    const only = payload({ rate_limits: { five_hour: { used_percentage: 7, resets_at: NOW + 1650 } } });
    expect(run(only).stdout).toBe("session 7%, resets in 28m\n");
  });

  // The windows arrive only once an API response has landed, so the first ticks
  // of every session have none — and an API-billed session never gets any. The
  // bar must not blink between a full line and an empty one, so a tick with no
  // windows redraws the last line it drew.
  test("a payload with no rate_limits spawns nothing and redraws the last line", () => {
    const noLimits = JSON.parse(payload());
    delete noLimits.rate_limits;
    const drawn = run(payload()).stdout;
    fs.rmSync(path.join(dir, "curl.log"));
    fs.rmSync(path.join(dir, "date.log"));

    const r = run(JSON.stringify(noLimits));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(drawn);
    expect(calls("curl")).toEqual([]);
    expect(calls("date")).toEqual([]);
  });

  // Nothing has been drawn yet and nothing ever will be on this session: the
  // account name is the only true thing we have, and it is what a user pinning
  // accounts needs to see. With no account either, the row stays blank.
  test("with no windows and nothing drawn yet it falls back to the account name", () => {
    const noLimits = JSON.parse(payload());
    delete noLimits.rate_limits;
    const body = JSON.stringify(noLimits);
    expect(run(body, { CODECAST_CC_ACCOUNT: "union" }).stdout).toBe("union\n");
    expect(run(body).stdout).toBe("");
    expect(calls("curl")).toEqual([]);
  });

  // The drawn line is reprinted from a file in a /tmp that is shared on Linux,
  // and it goes to a terminal — so anything that could move the cursor or set a
  // colour is treated as not ours.
  test("a cached line carrying control characters is not printed", () => {
    const noLimits = JSON.parse(payload());
    delete noLimits.rate_limits;
    fs.mkdirSync(stampDir(), { recursive: true });
    fs.writeFileSync(stampFile(), `1\n1\n\u001b[31mowned\u001b[0m\n`);
    expect(run(JSON.stringify(noLimits)).stdout).toBe("");
  });

  // The same guard by length: a line longer than the cap cannot have come from
  // a render (the account name is capped so that it cannot), so it is not ours.
  test("a cached line longer than the cap is not printed", () => {
    const noLimits = JSON.parse(payload());
    delete noLimits.rate_limits;
    fs.mkdirSync(stampDir(), { recursive: true });
    fs.writeFileSync(stampFile(), `1\n1\n${"x".repeat(201)}\n`);
    expect(run(JSON.stringify(noLimits)).stdout).toBe("");
    fs.writeFileSync(stampFile(), `1\n1\n${"x".repeat(200)}\n`);
    expect(run(JSON.stringify(noLimits)).stdout).toBe(`${"x".repeat(200)}\n`);
  });

  // Bounded so a rendered line always fits under that cap. An account name we
  // would have to reject when reading it back would make every tick re-render.
  test("an account name longer than 32 characters is dropped", () => {
    const long = "a".repeat(33);
    const r = run(payload(), { CODECAST_CC_ACCOUNT: long });
    expect(r.stdout).not.toContain(long);
    expect(r.stdout.startsWith("session ")).toBe(true);
    expect(calls("curl")[0]).not.toContain(long);

    const fits = "a".repeat(32);
    const ok = run(payload({ session_id: "second" }), { CODECAST_CC_ACCOUNT: fits });
    expect(ok.stdout.startsWith(`${fits} \u00b7 `)).toBe(true);
  });

  // The stamp names the account and its usage. On a shared box that is nobody
  // else's business, and its path must not be a door into a file of theirs.
  test("the stamp is private to the user", () => {
    run(payload());
    expect(fs.statSync(stampFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(stampDir()).mode & 0o777).toBe(0o700);
  });

  test("a symlink at the stamp path is neither read nor written through", () => {
    const victim = path.join(dir, "victim");
    fs.writeFileSync(victim, "precious\n");
    fs.mkdirSync(stampDir(), { recursive: true });
    fs.symlinkSync(victim, stampFile());

    const r = run(payload());
    expect(r.stdout).toBe("session 0%, resets in 1h \u00b7 week 32%, resets in 3d\n");
    expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
    expect(fs.lstatSync(stampFile()).isSymbolicLink()).toBe(true);

    // No cache means no throttle to read either, so the feed keeps posting
    // rather than going quiet.
    run(payload());
    expect(calls("curl")).toHaveLength(2);
  });

  test("empty stdin spawns nothing", () => {
    expect(run("").status).toBe(0);
    expect(calls("curl")).toEqual([]);
    expect(calls("date")).toEqual([]);
  });

  // The clock is the payload's own total_duration_ms, so a throttled tick costs
  // one shell and no process at all — the reason this can run 3x/second. It
  // still draws, by reprinting what the last posting tick rendered.
  test("throttles to one post per interval, and a throttled tick spawns nothing", () => {
    const at = (ms: number) => payload({ cost: { total_duration_ms: ms } });
    const first = run(at(1_000));
    expect(calls("curl")).toHaveLength(1);
    const spawned = calls("curl").length + calls("date").length;

    const throttled = run(at(1_000 + (STATUSLINE_MIN_POST_INTERVAL_S - 1) * 1000));
    expect(throttled.stdout).toBe(first.stdout);
    expect(calls("curl").length + calls("date").length).toBe(spawned);

    run(at(1_000 + STATUSLINE_MIN_POST_INTERVAL_S * 1000));
    expect(calls("curl")).toHaveLength(2);
  });

  // One wall clock read per interval, on the tick that was posting anyway: the
  // payload's clock counts from the start of the session, so it can order ticks
  // but cannot date a reset.
  test("reads the wall clock once per interval, never on a throttled tick", () => {
    const at = (ms: number) => payload({ cost: { total_duration_ms: ms } });
    run(at(1_000));
    run(at(2_000));
    run(at(3_000));
    expect(calls("date")).toHaveLength(1);
    run(at(1_000 + STATUSLINE_MIN_POST_INTERVAL_S * 1000));
    expect(calls("date")).toHaveLength(2);
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
    const r = run(payload(), { CODECAST_CC_ACCOUNT: "union" });
    expect(calls("curl")[0]).toContain("?account=union");
    expect(r.stdout.startsWith("union \u00b7 ")).toBe(true);
  });

  test("drops an account name that could not be a profile", () => {
    const r = run(payload(), { CODECAST_CC_ACCOUNT: "a&b; rm -rf /" });
    expect(calls("curl")[0]).toContain("?account=");
    expect(calls("curl")[0]).not.toContain("rm -rf");
    expect(r.stdout).not.toContain("rm -rf");
  });

  test("a session id that could name another file is dropped", () => {
    const r = run(payload({ session_id: "../../etc/passwd" }));
    expect(calls("curl")).toEqual([]);
    expect(r.stdout).toBe("");
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
