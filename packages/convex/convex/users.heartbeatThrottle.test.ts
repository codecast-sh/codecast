// The daemon beats every 30s and the device upsert wrote `last_seen: now`
// unconditionally, so every beat re-ran every listDevices and routing
// subscription in the fleet. The upsert now skips a beat that carries nothing
// new while last_seen is still fresh, which puts the whole throttle on this
// comparison: a false "unchanged" here silently drops a real device update.
import { describe, expect, test } from "bun:test";
import { deviceBeatChanged, sameHeartbeatValue } from "./users";

describe("sameHeartbeatValue", () => {
  test("equal primitives match, different ones do not", () => {
    expect(sameHeartbeatValue("darwin", "darwin")).toBe(true);
    expect(sameHeartbeatValue("online", "offline")).toBe(false);
    expect(sameHeartbeatValue(5, 5)).toBe(true);
    expect(sameHeartbeatValue(true, false)).toBe(false);
  });

  test("a field absent on both sides is not a change", () => {
    expect(sameHeartbeatValue(undefined, undefined)).toBe(true);
  });

  test("a field the row has never held is a change, so it writes through", () => {
    expect(sameHeartbeatValue(undefined, "macOS - Ashots-MacBook")).toBe(false);
    expect(sameHeartbeatValue(undefined, [])).toBe(false);
    expect(sameHeartbeatValue("linux", undefined)).toBe(false);
  });

  test("arrays match on content, not identity (local_project_roots is rebuilt each beat)", () => {
    expect(sameHeartbeatValue(["/a", "/b"], ["/a", "/b"])).toBe(true);
    expect(sameHeartbeatValue(["/a", "/b"], ["/b", "/a"])).toBe(false);
    expect(sameHeartbeatValue(["/a"], ["/a", "/b"])).toBe(false);
  });

  test("records match on content (settings, git_plane)", () => {
    expect(sameHeartbeatValue({ stable: "team" }, { stable: "team" })).toBe(true);
    expect(sameHeartbeatValue({ stable: "team" }, { stable: "solo" })).toBe(false);
  });

  test("a nested change is still a change (cc_accounts usage)", () => {
    const before = { accounts: [{ id: "a", usage: { five_hour: 12 } }] };
    const after = { accounts: [{ id: "a", usage: { five_hour: 31 } }] };
    expect(sameHeartbeatValue(before, structuredClone(before))).toBe(true);
    expect(sameHeartbeatValue(before, after)).toBe(false);
  });
});

describe("deviceBeatChanged", () => {
  const NOW = 1_700_000_000_000;
  const existing = {
    platform: "darwin",
    status: "online",
    last_seen: NOW - 30_000,
    last_input_at: NOW - 600_000,
    local_project_roots: ["/Users/ashot/src"],
    settings: { stable: "team" },
  };
  // What a quiet beat 30s later looks like: same everything, a fresh last_seen,
  // and a last_input_at re-derived from the same real keystroke.
  const quietBeat = {
    platform: "darwin",
    status: "online" as const,
    last_seen: NOW,
    last_input_at: NOW - 600_400,
    local_project_roots: ["/Users/ashot/src"],
    settings: { stable: "team" },
  };

  test("a beat that says nothing new is not a change (this is what the throttle skips)", () => {
    expect(deviceBeatChanged(existing, quietBeat)).toBe(false);
  });

  test("a fresh last_seen alone is never the reason to write", () => {
    expect(deviceBeatChanged(existing, { last_seen: NOW })).toBe(false);
  });

  test("measurement drift on last_input_at does not count as input", () => {
    expect(deviceBeatChanged(existing, { last_input_at: NOW - 601_000 })).toBe(false);
    expect(deviceBeatChanged(existing, { last_input_at: NOW - 599_000 })).toBe(false);
  });

  test("real input writes through on this beat, so presence is not delayed", () => {
    expect(deviceBeatChanged(existing, { last_input_at: NOW - 2_000 })).toBe(true);
  });

  test("a device reporting input for the first time writes through", () => {
    expect(deviceBeatChanged({ ...existing, last_input_at: undefined }, { last_input_at: NOW })).toBe(true);
  });

  test("any other field the beat carries writes through", () => {
    expect(deviceBeatChanged(existing, { ...quietBeat, status: "offline" })).toBe(true);
    expect(deviceBeatChanged(existing, { ...quietBeat, settings: { stable: "solo" } })).toBe(true);
    expect(deviceBeatChanged(existing, { ...quietBeat, local_project_roots: ["/Users/ashot/src", "/tmp"] })).toBe(true);
    expect(deviceBeatChanged(existing, { ...quietBeat, loop_freeze_ms: 12_000 })).toBe(true);
  });
});
