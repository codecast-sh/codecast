import { describe, expect, it } from "bun:test";
import { compareMachineChips, deviceDisplayName, deviceKindLabel, isCloudAssignedHostname, isRemoteHost } from "./deviceName";

describe("deviceDisplayName", () => {
  it("shows a laptop by its hostname without the OS prefix and .local", () => {
    expect(deviceDisplayName({ label: "macOS - MacBook-Pro-4.local", platform: "darwin" })).toBe("MacBook-Pro-4");
    expect(deviceDisplayName({ label: "Linux - Anduril", platform: "linux", is_remote: false })).toBe("Anduril");
  });

  it("names an AWS instance by kind instead of its private-IP hostname", () => {
    expect(
      deviceDisplayName({ label: "macOS - ip-172-31-29-242.us-east-2.compute.internal", platform: "darwin", is_remote: false }),
    ).toBe("AWS Mac");
    expect(deviceDisplayName({ label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: false })).toBe("AWS Linux");
    expect(deviceDisplayName({ label: "ip-10-0-0-1", platform: "win32" })).toBe("AWS Windows");
  });

  it("does not mistake a real name that starts with ip- for an AWS hostname", () => {
    expect(deviceDisplayName({ label: "Linux - ip-man", platform: "linux" })).toBe("ip-man");
    expect(deviceDisplayName({ label: "Linux - ip-172-31", platform: "linux" })).toBe("ip-172-31");
  });

  it("shows a named remote Mac by its real name and generated remote hosts by kind", () => {
    expect(deviceDisplayName({ label: "macOS - InterGalactic", platform: "darwin", is_remote: true })).toBe("InterGalactic");
    expect(deviceDisplayName({ label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true })).toBe("Cloud Linux");
    expect(deviceDisplayName({ label: "macOS - 36563bd2-ab96", platform: "darwin", is_remote: true })).toBe("Cloud Mac");
    expect(deviceDisplayName({ label: "macOS - 36563bd2-ab96-4045-8aec-894b84a2f66c.local", platform: "darwin", is_remote: true })).toBe("Cloud Mac");
    expect(deviceDisplayName({ label: "macOS - ip-172-31-29-242.us-east-2.compute.internal", platform: "darwin", is_remote: true })).toBe("Cloud Mac");
  });

  it("falls back to the raw label and handles a missing device", () => {
    expect(deviceDisplayName({ label: "macOS - ", platform: "darwin" })).toBe("macOS - ");
    expect(deviceDisplayName(null)).toBe("Unknown device");
  });
});

describe("isCloudAssignedHostname / isRemoteHost", () => {
  it("treats AWS ip-*, grok-bot-vm and htch-runtime hostnames as cloud boxes", () => {
    expect(isCloudAssignedHostname("Linux - grok-bot-vm-2307902")).toBe(true);
    expect(isCloudAssignedHostname("Linux - ip-172-31-40-243")).toBe(true);
    expect(isCloudAssignedHostname("macOS - ip-172-31-29-242.us-east-2.compute.internal")).toBe(true);
    expect(isCloudAssignedHostname("Linux - htch-runtime")).toBe(true);
    expect(isCloudAssignedHostname("Linux - htch-runtime-4f21")).toBe(true);
    expect(isCloudAssignedHostname("Linux - Anduril")).toBe(false);
    expect(isCloudAssignedHostname("macOS - MacBook-Pro-4.local")).toBe(false);
    expect(isCloudAssignedHostname("Linux - ip-man")).toBe(false);
  });

  it("counts a flagged remote and an unflagged cloud hostname as a remote host", () => {
    expect(isRemoteHost({ is_remote: true, label: "Mac-mini" })).toBe(true);
    expect(isRemoteHost({ is_remote: false, label: "Linux - grok-bot-vm-2307902" })).toBe(true);
    expect(isRemoteHost({ is_remote: false, label: "Linux - htch-runtime" })).toBe(true);
    expect(isRemoteHost({ is_remote: false, label: "Linux - Anduril" })).toBe(false);
    expect(isRemoteHost({ label: "MacBook" })).toBe(false);
  });
});

describe("deviceKindLabel", () => {
  it("does not read the win inside darwin as Windows", () => {
    expect(deviceKindLabel({ label: "", platform: "darwin" })).toBe("Mac");
    expect(deviceKindLabel({ label: "", platform: "win32" })).toBe("Windows");
    expect(deviceKindLabel({ label: "", platform: "linux", is_remote: true })).toBe("Remote");
  });
});

describe("compareMachineChips", () => {
  it("puts the machines you sit at before cloud-named hosts that never set is_remote", () => {
    const devices = [
      { label: "Linux - htch-runtime", platform: "linux", is_remote: false },
      { label: "Linux - grok-bot-vm-23079abc", platform: "linux", is_remote: false },
      { label: "macOS - MacBook-Pro.local", platform: "darwin", is_remote: false },
      { label: "Linux - ip-10-0-0-1", platform: "linux", is_remote: true },
    ];
    expect([...devices].sort(compareMachineChips).map(deviceDisplayName)).toEqual([
      "MacBook-Pro", "Cloud Linux", "grok-bot-vm-23079abc", "htch-runtime",
    ]);
  });

  it("orders same-named hosts live first, then the offline ones most recently seen first", () => {
    const host = (id: string, online: boolean, last_seen: number) => ({ id, label: "Linux - ip-10-0-0-1", platform: "linux", is_remote: true, online, last_seen });
    const devices = [host("dead-long", false, 1), host("asleep", false, 50), host("live", true, 10)];
    expect([...devices].sort(compareMachineChips).map((d) => d.id)).toEqual(["live", "asleep", "dead-long"]);
  });
});
