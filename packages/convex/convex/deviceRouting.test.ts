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

describe("pickOwnerDevice — a remote without the checkout is never auto-owned over a local", () => {
  test("laptop asleep, only the remote Mac online → the OFFLINE laptop, not the remote", () => {
    // The exact bug: a blank iOS session while the laptop sleeps must queue for
    // the laptop (it wakes and serves), never land on the remote's $HOME.
    const devices = [local("L1", { last_seen: stale }), remote("r1")];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app" }, NOW)).toBe("L1");
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

  test("no devices online → the most-recently-seen local (queue until it wakes)", () => {
    const devices = [
      local("L1", { last_seen: stale }),
      local("L2", { last_seen: stale - 60_000 }),
      remote("r1", { last_seen: stale }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/x" }, NOW)).toBe("L1");
  });

  test("no local online but conversation has a sticky LOCAL owner → keep the owner", () => {
    // Don't ping-pong an existing conversation between sleeping Macs: the one it
    // already lives on serves it when it wakes.
    const devices = [
      local("L1", { last_seen: stale - 60_000 }),
      local("L2", { last_seen: stale }), // seen more recently, but not the owner
      remote("r1", { last_seen: fresh }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/x", ownerDeviceId: "L1" }, NOW)).toBe("L1");
  });
});

describe("pickOwnerDevice — an explicit pick outranks the heuristics", () => {
  test("an online local target wins over a more-recent peer and the sticky owner", () => {
    const devices = [
      local("L1", { last_seen: NOW - 90_000, local_project_roots: ["/x"] }),
      local("L2", { last_seen: fresh }),
    ];
    const r = pickOwnerDevice(
      devices,
      { projectPath: "/x", ownerDeviceId: "L2", targetDeviceId: "L1" },
      NOW,
    );
    expect(r).toBe("L1");
  });

  test("an online REMOTE target wins even with a local online and no matching root", () => {
    // Picking a machine by hand is the explicit consent the invariant asks for.
    const devices = [local("L1"), remote("r1")];
    const r = pickOwnerDevice(devices, { projectPath: "/x", targetDeviceId: "r1" }, NOW);
    expect(r).toBe("r1");
  });

  test("an OFFLINE target falls back to a live machine that HAS the checkout", () => {
    const devices = [
      local("L1", { last_seen: stale, local_project_roots: ["/x"] }),
      local("L2", { last_seen: fresh, local_project_roots: ["/x"] }),
    ];
    const r = pickOwnerDevice(devices, { projectPath: "/x", targetDeviceId: "L1" }, NOW);
    expect(r).toBe("L2");
  });

  test("an OFFLINE target with a checkout-holding remote online → the remote, not a bare local", () => {
    const devices = [
      local("L1", { last_seen: stale, local_project_roots: ["/x"] }),
      local("L2", { last_seen: fresh }), // online but no checkout — would strand /x
      remote("r1", { local_project_roots: ["/x"] }),
    ];
    const r = pickOwnerDevice(devices, { projectPath: "/x", targetDeviceId: "L1" }, NOW);
    expect(r).toBe("r1");
  });

  test("an OFFLINE target that no live machine can substitute for QUEUES for the target", () => {
    // The picker scoped the folder list to L1's roots; L2 doesn't have /x, so
    // routing there would strand the session in a directory it can't open.
    const devices = [
      local("L1", { last_seen: stale, local_project_roots: ["/x"] }),
      local("L2", { last_seen: fresh, local_project_roots: ["/y"] }),
    ];
    const r = pickOwnerDevice(devices, { projectPath: "/x", targetDeviceId: "L1" }, NOW);
    expect(r).toBe("L1");
  });

  test("a live checkout holder beats queueing, LOCAL preferred over remote", () => {
    const devices = [
      local("L1", { last_seen: stale, local_project_roots: ["/x"] }),
      local("L2", { last_seen: fresh, local_project_roots: ["/x"] }),
      remote("r1", { local_project_roots: ["/x"] }),
    ];
    const r = pickOwnerDevice(devices, { projectPath: "/x", targetDeviceId: "L1" }, NOW);
    expect(r).toBe("L2");
  });

  test("an OFFLINE target with NO path hint queues for the target", () => {
    const devices = [local("L1", { last_seen: stale }), local("L2", { last_seen: fresh })];
    expect(pickOwnerDevice(devices, { targetDeviceId: "L1" }, NOW)).toBe("L1");
  });

  test("an unknown target device id is ignored", () => {
    const devices = [local("L1")];
    expect(pickOwnerDevice(devices, { projectPath: "/x", targetDeviceId: "ghost" }, NOW)).toBe("L1");
  });
});

describe("pickOwnerDevice — an online remote with the checkout beats a sleeping local", () => {
  test("no local online + remote holds the checkout → the remote serves now", () => {
    const devices = [
      local("L1", { last_seen: stale }),
      remote("r1", { local_project_roots: ["/Users/ashot/src/app"] }),
    ];
    const r = pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app/packages/web" }, NOW);
    expect(r).toBe("r1");
  });

  test("the remote's root must actually match — otherwise queue for the local", () => {
    const devices = [
      local("L1", { last_seen: stale }),
      remote("r1", { local_project_roots: ["/Users/ashot/src/other"] }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app" }, NOW)).toBe("L1");
  });

  test("no path hint → no root match is possible, so the sleeping local still wins", () => {
    const devices = [
      local("L1", { last_seen: stale }),
      remote("r1", { local_project_roots: ["/Users/ashot/src/app"] }),
    ];
    expect(pickOwnerDevice(devices, {}, NOW)).toBe("L1");
  });

  test("a local is online → the rung never fires, even though the remote has the checkout", () => {
    const devices = [
      local("L1", { local_project_roots: [] }),
      remote("r1", { local_project_roots: ["/Users/ashot/src/app"] }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app" }, NOW)).toBe("L1");
  });

  test("an OFFLINE remote with the checkout loses to the sleeping local", () => {
    const devices = [
      local("L1", { last_seen: stale }),
      remote("r1", { last_seen: stale, local_project_roots: ["/Users/ashot/src/app"] }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/ashot/src/app" }, NOW)).toBe("L1");
  });
});

describe("pickOwnerDevice — cloud-only fallback (no local device exists)", () => {
  test("no local devices at all → an online remote serves", () => {
    expect(pickOwnerDevice([remote("r1")], { projectPath: "/x" }, NOW)).toBe("r1");
  });

  test("no local devices and the remote is offline too → null (broadcast)", () => {
    expect(pickOwnerDevice([remote("r1", { last_seen: stale })], { projectPath: "/x" }, NOW)).toBeNull();
  });

  test("no devices at all → null", () => {
    expect(pickOwnerDevice([], {}, NOW)).toBeNull();
  });
});

describe("pickOwnerDevice — a machine that can't open the path doesn't win on recency", () => {
  // The real roster this came from: a Linux box registered is_remote:false with
  // zero project roots, heartbeating within seconds of the Mac. Rung 4 sorted on
  // last_seen alone, so a /Users/... session could land on a machine with no
  // /Users at all — roughly a coin flip, re-tossed every heartbeat.
  test("Linux box heartbeat more recently, but the path is /Users/... → the Mac", () => {
    const devices = [
      local("nose", { platform: "linux", last_seen: NOW - 1_000 }),
      local("mac", { platform: "darwin", last_seen: NOW - 30_000 }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/jasonbenn/.claude" }, NOW)).toBe("mac");
  });

  test("and symmetrically, a /home/... path skips the Mac", () => {
    const devices = [
      local("mac", { platform: "darwin", last_seen: NOW - 1_000 }),
      local("nose", { platform: "linux", last_seen: NOW - 30_000 }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/home/jasonbenn/src" }, NOW)).toBe("nose");
  });

  test("a shared namespace is not evidence — /opt still goes to the most recent", () => {
    const devices = [
      local("nose", { platform: "linux", last_seen: NOW - 1_000 }),
      local("mac", { platform: "darwin", last_seen: NOW - 30_000 }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/opt/shared" }, NOW)).toBe("nose");
  });

  test("preference, not a filter: nobody can open it → still owned, never null", () => {
    const devices = [local("nose", { platform: "linux", last_seen: NOW - 1_000 })];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/jasonbenn/.claude" }, NOW)).toBe("nose");
  });

  test("devices with no platform reported are never excluded", () => {
    const devices = [local("unknown", { last_seen: NOW - 1_000 }), local("mac", { platform: "darwin" })];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/j/app" }, NOW)).toBe("unknown");
  });

  test("the offline-queue rung applies it too — don't queue for a machine that can't serve", () => {
    const devices = [
      local("nose", { platform: "linux", last_seen: stale }),
      local("mac", { platform: "darwin", last_seen: stale - 60_000 }),
    ];
    expect(pickOwnerDevice(devices, { projectPath: "/Users/jasonbenn/.claude" }, NOW)).toBe("mac");
  });

  test("an explicit pick still outranks it — you may target a box deliberately", () => {
    const devices = [
      local("nose", { platform: "linux" }),
      local("mac", { platform: "darwin" }),
    ];
    expect(
      pickOwnerDevice(devices, { projectPath: "/Users/jasonbenn/.claude", targetDeviceId: "nose" }, NOW),
    ).toBe("nose");
  });
});
