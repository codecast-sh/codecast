import { describe, test, expect } from "bun:test";
import { resolveDeviceIdentity, resolveStableHostname } from "./device.js";

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

/**
 * Regression for the duplicate-reply / split-brain bug: Migration Assistant
 * copies ~/.codecast (machine key included) to a new Mac, both machines derive
 * the same device_id, and every conversation-ownership guard passes on both.
 * The binding file records which hardware an identity belongs to; a mismatch
 * means "this directory was disk-copied here" and the clone mints its own id.
 */
describe("resolveDeviceIdentity", () => {
  const deriveCloneId = (hw: string) => `clone-of-${hw}`;

  test("first run adopts the legacy id and binds it to this hardware", () => {
    expect(
      resolveDeviceIdentity({
        hardwareUUID: "HW-A",
        legacyId: "legacy00deadbeef",
        binding: null,
        deriveCloneId,
      }),
    ).toEqual({
      id: "legacy00deadbeef",
      persist: { hw: "HW-A", id: "legacy00deadbeef" },
    });
  });

  test("normal restart on the same hardware keeps the bound id, no rewrite", () => {
    expect(
      resolveDeviceIdentity({
        hardwareUUID: "HW-A",
        legacyId: "legacy00deadbeef",
        binding: { hw: "HW-A", id: "legacy00deadbeef" },
        deriveCloneId,
      }),
    ).toEqual({ id: "legacy00deadbeef", persist: null });
  });

  test("a disk-copied ~/.codecast mints a fresh id instead of impersonating the source", () => {
    expect(
      resolveDeviceIdentity({
        hardwareUUID: "HW-B", // new Mac
        legacyId: "legacy00deadbeef", // same copied machine key → same legacy id
        binding: { hw: "HW-A", id: "legacy00deadbeef" }, // binding copied along
        deriveCloneId,
      }),
    ).toEqual({
      id: "clone-of-HW-B",
      persist: { hw: "HW-B", id: "clone-of-HW-B" },
    });
  });

  test("a re-copied clone mints yet another id (chains of copies stay distinct)", () => {
    expect(
      resolveDeviceIdentity({
        hardwareUUID: "HW-C",
        legacyId: "legacy00deadbeef",
        binding: { hw: "HW-B", id: "clone-of-HW-B" },
        deriveCloneId,
      }),
    ).toEqual({
      id: "clone-of-HW-C",
      persist: { hw: "HW-C", id: "clone-of-HW-C" },
    });
  });

  test("a clone that loses its binding file reverts to the legacy id (known, documented gap)", () => {
    // The binding is the ONLY durable record that this machine is a clone;
    // without it, first-run adoption (required for zero-churn grandfathering)
    // cannot distinguish a clone from an original. Pinned so a future change
    // to this tradeoff is deliberate, not accidental.
    expect(
      resolveDeviceIdentity({
        hardwareUUID: "HW-B",
        legacyId: "legacy00deadbeef", // shared with the source machine
        binding: null, // .device_binding.json deleted after the clone minted its id
        deriveCloneId,
      }),
    ).toEqual({
      id: "legacy00deadbeef",
      persist: { hw: "HW-B", id: "legacy00deadbeef" },
    });
  });

  test("no hardware UUID → legacy behavior, trust the binding if present, never write one", () => {
    expect(
      resolveDeviceIdentity({
        hardwareUUID: "",
        legacyId: "legacy00deadbeef",
        binding: { hw: "HW-A", id: "bound0000000001" },
        deriveCloneId,
      }),
    ).toEqual({ id: "bound0000000001", persist: null });
    expect(
      resolveDeviceIdentity({
        hardwareUUID: "",
        legacyId: "legacy00deadbeef",
        binding: null,
        deriveCloneId,
      }),
    ).toEqual({ id: "legacy00deadbeef", persist: null });
  });
});
