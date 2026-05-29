import { describe, expect, test } from "bun:test";
import {
  buildDaemonPlistXml,
  buildWatchdogPlistXml,
  buildWatchdogShellScript,
  watchdogPlistNeedsUpgrade,
  watchdogHeartbeatStale,
  watchdogHeartbeatAge,
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

describe("daemon plist keeps its KeepAlive supervision", () => {
  test("daemon stays KeepAlive + fast throttle", () => {
    const plist = buildDaemonPlistXml({ programArgsXml: "    <string>/x/codecast</string>", configDir: "/Users/x/.codecast" });
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
  });
});

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
