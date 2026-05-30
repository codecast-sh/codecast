import { describe, expect, test } from "bun:test";
import { pickOwnerDevice, type RoutableDevice } from "./deviceRouting";

const NOW = 1_000_000_000;
const fresh = NOW - 10_000; // seen 10s ago → online
const stale = NOW - 5 * 60 * 1000; // seen 5m ago → offline

const local = (id: string, over: Partial<RoutableDevice> = {}): RoutableDevice => ({
  device_id: id,
  last_seen: fresh,
  is_remote: false,
  local_project_roots: [],
  ...over,
});
const remote = (id: string, over: Partial<RoutableDevice> = {}): RoutableDevice => ({
  device_id: id,
  last_seen: fresh,
  is_remote: true,
  local_project_roots: [],
  ...over,
});

describe("pickOwnerDevice — the remote box is never auto-owned", () => {
  test("a lone online REMOTE device is not selected (returns null)", () => {
    // The exact bug: laptop asleep, only the remote Mac online. It must NOT be
    // stamped as owner — it has no checkout and would strand the message.
    expect(pickOwnerDevice([remote("r1")], { projectPath: "/Users/ashot/src/app" }, NOW)).toBeNull();
  });

  test("a remote is skipped even when it reports a matching project root", () => {
    // A remote whose roots happen to contain the path still must not auto-own;
    // only an explicit move (sticky owner) puts a session on the remote.
    const devices = [remote("r1", { local_project_roots: ["/Users/ashot/src/app"] })];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app" }, NOW)).toBeNull();
  });

  test("with a local + a remote online, the LOCAL device wins", () => {
    const devices = [remote("r1"), local("L1")];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app" }, NOW)).toBe("L1");
  });
});

describe("pickOwnerDevice — sticky ownership preserves an explicit move", () => {
  test("a remote that is already the owner stays the owner (move respected)", () => {
    const devices = [remote("r1"), local("L1")];
    const r = pickOwnerDevice(devices, { projectPath: "/Users/m1/work/app", ownerDeviceId: "r1" }, NOW);
    expect(r).toBe("r1");
  });

  test("a sticky local owner stays the owner over a more-recent peer", () => {
    const devices = [local("L1", { last_seen: NOW - 60_000 }), local("L2", { last_seen: fresh })];
    const r = pickOwnerDevice(devices, { projectPath: "/x", ownerDeviceId: "L1" }, NOW);
    expect(r).toBe("L1");
  });

  test("an OFFLINE sticky owner is dropped and routing re-resolves to a local", () => {
    const devices = [local("L1", { last_seen: stale }), local("L2", { last_seen: fresh })];
    const r = pickOwnerDevice(devices, { projectPath: "/x", ownerDeviceId: "L1" }, NOW);
    expect(r).toBe("L2");
  });

  test("an offline remote sticky owner falls back to the online local", () => {
    const devices = [remote("r1", { last_seen: stale }), local("L1")];
    const r = pickOwnerDevice(devices, { projectPath: "/x", ownerDeviceId: "r1" }, NOW);
    expect(r).toBe("L1");
  });
});

describe("pickOwnerDevice — checkout match beats recency among locals", () => {
  test("the local that has the checkout wins even if seen less recently", () => {
    const devices = [
      local("L1", { last_seen: NOW - 90_000, local_project_roots: ["/Users/ashot/src/app"] }),
      local("L2", { last_seen: fresh, local_project_roots: ["/Users/ashot/src/other"] }),
    ];
    const r = pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app/packages/web" }, NOW);
    expect(r).toBe("L1");
  });

  test("ties on checkout-match are broken by most-recently-seen", () => {
    const devices = [
      local("L1", { last_seen: NOW - 90_000, local_project_roots: ["/Users/ashot/src/app"] }),
      local("L2", { last_seen: fresh, local_project_roots: ["/Users/ashot/src/app"] }),
    ];
    const r = pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app" }, NOW);
    expect(r).toBe("L2");
  });
});

describe("pickOwnerDevice — most-recently-active local (the mobile rule)", () => {
  test("no checkout hint → most-recently-active local laptop/desktop", () => {
    const devices = [
      local("L1", { last_seen: NOW - 120_000 }),
      local("L2", { last_seen: NOW - 5_000 }),
      remote("r1", { last_seen: NOW - 1_000 }), // most recent overall, but ineligible
    ];
    expect(pickOwnerDevice(devices, {}, NOW)).toBe("L2");
  });

  test("no devices online → null (broadcast / no target)", () => {
    const devices = [local("L1", { last_seen: stale }), remote("r1", { last_seen: stale })];
    expect(pickOwnerDevice(devices, { projectPath: "/x" }, NOW)).toBeNull();
  });

  test("no online LOCAL device (only remote online) → null, never the remote", () => {
    const devices = [local("L1", { last_seen: stale }), remote("r1", { last_seen: fresh })];
    expect(pickOwnerDevice(devices, { projectPath: "/x" }, NOW)).toBeNull();
  });
});
