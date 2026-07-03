import { describe, expect, test } from "bun:test";
import { shouldSelfHeal, buildLaunchdKickstartCommand, parseLaunchdPrintPid } from "./daemon.js";

const THRESHOLD = 5 * 60 * 1000;

describe("shouldSelfHeal", () => {
  test("does not restart when the event-loop tick is fresh", () => {
    expect(shouldSelfHeal(0, false)).toBe(false);
    expect(shouldSelfHeal(30_000, false)).toBe(false);
  });

  test("does not restart for a merely-slow loop just past the cadence", () => {
    // 60s lag is the existing 'frozen' threshold; still well under the self-heal bar
    // so transient load never triggers a restart.
    expect(shouldSelfHeal(60_000, false)).toBe(false);
    expect(shouldSelfHeal(THRESHOLD, false)).toBe(false); // boundary is exclusive
  });

  test("restarts once the tick is staler than the threshold (timers dead)", () => {
    expect(shouldSelfHeal(THRESHOLD + 1, false)).toBe(true);
    // post-sleep: hours of staleness
    expect(shouldSelfHeal(5 * 60 * 60 * 1000, false)).toBe(true);
  });

  test("never restarts twice — already-healing wins regardless of staleness", () => {
    expect(shouldSelfHeal(10 * 60 * 60 * 1000, true)).toBe(false);
  });
});

describe("buildLaunchdKickstartCommand", () => {
  // We imperatively kickstart launchd on self-heal rather than trusting KeepAlive to
  // respawn after exit (observed: KeepAlive silently did not respawn, daemon stayed
  // dead for hours). A malformed command here means the daemon never recovers, so the
  // exact shape is load-bearing.
  test("targets the daemon job in the user's gui domain with kill-before-start", () => {
    expect(buildLaunchdKickstartCommand(501)).toBe(
      "sleep 1; launchctl kickstart -k gui/501/sh.codecast.daemon",
    );
  });

  test("interpolates the real uid", () => {
    expect(buildLaunchdKickstartCommand(0)).toContain("gui/0/sh.codecast.daemon");
    expect(buildLaunchdKickstartCommand(1234)).toContain("gui/1234/");
  });
});

describe("parseLaunchdPrintPid", () => {
  // Ownership ("is launchd's supervised instance THIS process?") is decided by
  // comparing this pid against launchd's own answer. The env-var probe it replaced
  // (XPC_SERVICE_NAME) leaked into self-spawned children, which then restarted via
  // kickstart -k — a command that cannot kill a non-job process — leaving a rogue
  // daemon running while the watchdog storm-kickstarted doomed duplicates.
  const RUNNING_JOB = [
    "gui/501/sh.codecast.daemon = {",
    "\tactive count = 1",
    "\tpath = /Users/ashot/Library/LaunchAgents/sh.codecast.daemon.plist",
    "\tstate = running",
    "\tprogram = /Users/ashot/.bun/bin/bun",
    "\tpid = 72975",
    "\tlast exit code = (never exited)",
    "\truntime = {",
    "\t\tstate = active",
    "\t}",
    "}",
  ].join("\n");

  test("extracts the instance pid from a running job's print output", () => {
    expect(parseLaunchdPrintPid(RUNNING_JOB)).toBe(72975);
  });

  test("returns null when the job is loaded but has no running instance", () => {
    const notRunning = RUNNING_JOB.split("\n").filter(l => !l.includes("pid =")).join("\n");
    expect(parseLaunchdPrintPid(notRunning)).toBeNull();
  });

  test("ignores pid-like text that is not the instance pid line", () => {
    expect(parseLaunchdPrintPid('\tspawn type = daemon\n\tsomething = "pid = 999 in a string"\n')).toBeNull();
    expect(parseLaunchdPrintPid("")).toBeNull();
  });
});
