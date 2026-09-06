import { describe, expect, test } from "bun:test";
import {
  buildDaemonLauncherScript,
  buildDaemonPlistXml,
  buildWatchdogPlistXml,
  buildWatchdogShellScript,
  daemonPlistNeedsUpgrade,
  daemonTickStale,
  DAEMON_EXIT_STAMP_FILE,
  DAEMON_HEARTBEAT_STALE_MS,
  EXIT_DO_NOT_RESTART,
  extractPlistProgramArguments,
  shellEscapeForSh,
  watchdogPlistNeedsUpgrade,
  watchdogHeartbeatStale,
  watchdogHeartbeatAge,
  WATCHDOG_AWAKE_GAP_MS,
  WATCHDOG_HEARTBEAT_STALE_MS,
} from "./supervision.js";
import { watchdogSupervisionAction } from "./daemon.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: a routine daemon redeploy that landed right before the Mac slept left
// the daemon dead for 3.5h. The watchdog was a launchd StartInterval one-shot, which
// does not fire across sleep (observed wedged at runs=1 for 27h), so nothing revived
// the daemon until the Mac woke. The fix makes the watchdog a RESIDENT KeepAlive loop
// and makes mutual supervision check the watchdog's heartbeat (liveness), not just
// whether launchd lists it as loaded.

describe("watchdog plist is a resident KeepAlive job, not a StartInterval one-shot", () => {
  const plist = buildWatchdogPlistXml({ scriptPath: "/Users/x/.codecast/watchdog.sh", configDir: "/Users/x/.codecast" });

  test("uses KeepAlive so launchd relaunches the loop if it ever exits", () => {
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
  });

  test("does NOT use StartInterval — the primitive that silently stopped firing", () => {
    expect(plist).not.toContain("StartInterval");
  });

  test("runs via the /bin/sh wrapper at the given script path", () => {
    expect(plist).toContain("<string>/bin/sh</string>");
    expect(plist).toContain("<string>/Users/x/.codecast/watchdog.sh</string>");
  });
});

describe("watchdog shell script is a resident loop that stamps a heartbeat", () => {
  const dev = buildWatchdogShellScript({ isBinary: false, watchdogCommand: "" });
  const bin = buildWatchdogShellScript({ isBinary: true, watchdogCommand: "/Users/x/.local/bin/codecast -- _watchdog" });

  test("dev form loops forever and sleeps between checks (survives sleep via resume)", () => {
    expect(dev).toContain("while :;");
    expect(dev).toContain("sleep ");
  });

  test("dev form still revives a dead daemon via kickstart", () => {
    expect(dev).toContain("launchctl kickstart -k");
    expect(dev).toContain("bootstrapping from plist");
  });

  test("binary form loops and invokes the compiled _watchdog pass", () => {
    expect(bin).toContain("while :;");
    expect(bin).toContain("/Users/x/.local/bin/codecast -- _watchdog");
  });

  test("both forms stamp the watchdog heartbeat each cycle so the daemon sees liveness", () => {
    expect(dev).toContain('> "$HEARTBEAT"');
    expect(bin).toContain('> "$HEARTBEAT"');
  });

  test("dev form defers the stale-tick restart when its own loop gap shows the machine slept", () => {
    expect(dev).toContain("LOOP_GAP");
    expect(dev).toContain(`-lt ${WATCHDOG_AWAKE_GAP_MS}`);
    expect(dev).toContain("deferring one cycle");
  });
});

