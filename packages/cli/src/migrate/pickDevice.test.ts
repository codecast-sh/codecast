import { describe, expect, test } from "bun:test";
import { matchDevices, teammateMachineLine } from "./pickDevice.js";

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

  test("a name a person set matches on its own", () => {
    const named = devices.map((d) => d.device_id === "c0ffee0000000001" ? { ...d, display_name: "Work box" } : d);
    expect(matchDevices(named, "work box").map((d) => d.device_id)).toEqual(["c0ffee0000000001"]);
    expect(matchDevices(named, "Work").map((d) => d.device_id)).toEqual(["c0ffee0000000001"]);
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

describe("naming a teammate's own other Mac (cast trigger add --device)", () => {
  // Alexander's roster on 2026-11-06: a Mac Studio that holds the work
  // checkouts and two MacBooks.
  const roster = [
    { device_id: "c5900012d741", label: "macOS - Alexanders-Mac-Studio", hostname: "Alexanders-Mac-Studio" },
    { device_id: "65f260200e20", label: "macOS - Alexanders-MacBook-Pro-4", hostname: "Alexanders-MacBook-Pro-4" },
    { device_id: "4e2cfe0d258f", label: "macOS - Alexanders-MacBook-Pro", hostname: "Alexanders-MacBook-Pro" },
  ];

  test("a short name reaches the Studio alone", () => {
    expect(matchDevices(roster, "studio").map((d) => d.device_id)).toEqual(["c5900012d741"]);
    expect(matchDevices(roster, "c590").map((d) => d.device_id)).toEqual(["c5900012d741"]);
  });

  test("an exact hostname wins over the longer one it prefixes", () => {
    expect(matchDevices(roster, "Alexanders-MacBook-Pro").map((d) => d.device_id)).toEqual(["4e2cfe0d258f"]);
    expect(matchDevices(roster, "macbook")).toHaveLength(2);
  });
});

describe("a teammate's machine named where yours is expected", () => {
  const team = [
    { device_id: "aaaa1111", label: "cam-mini", runner_name: "Cam", is_bot: false },
    { device_id: "bbbb2222", label: "union-box-1", runner_name: "union-bot", bot_name: "union-bot", is_bot: true },
  ];
  test("says whose machine it is", () => {
    expect(teammateMachineLine(team, "cam-mini", "--to")).toBe(`--to "cam-mini" is Cam's machine, cam-mini, not one of yours: --to takes a machine of yours (cast devices ls)`);
    expect(teammateMachineLine(team, "union-box", "--device")).toContain("is a team agent box (union-bot), union-box-1");
  });
  test("names nothing when no team machine matches, or several do", () => {
    expect(teammateMachineLine(team, "nowhere", "--to")).toBeNull();
    expect(teammateMachineLine(team, "i", "--to")).toBeNull();
  });
});
