import { describe, expect, test } from "bun:test";
import { matchDevices } from "./pickDevice.js";

const devices = [
  { device_id: "b556d7280eed856e", label: "macOS - pegasus", hostname: "pegasus.local" },
  { device_id: "8762290f88313860", label: "Linux - popcorn", hostname: "popcorn" },
  { device_id: "c0ffee0000000001", label: "cloud-1", hostname: "ip-10-0-0-1", is_remote: true },
];

describe("matchDevices", () => {
  test("matches a device id prefix, a label substring or a hostname, ignoring case", () => {
    expect(matchDevices(devices, "8762").map((d) => d.label)).toEqual(["Linux - popcorn"]);
    expect(matchDevices(devices, "PEGASUS").map((d) => d.device_id)).toEqual(["b556d7280eed856e"]);
    expect(matchDevices(devices, "ip-10").map((d) => d.label)).toEqual(["cloud-1"]);
  });

  test("`cloud` names every cloud host", () => {
    expect(matchDevices(devices, "cloud").map((d) => d.device_id)).toEqual(["c0ffee0000000001"]);
  });

  test("an exact label or hostname beats a longer one that contains it", () => {
    const pair = [
      { device_id: "aa", label: "mac" },
      { device_id: "bb", label: "macbook" },
    ];
    expect(matchDevices(pair, "mac").map((d) => d.device_id)).toEqual(["aa"]);
    expect(matchDevices(pair, "mac").length).toBe(1);
  });

  test("an ambiguous or unknown needle returns every match, or none", () => {
    expect(matchDevices(devices, "o").length).toBeGreaterThan(1);
    expect(matchDevices(devices, "nonesuch")).toEqual([]);
  });
});