// Regression: the daemon's heartbeat tick freezes during system sleep exactly
// like a wedged event loop, and the watchdog resumes within seconds of wake —
// usually before the daemon's 30s stamp interval fires. Judging tick age alone
// force-restarted a HEALTHY daemon on nearly every wake (observed staleness
// values matched the wake_detected suspension durations; 10-20 kills/day). A
// stale tick only counts when the watchdog's own gap since its previous pass
// shows the machine was continuously awake.
describe("daemonTickStale: wedged event loop vs the machine just slept", () => {
  const STALE = DAEMON_HEARTBEAT_STALE_MS + 1;

  test("fresh tick is never stale, regardless of gap", () => {
    expect(daemonTickStale(30_000, 60_000)).toBe(false);
    expect(daemonTickStale(DAEMON_HEARTBEAT_STALE_MS, 60_000)).toBe(false); // boundary exclusive
  });

  test("stale tick + normal awake gap = wedged, restart", () => {
    expect(daemonTickStale(STALE, 62_000)).toBe(true);
  });

  test("stale tick right after a sleep (large gap) = defer, the daemon hasn't had a chance to re-stamp", () => {
    const fifteenMinNap = 15 * 60 * 1000;
    expect(daemonTickStale(fifteenMinNap, fifteenMinNap + 60_000)).toBe(false);
    expect(daemonTickStale(STALE, WATCHDOG_AWAKE_GAP_MS)).toBe(false); // boundary: gap must be strictly under
  });

  test("first pass (no baseline gap) defers rather than killing blind", () => {
    expect(daemonTickStale(STALE, null)).toBe(false);
    expect(daemonTickStale(STALE, -1)).toBe(false);
  });

  test("a truly wedged daemon is still caught one cycle after wake — gap normalizes, tick stays stale", () => {
    // Cycle N (just woke): deferred. Cycle N+1 (60s awake later): restart.
    const tickAgeNextCycle = 15 * 60 * 1000 + 60_000;
    expect(daemonTickStale(tickAgeNextCycle, 61_000)).toBe(true);
  });

  // Regression: a slow boot (transcript sweeps, per-file git subprocesses over a
  // multi-GB ~/.claude/projects) starves the tick stamper while still writing
  // daemon.log constantly. The watchdog killed it as "wedged" 27s after the
  // unsynced-file flush finally started, and every restart redid the same slow
  // boot — a kill loop that froze all sessions (2026-08-10). A wedged event loop
  // runs no JS and cannot log, so fresh log writes prove busy-not-dead.
  test("stale tick but fresh daemon.log writes = busy boot, not wedged — spare it", () => {
    expect(daemonTickStale(STALE, 62_000, 10_000)).toBe(false);
    expect(daemonTickStale(STALE, 62_000, DAEMON_HEARTBEAT_STALE_MS)).toBe(false); // boundary inclusive
  });

  test("stale tick + silent daemon.log = genuinely wedged, restart", () => {
    expect(daemonTickStale(STALE, 62_000, DAEMON_HEARTBEAT_STALE_MS + 1)).toBe(true);
  });

  test("unknown log age (stat failed) falls back to tick-only judgment", () => {
    expect(daemonTickStale(STALE, 62_000, null)).toBe(true);
  });
});

describe("watchdogPlistNeedsUpgrade migrates legacy installs", () => {
  test("flags a StartInterval plist for replacement (the bug we shipped)", () => {
    const legacy = buildLegacyStartIntervalPlist();
    expect(watchdogPlistNeedsUpgrade(legacy)).toBe(true);
  });

  test("flags a pre-/bin/sh direct-binary plist", () => {
    expect(watchdogPlistNeedsUpgrade("<string>/Users/x/.local/bin/codecast</string>")).toBe(true);
  });

  test("leaves the current resident KeepAlive plist alone", () => {
    const current = buildWatchdogPlistXml({ scriptPath: "/Users/x/.codecast/watchdog.sh", configDir: "/Users/x/.codecast" });
    expect(watchdogPlistNeedsUpgrade(current)).toBe(false);
  });
});

describe("watchdogHeartbeatStale: liveness, not loaded-ness", () => {
  const now = 1_000_000_000_000;

  test("fresh stamp is not stale", () => {
    expect(watchdogHeartbeatStale(String(now - 30_000), now)).toBe(false);
  });

  test("a stamp older than the threshold is stale (loop wedged)", () => {
    expect(watchdogHeartbeatStale(String(now - WATCHDOG_HEARTBEAT_STALE_MS - 1), now)).toBe(true);
  });

  test("missing stamp is NOT treated as stale — a fresh install has not stamped yet", () => {
    expect(watchdogHeartbeatStale(null, now)).toBe(false);
  });

  test("garbage stamp is ignored rather than triggering thrash restarts", () => {
    expect(watchdogHeartbeatStale("not-a-number", now)).toBe(false);
    expect(watchdogHeartbeatAge("not-a-number", now)).toBe(null);
  });
});

