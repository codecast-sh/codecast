import { describe, expect, it } from "bun:test";
import { deviceDisplayName, deviceKindLabel } from "./deviceName";

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

  it("names remote boxes by class", () => {
    expect(deviceDisplayName({ label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true })).toBe("Cloud Linux");
    expect(deviceDisplayName({ label: "macOS - 36563bd2-ab96", platform: "darwin", is_remote: true })).toBe("Remote Mac");
  });

  it("falls back to the raw label and handles a missing device", () => {
    expect(deviceDisplayName({ label: "macOS - ", platform: "darwin" })).toBe("macOS - ");
    expect(deviceDisplayName(null)).toBe("Unknown device");
  });
});

describe("deviceKindLabel", () => {
  it("does not read the win inside darwin as Windows", () => {
    expect(deviceKindLabel({ label: "", platform: "darwin" })).toBe("Mac");
    expect(deviceKindLabel({ label: "", platform: "win32" })).toBe("Windows");
    expect(deviceKindLabel({ label: "", platform: "linux", is_remote: true })).toBe("Remote");
  });
});
