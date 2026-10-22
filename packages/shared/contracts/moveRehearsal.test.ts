import { describe, expect, test } from "bun:test";
import { bringsByDefault, invalidBringPaths, rehearsalPending, type MoveRehearsal } from "./moveRehearsal";

const r: MoveRehearsal = {
  session_id: "s", destination_id: "d", at: 1, blockers: [], transfer: { method: "files" },
  missing: [{ path: "/Users/me/src/dailies", kind: "repo", writes: 7, uses: 167 }, { path: "/Users/me/src/eaiden", kind: "repo", writes: 0, uses: 11 }],
  services: [{ label: "sh.dailies.host", running: true }, { label: "sh.old", running: false }],
  tools: { missing: ["pnpm", "vid"], installs: ["pnpm"] },
  machine: ["macOS 26.2 here, macOS 15.7.3 on the host"],
};

describe("moveRehearsal", () => {
  test("what a person accepts: paths left behind, running services, commands the host will not get, machine differences", () => {
    expect(rehearsalPending(r, ["/Users/me/src/dailies"])).toEqual([
      "Leaves behind /Users/me/src/eaiden",
      "Keeps running here: sh.dailies.host",
      "Host lacks vid",
      "macOS 26.2 here, macOS 15.7.3 on the host",
    ]);
  });
  test("a path is brought by default when the session wrote there or leaned on it", () => {
    expect(r.missing.map(bringsByDefault)).toEqual([true, false]);
  });
  test("paths to bring are absolute and bounded", () => {
    expect(invalidBringPaths(["/a", "/b"])).toBeNull();
    expect(invalidBringPaths(["rel/x"])).toContain("absolute");
    expect(invalidBringPaths(["/a/../etc"])).toContain("absolute");
    expect(invalidBringPaths(Array(21).fill("/a"))).toContain("At most");
  });
});
