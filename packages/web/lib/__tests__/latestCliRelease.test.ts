import { afterEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { behindRelease } from "../latestCliRelease";

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

describe("requestDeviceUpdate", () => {
  const before = useInboxStore.getState().machineRoster;
  afterEach(() => useInboxStore.setState({ machineRoster: before } as any));

  it("paints the release it names on the roster row", () => {
    useInboxStore.setState({ machineRoster: [{ device_id: "mac", cli_version: "1.1.300" }] } as any);
    void useInboxStore.getState().requestDeviceUpdate("mac", "1.1.305").catch(() => {});
    expect((useInboxStore.getState().machineRoster as any[])[0]).toMatchObject({ update_state: "requested", update_requested_version: "1.1.305" });
  });
});
