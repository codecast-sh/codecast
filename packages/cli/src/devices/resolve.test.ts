import { describe, expect, test } from "bun:test";
import { matchDevices, pickDevice } from "./resolve";

const roster = [
  { device_id: "9ab211680798bb4d", label: "Union AWS 128GB", hostname: "union-shared", platform: "linux", online: true },
  { device_id: "0c621d6e4176bed7", label: "macOS - Mac-mini", hostname: "Mac-mini", platform: "darwin", online: true },
  { device_id: "6ebf36a73ebbd46f", label: "macOS - Mac-mini 2", hostname: "Mac-mini", platform: "darwin", online: false },
  { device_id: "28d80e225ed21f45", label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true, online: true },
];

describe("naming a machine", () => {
  test("an id prefix, a label or a hostname fragment each name one machine", () => {
    expect(matchDevices(roster, "9ab2").map((d) => d.device_id)).toEqual(["9ab211680798bb4d"]);
    expect(matchDevices(roster, "union aws").map((d) => d.device_id)).toEqual(["9ab211680798bb4d"]);
    expect(matchDevices(roster, "union-shared").map((d) => d.device_id)).toEqual(["9ab211680798bb4d"]);
    expect(matchDevices(roster, "cloud").map((d) => d.device_id)).toEqual(["28d80e225ed21f45"]);
  });

  test("an exact label wins over a longer label that contains it", () => {
    expect(matchDevices(roster, "macOS - Mac-mini").map((d) => d.device_id)).toEqual(["0c621d6e4176bed7"]);
  });

  test("an ambiguous name lists the candidates instead of guessing", () => {
    const r = pickDevice(roster, "mac-mini");
    expect("error" in r && r.error.split("\n")).toEqual([
      'device "mac-mini" matches 2 machines; be more specific:',
      "  0c621d6e  Mac-mini",
      "  6ebf36a7  Mac-mini 2  offline",
    ]);
  });
});
