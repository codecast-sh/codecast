import { describe, expect, test } from "bun:test";
import { shouldSelfHeal, buildLaunchdKickstartCommand } from "./daemon.js";

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
