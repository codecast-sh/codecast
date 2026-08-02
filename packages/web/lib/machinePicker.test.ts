import { describe, expect, it } from "bun:test";
import { defaultMachineId, type MachineCandidate } from "./machinePicker";

const dev = (id: string, over: Partial<MachineCandidate> = {}): MachineCandidate => ({
  device_id: id,
  is_remote: false,
  online: true,
  last_seen: 1000,
  ...over,
});

describe("defaultMachineId", () => {
  it("prefers the conversation's owner while it's online", () => {
    const devices = [dev("laptop", { last_seen: 5000 }), dev("desktop")];
    expect(defaultMachineId(devices, { ownerDeviceId: "desktop" })).toBe("desktop");
  });

  it("routes past an owner that went offline", () => {
    const devices = [dev("laptop"), dev("desktop", { online: false })];
    expect(defaultMachineId(devices, { ownerDeviceId: "desktop" })).toBe("laptop");
  });

  it("falls through when the owner device is no longer in the list", () => {
    expect(defaultMachineId([dev("laptop")], { ownerDeviceId: "gone" })).toBe("laptop");
  });

  it("opens on the machine you last picked", () => {
    const devices = [dev("laptop"), dev("desktop")];
    expect(defaultMachineId(devices, { lastPicked: "desktop" })).toBe("desktop");
  });

  it("does not let a standing pick move a session that already has an owner", () => {
    // The pick is stamped now, so honouring lastPicked here would re-point an
    // existing session onto another machine just by opening it.
    const devices = [dev("laptop"), dev("desktop")];
    expect(defaultMachineId(devices, { lastPicked: "desktop", ownerDeviceId: "laptop" })).toBe("laptop");
  });

  it("ignores a standing pick whose machine is offline or gone", () => {
    expect(defaultMachineId([dev("laptop"), dev("desktop", { online: false })], { lastPicked: "desktop" })).toBe("laptop");
    expect(defaultMachineId([dev("laptop")], { lastPicked: "retired" })).toBe("laptop");
  });

  it("prefers an online local that has the checkout over one that doesn't", () => {
    const devices = [
      dev("laptop", { last_seen: 9000 }),
      dev("desktop", { last_seen: 1000, local_project_roots: ["/Users/j/code/codecast"] }),
    ];
    expect(defaultMachineId(devices, { projectPath: "/Users/j/code/codecast" })).toBe("desktop");
  });

  it("matches a checkout by prefix, so a repo subdir still finds its machine", () => {
    const devices = [dev("laptop"), dev("desktop", { local_project_roots: ["/Users/j/code/app"] })];
    expect(defaultMachineId(devices, { projectPath: "/Users/j/code/app/packages/web" })).toBe("desktop");
    // …but not a sibling that merely shares a prefix string: nobody has that
    // checkout, so it falls to the stable tiebreak across all online locals.
    expect(defaultMachineId(devices, { projectPath: "/Users/j/code/app-other" })).toBe("desktop");
  });

  // THE REGRESSION this ladder exists to prevent. Two idle online locals
  // re-heartbeat every ~30s; the old tiebreak was `last_seen`, so the answer
  // flipped between the render that showed a chip and the send that acted on it.
  it("is stable against heartbeat churn — last_seen never decides", () => {
    const a = [dev("laptop", { last_seen: 9000 }), dev("desktop", { last_seen: 8000 })];
    const b = [dev("laptop", { last_seen: 8000 }), dev("desktop", { last_seen: 9000 })];
    expect(defaultMachineId(a)).toBe(defaultMachineId(b));
  });

  it("is stable against roster reordering", () => {
    const devices = [dev("laptop"), dev("desktop"), dev("studio")];
    expect(defaultMachineId(devices)).toBe(defaultMachineId([...devices].reverse()));
  });

  it("never auto-selects an online remote while a local is online", () => {
    const devices = [dev("aaa-nose", { is_remote: true, local_project_roots: ["/repo"] }), dev("zzz-laptop")];
    expect(defaultMachineId(devices, { projectPath: "/repo" })).toBe("zzz-laptop");
  });

  it("uses an online remote holding the checkout when no local is online", () => {
    const devices = [
      dev("laptop", { online: false }),
      dev("nose", { is_remote: true, local_project_roots: ["/repo"] }),
    ];
    expect(defaultMachineId(devices, { projectPath: "/repo" })).toBe("nose");
  });

  it("otherwise queues for a local machine even though none is online", () => {
    const devices = [
      dev("laptop", { online: false, last_seen: 9000 }),
      dev("desktop", { online: false, last_seen: 1000 }),
      dev("nose", { is_remote: true }),
    ];
    expect(defaultMachineId(devices, { projectPath: "/repo" })).toBe("desktop");
  });

  it("falls back to an online remote for a cloud-only user", () => {
    expect(defaultMachineId([dev("nose", { is_remote: true })])).toBe("nose");
  });

  it("is null with no devices at all", () => {
    expect(defaultMachineId([])).toBeNull();
  });
});
