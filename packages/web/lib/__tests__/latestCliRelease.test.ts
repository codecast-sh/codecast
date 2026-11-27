import { afterEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { behindRelease, newestRelease } from "../latestCliRelease";

describe("behindRelease (Settings > Daemon, ct-102439)", () => {
  it("compares the running version to the manifest's release by number", () => {
    expect(behindRelease("1.1.300", "1.1.305")).toBe(true);
    expect(behindRelease("1.1.99", "1.1.100")).toBe(true);
    expect(behindRelease("1.1.305", "1.1.305")).toBe(false);
    expect(behindRelease("1.1.306", "1.1.305")).toBe(false);
  });

  it("calls nothing behind before the manifest is read, or for a version that is not a release", () => {
    expect(behindRelease("1.1.300", null)).toBe(false);
    expect(behindRelease(undefined, "1.1.305")).toBe(false);
    expect(behindRelease("dev", "1.1.305")).toBe(false);
  });
});

describe("newestRelease (what Settings > Daemon's Update sends)", () => {
  it("a window's kept read older than the device's own check sends the device's, so the request is not cleared", () => {
    expect(newestRelease("1.1.305", "1.1.310")).toBe("1.1.310");
    expect(newestRelease("1.1.310", "1.1.305")).toBe("1.1.310");
    expect(newestRelease("1.1.100", "1.1.99")).toBe("1.1.100");
  });

  it("skips what is no release, and names none when nothing is", () => {
    expect(newestRelease("1.1.305", undefined)).toBe("1.1.305");
    expect(newestRelease(null, "1.1.305")).toBe("1.1.305");
    expect(newestRelease("dev", "1.1.305")).toBe("1.1.305");
    expect(newestRelease(undefined, null)).toBeNull();
  });
});

describe("requestDeviceUpdate", () => {
  const before = useInboxStore.getState().machineRoster;
  afterEach(() => useInboxStore.setState({ machineRoster: before } as any));

  it("paints the release it names on the roster row", () => {
    useInboxStore.setState({ machineRoster: [{ device_id: "mac", cli_version: "1.1.300" }] } as any);
    void useInboxStore.getState().requestDeviceUpdate("mac", "1.1.305").catch(() => {});
    expect((useInboxStore.getState().machineRoster as any[])[0]).toMatchObject({ update_state: "requested", update_requested_version: "1.1.305" });
  });
});
