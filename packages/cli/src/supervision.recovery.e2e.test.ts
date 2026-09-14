import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildDaemonLauncherScript,
  buildDaemonPlistXml,
  buildWatchdogPlistXml,
  buildWatchdogShellScript,
  daemonLauncherMatchesCommand,
  daemonTickStale,
  DAEMON_HEARTBEAT_BUSY_GRACE_MS,
  shellEscapeForSh,
} from "./supervision.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-supervision-recovery-"));
  roots.push(home);
  fs.mkdirSync(path.join(home, ".codecast"));
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(path.join(home, "bin", "launchctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
if [ "$1" = print ]; then
  fixture_pid=$(cat "$HOME/fixture-pid" 2>/dev/null || echo 123)
  printf 'state = running\\npid = %s\\n' "$fixture_pid"
fi
if [ "$1" = kickstart ] && [ -f "$HOME/fail-kickstart" ]; then
  rm "$HOME/fail-kickstart"
  exit 1
fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, "bin", "date"), `#!/bin/sh
if [ "$1" = +%s ]; then cat "$HOME/now"; else /bin/date "$@"; fi
`, { mode: 0o755 });
  return home;
}

function run(file: string, args: string[], home: string, opts: { productionLogs?: boolean } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}` };
    // bun test sets NODE_ENV=test, which routes daemon.ts's LOG_FILE to a temp
    // path. A case about WHERE the watchdog writes must run with the production
    // routing, or it cannot see the daemon.log it is protecting.
    if (opts.productionLogs) delete env.NODE_ENV;
    const child = spawn(file, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function watchdogPass(home: string, now: number, tickAge: number, gap: number) {
  const dir = path.join(home, ".codecast");
  fs.writeFileSync(path.join(home, "now"), String(Math.floor(now / 1000)));
  fs.writeFileSync(path.join(dir, "daemon.state"), JSON.stringify({ lastHeartbeatTick: now - tickAge }));
  fs.writeFileSync(path.join(dir, "watchdog.heartbeat"), String(now - gap));
  fs.appendFileSync(path.join(dir, "daemon.log"), "still receiving filesystem events\n");
  fs.utimesSync(path.join(dir, "daemon.log"), now / 1000, now / 1000);
  const script = buildWatchdogShellScript({ isBinary: false, watchdogCommand: "" });
  const loop = script.lastIndexOf("\nwhile :; do");
  expect(loop).toBeGreaterThan(0);
  const scriptPath = path.join(home, "watchdog-pass.sh");
  fs.writeFileSync(scriptPath, `${script.slice(0, loop)}\ncheck_once\n`);
  expect(await run("/bin/sh", [scriptPath], home)).toMatchObject({ code: 0 });
  return fs.readFileSync(path.join(home, "calls"), "utf-8").split("\n").filter((line) => line.startsWith("kickstart"));
}

describe("watchdog recovery with continuing log activity", () => {
  test("fresh log writes cannot excuse a dead heartbeat forever", () => {
    expect(daemonTickStale(DAEMON_HEARTBEAT_BUSY_GRACE_MS, 60_000, 0)).toBe(false);
    expect(daemonTickStale(DAEMON_HEARTBEAT_BUSY_GRACE_MS + 1, 60_000, 0)).toBe(true);
    expect(daemonTickStale(DAEMON_HEARTBEAT_BUSY_GRACE_MS + 1, 8 * 3_600_000, 0)).toBe(false);
  });

  // A wedged verdict kills only on the SECOND consecutive pass that sees the
  // same unmoved tick (supervision.ts watchdogKillVerdict): the first arms.
  test.skipIf(process.platform !== "darwin")("resident shell arms on the first wedged pass, recovers on the second, then leaves a restored heartbeat alone", async () => {
    const home = fixture();
    const now = Math.floor(Date.now() / 1000) * 1000;
    expect(await watchdogPass(home, now, 240_000, 60_000)).toHaveLength(0);
    expect(await watchdogPass(home, now + 420_000, 660_000, 60_000)).toHaveLength(0);
    expect(await watchdogPass(home, now + 480_000, 720_000, 60_000)).toHaveLength(1);
    expect(await watchdogPass(home, now + 540_000, 30_000, 60_000)).toHaveLength(1);
  });

  test.skipIf(process.platform !== "darwin")("sleep gets a grace pass; a dead timer still recovers after wake", async () => {
    const home = fixture();
    const now = Math.floor(Date.now() / 1000) * 1000;
    const sleep = 8 * 3_600_000;
    expect(await watchdogPass(home, now, sleep, sleep)).toHaveLength(0);
    expect(await watchdogPass(home, now + 60_000, sleep + 60_000, 60_000)).toHaveLength(0);
    expect(await watchdogPass(home, now + 120_000, sleep + 120_000, 60_000)).toHaveLength(1);
  });

  test.skipIf(process.platform !== "darwin")("healthy wake and ordinary idle never restart", async () => {
    const home = fixture();
    const now = Math.floor(Date.now() / 1000) * 1000;
    expect(await watchdogPass(home, now, 8 * 3_600_000, 8 * 3_600_000)).toHaveLength(0);
    expect(await watchdogPass(home, now + 60_000, 0, 60_000)).toHaveLength(0);
    expect(await watchdogPass(home, now + 120_000, 30_000, 60_000)).toHaveLength(0);
  });
});

test("status distinguishes consumed Codex metadata from unread transcript bytes", async () => {
  const home = fixture();
  const dir = path.join(home, ".codex", "sessions", "2026", "09", "04");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-01a06e11-085e-7883-a28f-b6127cf23ffe.jsonl");
  const timestamp = new Date(Date.now() - 3_600_000).toISOString();
  const data = JSON.stringify({ type: "session_meta", timestamp, payload: { source: "cli", originator: "codex_cli_rs" } }) + "\n"
    + JSON.stringify({ type: "compacted", timestamp, payload: { summary: "history ".repeat(500) } }) + "\n";
  fs.writeFileSync(file, data);
  fs.writeFileSync(path.join(home, ".codecast", "sync-ledger.json"), JSON.stringify({
    [file]: { lastSyncedAt: Date.now() - 7_200_000, lastSyncedPosition: 0, messageCount: 1 },
  }));
  const positions = path.join(home, ".codecast", "positions.json");
  fs.writeFileSync(positions, JSON.stringify({ [file]: Buffer.byteLength(data) }));
  const args = [path.join(import.meta.dir, "main.ts"), "status"];
  const consumed = await run(process.execPath, args, home);
  expect(consumed, consumed.stderr).toMatchObject({ code: 0 });
  expect(consumed.stdout).not.toContain("Stuck syncs");
  fs.writeFileSync(positions, JSON.stringify({ [file]: 0 }));
  const unread = await run(process.execPath, args, home);
  expect(unread, unread.stderr).toMatchObject({ code: 0 });
  expect(unread.stdout).toContain("Stuck syncs");
}, 60_000);

describe("automatic upgrade installation ownership", () => {
  const sourceArgs = ["/src/codecast/packages/cli/src/daemon.ts", "_daemon"];
  const launcher = buildDaemonLauncherScript({ daemonCommand: "'/opt/bun' '/src/codecast/packages/cli/src/daemon.ts' '_daemon'" });

  test("the same installation may upgrade its daemon", () => {
    expect(daemonLauncherMatchesCommand(launcher, "/opt/bun", sourceArgs)).toBe(true);
  });

  test("a newer installed binary or worktree cannot bounce the source daemon", () => {
    expect(daemonLauncherMatchesCommand(launcher, "/bin/codecast", ["--", "_daemon"])).toBe(false);
    expect(daemonLauncherMatchesCommand(launcher, "/opt/bun", ["/src/codecast/.conductor/feature/packages/cli/src/daemon.ts", "_daemon"])).toBe(false);
    expect(daemonLauncherMatchesCommand("", "/opt/bun", sourceArgs)).toBe(false);
  });
});

describe.skipIf(process.platform !== "darwin")("production watchdog process", () => {
  async function prepare(home: string, convexUrl: string) {
    const dir = path.join(home, ".codecast");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ auth_token: "fixture-token", user_id: "fixture-user", convex_url: convexUrl }));
    fs.writeFileSync(path.join(dir, "daemon-launcher.sh"), buildDaemonLauncherScript({ daemonCommand: "'/different/install/codecast' '--' '_daemon'" }));
    const launchAgents = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(path.join(launchAgents, "sh.codecast.daemon.plist"), "fixture");
  }

  test.each([false, true])("the managed daemon refreshes an obsolete watchdog once (first reload fails: %s)", async (failFirst) => {
    const home = fixture();
    const dir = path.join(home, ".codecast");
    const launchAgents = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(launchAgents, { recursive: true });
    const launcher = path.join(dir, "daemon-launcher.sh");
    const daemonCommand = [process.execPath, path.join(import.meta.dir, "daemon.ts"), "_daemon"].map(shellEscapeForSh).join(" ");
    fs.writeFileSync(launcher, buildDaemonLauncherScript({ daemonCommand }));
    fs.writeFileSync(path.join(launchAgents, "sh.codecast.daemon.plist"), buildDaemonPlistXml({ scriptPath: launcher, configDir: dir }));
    const watchdog = path.join(dir, "watchdog.sh");
    fs.writeFileSync(watchdog, "old resident loop");
    fs.writeFileSync(path.join(dir, "watchdog.heartbeat"), String(Date.now()));
    fs.writeFileSync(path.join(launchAgents, "sh.codecast.watchdog.plist"), buildWatchdogPlistXml({ scriptPath: watchdog, configDir: dir }));
    if (failFirst) fs.writeFileSync(path.join(home, "fail-kickstart"), "1");
    const result = await run(process.execPath, [path.join(import.meta.dir, "test-helpers/watchdogRecovery.ts"), "supervise"], home);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(fs.readFileSync(watchdog, "utf-8")).toBe(buildWatchdogShellScript({ isBinary: false, watchdogCommand: "" }));
    const kickstarts = fs.readFileSync(path.join(home, "calls"), "utf-8").split("\n").filter((line) => line.startsWith("kickstart"));
    expect(kickstarts).toEqual(Array(failFirst ? 2 : 1).fill(`kickstart -k gui/${process.getuid!()}/sh.codecast.watchdog`));
  }, 30_000);

  test("a foreign watchdog leaves a live older daemon running", async () => {
    const home = fixture();
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ min_cli_version: "999.0.0" }) });
    const incumbent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await prepare(home, `http://127.0.0.1:${server.port}`);
      fs.writeFileSync(path.join(home, ".codecast", "daemon.pid"), String(incumbent.pid));
      fs.writeFileSync(path.join(home, ".codecast", "daemon.state"), JSON.stringify({ runtimeVersion: "0.0.1", lastHeartbeatTick: Date.now() }));
      const result = await run(process.execPath, [path.join(import.meta.dir, "test-helpers/watchdogRecovery.ts")], home);
      expect(result, result.stderr).toMatchObject({ code: 0 });
      expect(incumbent.exitCode).toBeNull();
      expect(incumbent.signalCode).toBeNull();
      expect(fs.existsSync(path.join(home, "calls"))).toBe(false);
    } finally {
      incumbent.kill("SIGKILL");
      server.stop(true);
    }
  }, 30_000);

  test("ordinary CLI use from a foreign installation leaves the managed daemon running", async () => {
    const home = fixture();
    const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
    const incumbent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await prepare(home, `http://127.0.0.1:${server.port}`);
      fs.writeFileSync(path.join(home, ".codecast", "daemon.pid"), String(incumbent.pid));
      fs.writeFileSync(path.join(home, ".codecast", "daemon.version"), "0.0.1");
      const result = await run(process.execPath, [path.join(import.meta.dir, "main.ts"), "config", "web_url"], home);
      expect(result, result.stderr).toMatchObject({ code: 0 });
      expect(incumbent.exitCode).toBeNull();
      expect(incumbent.signalCode).toBeNull();
      expect(fs.readFileSync(path.join(home, ".codecast", "daemon.pid"), "utf-8")).toBe(String(incumbent.pid));
      expect(fs.readFileSync(path.join(home, "calls"), "utf-8")).not.toContain("kickstart");
    } finally {
      incumbent.kill("SIGKILL");
      server.stop(true);
    }
  }, 30_000);

  // The compiled pass carries the two pass rule (supervision.ts
  // watchdogKillVerdict): a stale tick on one pass arms and leaves the process
  // alone; the next pass with the same unmoved tick SIGKILLs it, leaves the hang
  // marker naming the rule for the next daemon to consume, and tells the server
  // which rule fired.
  test("a wedged daemon survives the first pass and is killed on the second, with the rule recorded", async () => {
    const home = fixture();
    const dir = path.join(home, ".codecast");
    const logged: string[] = [];
    const server = Bun.serve({ port: 0, fetch: async (request) => {
      if (new URL(request.url).pathname === "/cli/log") logged.push(((await request.json()) as { message: string }).message);
      return Response.json({});
    } });
    const incumbent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await prepare(home, `http://127.0.0.1:${server.port}`);
      const now = Date.now();
      const staleTick = now - 5 * 60_000;
      fs.writeFileSync(path.join(dir, "daemon.pid"), String(incumbent.pid));
      fs.writeFileSync(path.join(dir, "daemon.state"), JSON.stringify({ runtimeVersion: "0.0.1", lastHeartbeatTick: staleTick }));
      fs.writeFileSync(path.join(dir, "daemon.log"), "");
      fs.utimesSync(path.join(dir, "daemon.log"), staleTick / 1000, staleTick / 1000);
      fs.writeFileSync(path.join(dir, "watchdog.pass"), String(now - 60_000));
      const helper = [path.join(import.meta.dir, "test-helpers/watchdogRecovery.ts")];

      const first = await run(process.execPath, helper, home, { productionLogs: true });
      expect(first, first.stderr).toMatchObject({ code: 0 });
      expect(incumbent.exitCode).toBeNull();
      expect(incumbent.signalCode).toBeNull();
      expect(JSON.parse(fs.readFileSync(path.join(dir, "watchdog.wedged"), "utf-8"))).toMatchObject({ pid: incumbent.pid, tick: staleTick });
      expect(fs.existsSync(path.join(dir, "daemon-hang.json"))).toBe(false);
      expect(logged.filter((m) => m.includes("watchdog_kill"))).toEqual([]);
      // The pass must not touch daemon.log: its mtime is the busy-grace evidence
      // that the daemon ran JS, and a pass that logged there would read its own
      // line next cycle as the daemon being busy and never kill.
      expect(Math.round(fs.statSync(path.join(dir, "daemon.log")).mtimeMs)).toBe(staleTick);
      expect(fs.readFileSync(path.join(dir, "watchdog-shell.log"), "utf-8")).toContain("first wedged pass");

      const second = await run(process.execPath, helper, home, { productionLogs: true });
      expect(second, second.stderr).toMatchObject({ code: 0 });
      await new Promise((resolve) => incumbent.once("exit", resolve));
      expect(incumbent.signalCode).toBe("SIGKILL");
      expect(fs.existsSync(path.join(dir, "watchdog.wedged"))).toBe(false);
      const marker = JSON.parse(fs.readFileSync(path.join(dir, "daemon-hang.json"), "utf-8"));
      expect(marker).toMatchObject({ pid: incumbent.pid, self_recovered: false, watchdog_rule: "two consecutive wedged passes, no self recovery in between" });
      expect(marker.unresponsive_ms).toBeGreaterThanOrEqual(5 * 60_000);
      const kills = logged.filter((m) => m.includes("watchdog_kill"));
      expect(kills).toHaveLength(1);
      expect(kills[0]).toContain(`pid=${incumbent.pid}`);
      expect(kills[0]).toContain('rule="two consecutive wedged passes, no self recovery in between"');
    } finally {
      if (incumbent.exitCode === null && incumbent.signalCode === null) incumbent.kill("SIGKILL");
      server.stop(true);
    }
  }, 60_000);

  test("a dead managed daemon recovers through its supervisor without consuming pending commands", async () => {
    const home = fixture();
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch: (request) => {
      requests.push(new URL(request.url).pathname);
      return Response.json({ min_cli_version: "999.0.0", commands: [{ id: "pending-send", command: "resume_session" }] });
    } });
    try {
      await prepare(home, `http://127.0.0.1:${server.port}`);
      const result = await run(process.execPath, [path.join(import.meta.dir, "test-helpers/watchdogRecovery.ts")], home);
      expect(result, result.stderr).toMatchObject({ code: 0 });
      const calls = fs.readFileSync(path.join(home, "calls"), "utf-8");
      expect(calls).toContain(`kickstart gui/${process.getuid!()}/sh.codecast.daemon`);
      expect(requests).toEqual(["/cli/heartbeat"]);
      expect(fs.existsSync(path.join(home, ".codecast", "daemon.pid"))).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a stalled heartbeat endpoint cannot block local recovery forever", async () => {
    const home = fixture();
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      await prepare(home, `http://127.0.0.1:${server.port}`);
      const result = await run(process.execPath, [path.join(import.meta.dir, "test-helpers/watchdogRecovery.ts")], home);
      expect(result, result.stderr).toMatchObject({ code: 0 });
      expect(fs.readFileSync(path.join(home, "calls"), "utf-8")).toContain(`kickstart gui/${process.getuid!()}/sh.codecast.daemon`);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
