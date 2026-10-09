import { describe, expect, test } from "bun:test";
import { DEVICE_ONLINE_MS } from "@codecast/convex/convex/deviceRouting";
import { runnerSilenceAt } from "./useRunnerSilence";

const NOW = 1_800_000_000_000;
const machine = (silentMs: number) => ({ device_id: "d1", label: "jb-m5-max", platform: "darwin", last_seen: NOW - silentMs });

describe("runnerSilenceAt", () => {
  test("a machine that beat inside the online window is not silent", () => {
    expect(runnerSilenceAt(machine(DEVICE_ONLINE_MS - 1), NOW)).toBeNull();
  });

  test("a machine past the window is named with how long it has been silent", () => {
    expect(runnerSilenceAt(machine(DEVICE_ONLINE_MS), NOW)).toBe("jb-m5-max, offline 2 min");
    expect(runnerSilenceAt(machine(131.8 * 3_600_000), NOW)).toBe("jb-m5-max, offline 5 days");
  });

  test("no machine, or one whose last beat the server did not send, says nothing", () => {
    expect(runnerSilenceAt(null, NOW)).toBeNull();
    expect(runnerSilenceAt(undefined, NOW)).toBeNull();
    expect(runnerSilenceAt({ label: "jb-m5-max" }, NOW)).toBeNull();
  });
});
