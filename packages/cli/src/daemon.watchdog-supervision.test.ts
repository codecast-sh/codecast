import { describe, expect, test } from "bun:test";
import {
  buildDaemonLauncherScript,
  buildDaemonPlistXml,
  buildWatchdogPlistXml,
  buildWatchdogShellScript,
  daemonPlistNeedsUpgrade,
  daemonTickStale,
  DAEMON_HEARTBEAT_STALE_MS,
  extractPlistProgramArguments,
  shellEscapeForSh,
  watchdogPlistNeedsUpgrade,
  watchdogHeartbeatStale,
  watchdogHeartbeatAge,
  WATCHDOG_AWAKE_GAP_MS,
  WATCHDOG_HEARTBEAT_STALE_MS,
} from "./supervision.js";

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
