import { describe, expect, test } from "bun:test";
import { accountReach, devicesIntent } from "./accountPoolCommand";

// `cast accounts devices <profile>` with no machine named only reads. Run that
// way to see where an account ran, it once narrowed the account to its holder
// (2026-11-22).
describe("cast accounts devices", () => {
  test("naming no machine shows the reach and changes nothing", () => {
    expect(devicesIntent([], {})).toBe("show");
  });
  test("each change is spelled out", () => {
    expect(devicesIntent(["MacBook"], {})).toBe("narrow");
    expect(devicesIntent([], { all: true })).toBe("all");
    expect(devicesIntent([], { onlyHere: true })).toBe("only_here");
  });
  test("reach reads as the pool listing names it", () => {
    expect(accountReach({ device_ids: null })).toBe("all your machines");
    expect(accountReach({ device_ids: [] })).toBe("holder only");
    expect(accountReach({ device_ids: ["a", "b"] })).toBe("narrowed to 2 machine(s)");
    expect(accountReach({ team_id: "t1", device_ids: null })).toBe("");
  });
});