// Regression: the daemon plist used to point launchd directly at the codecast
// binary. The binary is ad-hoc signed, so macOS BTM identified the login item by
// the binary's content hash — and every self-update re-registered it as a NEW
// background item, spamming the user with "codecast can run in the background"
// notifications on each release. The plist must run /bin/sh (stable Apple-signed
// identity) exec'ing a launcher script that holds the mutable command.
describe("daemon plist has a stable BTM identity via the /bin/sh launcher", () => {
  const plist = buildDaemonPlistXml({ scriptPath: "/Users/x/.codecast/daemon-launcher.sh", configDir: "/Users/x/.codecast" });

  test("daemon stays KeepAlive + fast throttle", () => {
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
  });

  test("runs via /bin/sh + launcher script, never the binary directly", () => {
    expect(plist).toContain("<string>/bin/sh</string>");
    expect(plist).toContain("<string>/Users/x/.codecast/daemon-launcher.sh</string>");
    expect(daemonPlistNeedsUpgrade(plist)).toBe(false);
  });

  test("launcher execs the daemon command so launchd tracks the daemon's pid", () => {
    const script = buildDaemonLauncherScript({ daemonCommand: "'/Users/x/.local/bin/codecast' '--' '_daemon'" });
    expect(script).toContain("exec '/Users/x/.local/bin/codecast' '--' '_daemon'");
    expect(script.startsWith("#!/bin/sh")).toBe(true);
  });
});

describe("daemonPlistNeedsUpgrade migrates legacy direct-binary installs", () => {
  test("flags the legacy form that re-notified on every binary self-update", () => {
    expect(daemonPlistNeedsUpgrade(buildLegacyDirectBinaryDaemonPlist())).toBe(true);
  });

  test("leaves the /bin/sh launcher form alone (migration runs once)", () => {
    const current = buildDaemonPlistXml({ scriptPath: "/Users/x/.codecast/daemon-launcher.sh", configDir: "/Users/x/.codecast" });
    expect(daemonPlistNeedsUpgrade(current)).toBe(false);
  });
});

describe("extractPlistProgramArguments preserves the install's exact command", () => {
  test("round-trips a compiled-binary plist", () => {
    expect(extractPlistProgramArguments(buildLegacyDirectBinaryDaemonPlist())).toEqual([
      "/Users/x/.local/bin/codecast",
      "--",
      "_daemon",
    ]);
  });

  test("returns [] when there is no ProgramArguments array to vouch for", () => {
    expect(extractPlistProgramArguments("<plist><dict></dict></plist>")).toEqual([]);
  });

  test("extracted args shell-escape safely into a launcher command", () => {
    const args = extractPlistProgramArguments(buildLegacyDirectBinaryDaemonPlist());
    const script = buildDaemonLauncherScript({ daemonCommand: args.map(shellEscapeForSh).join(" ") });
    expect(script).toContain("exec '/Users/x/.local/bin/codecast' '--' '_daemon'");
  });
});

function buildLegacyDirectBinaryDaemonPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/x/.local/bin/codecast</string>
    <string>--</string>
    <string>_daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;
}

function buildLegacyStartIntervalPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>/Users/x/.codecast/watchdog.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
}

// The supervision tick is async now; its decision is pure so the branches are
// checked without launchd.
describe("watchdogSupervisionAction", () => {
  const now = 1_800_000_000_000;
  // The stamp is the epoch ms the watchdog loop last wrote, as a bare integer.
  const fresh = String(now - 10_000);
  const stale = String(now - WATCHDOG_HEARTBEAT_STALE_MS - 60_000);

  test("not loaded with a plist bootstraps; without one it can only ask for cast setup", () => {
    expect(watchdogSupervisionAction({ loaded: false, plistExists: true, heartbeat: null, now })).toBe("bootstrap");
    expect(watchdogSupervisionAction({ loaded: false, plistExists: false, heartbeat: null, now })).toBe("plist_missing");
  });

  test("loaded with a fresh heartbeat needs nothing", () => {
    expect(watchdogHeartbeatStale(fresh, now)).toBe(false);
    expect(watchdogSupervisionAction({ loaded: true, plistExists: true, heartbeat: fresh, now })).toBe("none");
  });

  test("loaded with a stale heartbeat kickstarts the loop; a missing stamp is not stale", () => {
    expect(watchdogSupervisionAction({ loaded: true, plistExists: true, heartbeat: stale, now })).toBe("kickstart");
    // No stamp yet (a watchdog that just loaded) must not be kickstarted in a
    // loop; watchdogHeartbeatStale answers false for a missing stamp.
    expect(watchdogHeartbeatStale(null, now)).toBe(false);
    expect(watchdogSupervisionAction({ loaded: true, plistExists: true, heartbeat: null, now })).toBe("none");
  });
});

