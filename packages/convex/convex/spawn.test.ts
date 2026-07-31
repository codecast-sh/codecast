import { describe, expect, test } from "bun:test";
import { resolveDeviceSelector } from "./spawn";

const devices = [
  { device_id: "dev-laptop-1", label: "Nose" },
  { device_id: "dev-remote-2", label: "mac mini" },
  { device_id: "dev-bare-3" },
];

describe("resolveDeviceSelector — cast spawn --device", () => {
  test("matches a device_id exactly", () => {
    expect(resolveDeviceSelector(devices, "dev-remote-2")).toBe("dev-remote-2");
  });

  test("matches a label case-insensitively", () => {
    expect(resolveDeviceSelector(devices, "nose")).toBe("dev-laptop-1");
    expect(resolveDeviceSelector(devices, "Mac Mini")).toBe("dev-remote-2");
  });

  test("a device_id wins over another machine's identical label", () => {
    const shadowed = [
      { device_id: "dev-bare-3", label: "workhorse" },
      { device_id: "dev-laptop-1", label: "dev-bare-3" },
    ];
    expect(resolveDeviceSelector(shadowed, "dev-bare-3")).toBe("dev-bare-3");
  });

  test("unknown value throws and names the devices the user has", () => {
    expect(() => resolveDeviceSelector(devices, "noze")).toThrow(
      'Unknown device "noze". Your devices: Nose, mac mini, dev-bare-3',
    );
  });

  test("no registered devices still gives an actionable message", () => {
    expect(() => resolveDeviceSelector([], "nose")).toThrow("(none registered)");
  });
});
