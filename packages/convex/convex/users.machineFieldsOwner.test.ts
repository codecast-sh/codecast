// The per-machine sticky fields on the user doc (cli_version, daemon_pid,
// autostart_enabled, has_tmux, local_project_roots) used to be overwritten by
// EVERY daemon's heartbeat, so a user with two machines online saw them flip
// on each beat — and every user-doc subscriber on the web re-rendered each
// time. One daemon owns them until it goes quiet.
import { describe, expect, test } from "bun:test";
import { DAEMON_FIELDS_OWNER_STALE_MS, resolveMachineFieldsOwner } from "./users";

const now = 1_000_000_000;

describe("resolveMachineFieldsOwner", () => {
  test("a device-less beat defers to a live identified owner", () => {
    expect(resolveMachineFieldsOwner({ deviceId: undefined, owner: "m1", ownerLastSeen: now, now }))
      .toEqual({ owns: false, claim: false });
  });
  test("a device-less beat writes (without claiming) when nobody owns the fields", () => {
    expect(resolveMachineFieldsOwner({ deviceId: undefined, owner: undefined, ownerLastSeen: undefined, now }))
      .toEqual({ owns: true, claim: false });
    expect(resolveMachineFieldsOwner({ deviceId: undefined, owner: "m1", ownerLastSeen: now - DAEMON_FIELDS_OWNER_STALE_MS - 1, now }))
      .toEqual({ owns: true, claim: false });
  });
  test("first identified daemon claims ownership", () => {
    expect(resolveMachineFieldsOwner({ deviceId: "m1", owner: undefined, ownerLastSeen: undefined, now }))
      .toEqual({ owns: true, claim: true });
  });
  test("owner keeps writing without re-claiming", () => {
    expect(resolveMachineFieldsOwner({ deviceId: "m1", owner: "m1", ownerLastSeen: now, now }))
      .toEqual({ owns: true, claim: false });
  });
  test("a second online machine does not write while the owner is alive", () => {
    expect(resolveMachineFieldsOwner({ deviceId: "m2", owner: "m1", ownerLastSeen: now - 30_000, now }))
      .toEqual({ owns: false, claim: false });
  });
  test("a second machine takes over once the owner's device row goes stale", () => {
    expect(resolveMachineFieldsOwner({ deviceId: "m2", owner: "m1", ownerLastSeen: now - DAEMON_FIELDS_OWNER_STALE_MS - 1, now }))
      .toEqual({ owns: true, claim: true });
  });
  test("an owner with no device row at all is treated as gone", () => {
    expect(resolveMachineFieldsOwner({ deviceId: "m2", owner: "m1", ownerLastSeen: undefined, now }))
      .toEqual({ owns: true, claim: true });
  });
});
