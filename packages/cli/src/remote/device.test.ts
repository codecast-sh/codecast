import { describe, test, expect } from "bun:test";
import { resolveStableHostname } from "./device.js";

/**
 * Regression for the "Xiaomi-12-Lite" device-label bug: macOS overwrites the
 * transient kernel hostname (what os.hostname() returns) with a name handed out
 * by the network — a DHCP offer or reverse-DNS of the leased IP. Sharing a LAN
 * with a phone that once held your IP made a Mac report itself as the phone's
 * model. The fix is to prefer the names macOS keeps for the machine.
 */
describe("resolveStableHostname", () => {
  const scutilOf =
    (names: Partial<Record<"HostName" | "LocalHostName", string>>) =>
    (key: "HostName" | "LocalHostName") =>
      names[key] ?? "";

  test("macOS ignores a DHCP-leaked os.hostname() in favor of LocalHostName", () => {
    expect(
      resolveStableHostname({
        platform: "darwin",
        osHostname: () => "Xiaomi-12-Lite", // network-leaked transient name
        scutil: scutilOf({ LocalHostName: "MacBook-Pro-7" }), // HostName unset
      }),
    ).toBe("MacBook-Pro-7");
  });

  test("macOS prefers an admin-set HostName over everything else", () => {
    expect(
      resolveStableHostname({
        platform: "darwin",
        osHostname: () => "Xiaomi-12-Lite",
        scutil: scutilOf({ HostName: "ashots-mac", LocalHostName: "MacBook-Pro-7" }),
      }),
    ).toBe("ashots-mac");
  });

  test("macOS falls back to os.hostname() when scutil yields nothing", () => {
    expect(
      resolveStableHostname({
        platform: "darwin",
        osHostname: () => "real-host",
        scutil: scutilOf({}), // both unset / scutil unavailable
      }),
    ).toBe("real-host");
  });

  test("non-macOS always trusts os.hostname() (no DHCP adoption there)", () => {
    let scutilCalled = false;
    const name = resolveStableHostname({
      platform: "linux",
      osHostname: () => "linux-box",
      scutil: () => {
        scutilCalled = true;
        return "should-not-be-used";
      },
    });
    expect(name).toBe("linux-box");
    expect(scutilCalled).toBe(false);
  });
});