// A daemon can stop for a configuration fact no restart can change (no HOME, an
// unusable ~/.codecast). To a supervisor that only sees "the process is gone"
// that is indistinguishable from a crash, so it revived the daemon every minute
// into the same failure. Exit code 78 plus the stamp file is how the daemon says
// "not until a human fixes this" — and BOTH watchdog forms have to honour it.
describe("exit 78: do not restart", () => {
  test("the code is sysexits' EX_CONFIG, not an ad-hoc number", () => {
    expect(EXIT_DO_NOT_RESTART).toBe(78);
  });

  test("the dev shell watchdog checks the stamp BEFORE it revives anything", () => {
    const dev = buildWatchdogShellScript({ isBinary: false, watchdogCommand: "" });
    expect(dev).toContain(DAEMON_EXIT_STAMP_FILE);
    expect(dev).toContain(`grep -q '"code"[[:space:]]*:[[:space:]]*${EXIT_DO_NOT_RESTART}'`);
    // Order is the whole point: a guard after the kickstart would restart the
    // daemon and only then decide it should not have.
    const guardAt = dev.indexOf(DAEMON_EXIT_STAMP_FILE);
    const kickstartAt = dev.indexOf("launchctl kickstart -k");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(kickstartAt);
    // …and it names the way back: the stamp is cleared by the next daemon that
    // boots past the config gate.
    expect(dev).toContain("cast start");
  });

  test("the binary form delegates the decision to the compiled pass, which makes the same check", () => {
    const bin = buildWatchdogShellScript({ isBinary: true, watchdogCommand: "/Users/x/.local/bin/codecast -- _watchdog" });
    // The binary loop never restarts the daemon itself — runWatchdog does, and
    // it calls noRestartReason (daemonMarkers.ts) before spawning.
    expect(bin).toContain("_watchdog");
    expect(bin).not.toContain("launchctl kickstart");
    const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf-8");
    const restartAt = source.indexOf('logLine("Daemon not running, restarting...")');
    const guardAt = source.indexOf("noRestartReason(CONFIG_DIR)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(restartAt);
  });

  test("the daemon's own crash-backoff respawn honours it too", () => {
    // Otherwise the daemon relaunches itself into the same config failure and
    // records it as a crash loop.
    const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf-8");
    expect(source).toContain("if (code === EXIT_DO_NOT_RESTART) return;");
  });

  // The shell script is the form that actually runs on a from-source install, so
  // run it: one pass of check_once against a scratch HOME, with launchctl
  // replaced by a stub that records its arguments. Nothing here can touch the
  // real daemon — the stub is the only launchctl on PATH.
  describe("executed against a scratch HOME", () => {
    const runOnce = (stamp?: string) => {
      const home = mkdtempSync(join(tmpdir(), "watchdog-run-"));
      const bin = join(home, "bin");
      mkdirSync(join(home, ".codecast"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "launchctl"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/launchctl.calls"\nexit 1\n`,
        { mode: 0o755 },
      );
      if (stamp) writeFileSync(join(home, ".codecast", DAEMON_EXIT_STAMP_FILE), stamp);
      const script = buildWatchdogShellScript({ isBinary: false, watchdogCommand: "" })
        // The resident loop would never return; run its body exactly once.
        .replace(/while :;[\s\S]*$/, "check_once\n");
      const scriptPath = join(home, "watchdog.sh");
      writeFileSync(scriptPath, script);
      spawnSync("sh", [scriptPath], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf-8" });
      const read = (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return ""; } };
      const result = {
        launchctl: read(join(home, "launchctl.calls")),
        log: read(join(home, ".codecast", "watchdog-shell.log")),
      };
      rmSync(home, { recursive: true, force: true });
      return result;
    };

    test("with no stamp it revives the daemon (the behaviour the guard must not break)", () => {
      const { launchctl } = runOnce();
      expect(launchctl).toContain("kickstart");
    });

    test("with an exit-78 stamp it revives nothing and says why", () => {
      const { launchctl, log } = runOnce(JSON.stringify({ code: 78, at: 1, reason: "HOME is not set" }));
      expect(launchctl).not.toContain("kickstart");
      expect(launchctl).not.toContain("bootstrap");
      expect(log).toContain("do not restart");
      expect(log).toContain("HOME is not set");
    });

    test("a stamp from an ordinary crash still revives it", () => {
      const { launchctl } = runOnce(JSON.stringify({ code: 1, at: 1, reason: "crashed" }));
      expect(launchctl).toContain("kickstart");
    });
  });
});
