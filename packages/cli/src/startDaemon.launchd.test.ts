import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { buildWatchdogShellScript, WATCHDOG_HEARTBEAT_STALE_MS } from "./supervision.js";

// `cast start` on a machine with the LaunchAgent installed must make launchd
// actually spawn the daemon, and must not claim success when it did not.
//
// launchd bootstrap is a no-op on a job it already has loaded, and it holds a
// loaded KeepAlive job whose recent runs all crashed in a pended state instead
// of respawning it. With bootstrap alone, `cast start` did nothing and then
// printed "Daemon started" after its 5s poll timed out — the daemon stayed dead
// for 90 minutes on 2026-09-15 until someone ran kickstart by hand.
//
// A source scan, because startDaemon is inline in the CLI module tail and
// cannot be imported without running the CLI.

const source = fs.readFileSync(path.join(import.meta.dir, "index.ts"), "utf-8");

/** The body of `function <name>(...)`, by brace balance from its opening `{`. */
function functionBody(name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced body for ${name}`);
}

describe("startDaemon under launchd", () => {
  const body = functionBody("startDaemon");

  test("kickstarts a loaded job instead of relying on bootstrap", () => {
    expect(body).toContain("kickstartManagedDaemon()");
    expect(functionBody("kickstartManagedDaemon")).toContain('"kickstart"');
  });

  test("reports success only after the launchd pid is observed", () => {
    // One print inside the poll loop (pid seen) plus one on the spawn path;
    // none after the launchd poll gives up.
    const launchdBranch = body.slice(body.indexOf("managedPlistPath && launchdUid"), body.indexOf("let child"));
    expect(launchdBranch.match(/console\.log\("Daemon started"\)/g)?.length).toBe(1);
    expect(launchdBranch).toContain("process.exitCode = 1");
  });
});

describe("_watchdog pass", () => {
  test("exits the process explicitly after the pass", () => {
    // daemon.js arms module-level timers at import, so without an explicit
    // exit the shell watchdog loop waits on a finished pass forever.
    const at = source.indexOf('.command("_watchdog"');
    expect(at).toBeGreaterThan(-1);
    const action = source.slice(at, source.indexOf("\nprogram", at));
    expect(action).toContain("process.exit(code)");
    expect(action).toContain("code = 1");
  });

  test("lets an auto-update in flight finish before it exits, but not a hung manifest check", () => {
    // The pass is done in under a second and a download is not: exiting under
    // it would start the same download again on every pass. The manifest fetch
    // before it has no timeout, so only an install in progress is waited out.
    const at = source.indexOf('.command("_watchdog"');
    const action = source.slice(at, source.indexOf("\nprogram", at));
    const waitAt = action.indexOf("if (autoUpdateInstalling) await settled");
    expect(waitAt).toBeGreaterThan(-1);
    expect(action.indexOf("Promise.race([settled")).toBeGreaterThan(-1);
    expect(waitAt).toBeLessThan(action.indexOf("process.exit(code)"));
    expect(source).toContain("autoUpdateSettled = checkForUpdates()");
    expect(source.indexOf("autoUpdateInstalling = true")).toBeLessThan(source.indexOf("await performUpdate();", source.indexOf("autoUpdateInstalling = true")));
  });
});

describe("cast start --wait", () => {
  test("a daemon the health wait saw come up clears startDaemon's failed exit code", () => {
    const ok = functionBody("finishWithHealthWait");
    expect(ok.indexOf("process.exitCode = 0")).toBeGreaterThan(-1);
    expect(ok.indexOf("process.exitCode = 0")).toBeLessThan(ok.indexOf("process.exit(1)"));
  });
});

// The production watchdog loop runs each pass in the foreground, so a pass that
// never returns ends all supervision. Run the real script once against a scratch
// HOME, with the pass and curl replaced by stubs.
describe("binary watchdog loop, executed", () => {
  const runOnce = (passBody: string, setup?: (home: string) => void) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-bin-"));
    const bin = path.join(home, "bin");
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "pass"), `#!/bin/sh\n${passBody}\n`, { mode: 0o755 });
    // The failed-pass path asks for latest.json; failing it ends that path at once.
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
    setup?.(home);
    const script = buildWatchdogShellScript({ isBinary: true, watchdogCommand: path.join(bin, "pass") })
      .replace(/^PASS_TIMEOUT=.*$/m, "PASS_TIMEOUT=1")
      .replace(/^MAX_LOG_BYTES=.*$/m, "MAX_LOG_BYTES=10")
      // The resident loop would never return; run its body exactly once.
      .replace(/while :;[\s\S]*$/, "run_check\n");
    const scriptPath = path.join(home, "watchdog.sh");
    fs.writeFileSync(scriptPath, script);
    const started = Date.now();
    const r = spawnSync("sh", [scriptPath], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf-8", timeout: 20_000 });
    const read = (p: string) => { try { return fs.readFileSync(path.join(home, ".codecast", p), "utf-8"); } catch { return ""; } };
    const result = { status: r.status, ms: Date.now() - started, log: read("watchdog-shell.log"), read };
    return { ...result, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
  };

  test("a pass that never returns is killed at the deadline and the loop moves on", () => {
    const r = runOnce("sleep 60");
    r.cleanup();
    expect(r.ms).toBeLessThan(10_000);
    expect(r.log).toContain("still running after 1s");
    expect(r.log).toContain("Watchdog failed (exit 137)");
  });

  test("the deadline ends a pass before the daemon reads the loop as wedged", () => {
    // The heartbeat is stamped once per cycle, so a pass plus the 60s sleep must
    // fit inside the stale threshold or the daemon kickstarts the watchdog first.
    const script = buildWatchdogShellScript({ isBinary: true, watchdogCommand: "pass" });
    const timeout = Number(script.match(/^PASS_TIMEOUT=(\d+)$/m)?.[1]);
    const interval = Number(script.match(/^WATCHDOG_INTERVAL=(\d+)$/m)?.[1]);
    expect(timeout).toBeGreaterThan(180);
    expect((timeout + interval) * 1000).toBeLessThan(WATCHDOG_HEARTBEAT_STALE_MS);
  });

  test("a healthy pass is left alone", () => {
    const r = runOnce("exit 0");
    r.cleanup();
    expect(r.status).toBe(0);
    expect(r.log).toBe("");
  });

  test("oversized daemon logs are rotated, as in the from-source form", () => {
    const r = runOnce("exit 0", (home) => fs.writeFileSync(path.join(home, ".codecast", "daemon.log"), "x".repeat(100)));
    const [live, rotated] = [r.read("daemon.log"), r.read("daemon.log.1")];
    r.cleanup();
    expect(live).toBe("");
    expect(rotated.length).toBe(100);
  });
});
