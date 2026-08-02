import { describe, expect, it } from "bun:test";
import { defaultMachineId, pathOnMyMachines, resolveMachineSelection, type MachineCandidate } from "./machinePicker";

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

  // nose is registered is_remote:false with zero roots, so it competed for
  // /Users/... sessions it cannot cd into. Now that the default is STAMPED,
  // defaulting to it would pin the mistake instead of letting routing correct it.
  it("skips a local that provably can't open the path", () => {
    const devices = [
      dev("aaa-linux", { platform: "linux" }),
      dev("zzz-mac", { platform: "darwin" }),
    ];
    expect(defaultMachineId(devices, { projectPath: "/Users/j/.claude" })).toBe("zzz-mac");
    expect(defaultMachineId(devices, { projectPath: "/home/j/src" })).toBe("aaa-linux");
  });

  it("still picks someone when no machine can open the path", () => {
    const devices = [dev("aaa-linux", { platform: "linux" })];
    expect(defaultMachineId(devices, { projectPath: "/Users/j/.claude" })).toBe("aaa-linux");
  });

  it("leaves shared namespaces alone — /opt is not evidence either way", () => {
    const devices = [dev("aaa-linux", { platform: "linux" }), dev("zzz-mac", { platform: "darwin" })];
    expect(defaultMachineId(devices, { projectPath: "/opt/thing" })).toBe("aaa-linux");
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

describe("pathOnMyMachines", () => {
  const mine = [
    dev("laptop", { local_project_roots: ["/Users/me/src/codecast", "/Users/me/src/app"] }),
    dev("nose", { is_remote: true, local_project_roots: [] }),
  ];

  it("accepts a path one of my machines has, including repo subdirs", () => {
    expect(pathOnMyMachines(mine, "/Users/me/src/codecast")).toBe(true);
    expect(pathOnMyMachines(mine, "/Users/me/src/codecast/packages/web")).toBe(true);
  });

  it("rejects a teammate's checkout no machine of mine has", () => {
    expect(pathOnMyMachines(mine, "/Users/samvit/dev/codecast")).toBe(false);
  });

  it("does not filter before the roster loads or before any device reports roots", () => {
    expect(pathOnMyMachines([], "/Users/samvit/dev/codecast")).toBe(true);
    expect(pathOnMyMachines([dev("laptop", { local_project_roots: [] })], "/Users/samvit/dev/codecast")).toBe(true);
  });

  it("is false for an empty path", () => {
    expect(pathOnMyMachines(mine, undefined)).toBe(false);
    expect(pathOnMyMachines(mine, "")).toBe(false);
  });
});

describe("resolveMachineSelection", () => {
  const ROSTER = [
    dev("aaa-mac", { platform: "darwin", local_project_roots: ["/Users/j/a"] }),
    dev("zzz-mac2", { platform: "darwin", local_project_roots: ["/Users/j/b"] }),
  ];

  it("an explicit pick wins over the computed default", () => {
    const r = resolveMachineSelection(ROSTER, { picked: "zzz-mac2" });
    expect(r.selectedDeviceId).toBe("zzz-mac2");
  });

  it("falls back to the default when the user hasn't touched the picker", () => {
    expect(resolveMachineSelection(ROSTER, {}).selectedDeviceId).toBe("aaa-mac");
  });

  // BLOCKER 1. useDevices() starts empty, so the first render(s) resolve to null.
  // The caller must not write that through — an earlier mount's stamp would be
  // wiped and the session would quietly fall back to server-side routing.
  it("is null (not a machine) while the roster is still loading", () => {
    const r = resolveMachineSelection([], {});
    expect(r.selectedDeviceId).toBeNull();
    expect(r.stampDeviceId).toBeNull();
  });

  it("an explicit pick survives a roster that hasn't loaded", () => {
    expect(resolveMachineSelection([], { picked: "zzz-mac2" }).stampDeviceId).toBe("zzz-mac2");
  });

  // BLOCKER 2. The unscoped recents query is a union across ALL online locals.
  // Since the stamp wins rung 1 outright, offering that union would let a user
  // choose a folder the stamped machine cannot open. The folder list must be
  // scoped to exactly the machine being stamped — in every case, not just when
  // the user moved off the default.
  it("scopes the folder list to exactly the machine it stamps", () => {
    for (const opts of [
      {},
      { picked: "zzz-mac2" },
      { lastPicked: "zzz-mac2" },
      { ownerDeviceId: "zzz-mac2" },
      { projectPath: "/Users/j/b" },
      { picked: "aaa-mac", projectPath: "/Users/j/b" },
    ]) {
      const r = resolveMachineSelection(ROSTER, opts);
      expect(r.scopeProjectsToDeviceId).toBe(r.stampDeviceId);
    }
  });

  it("scopes to nothing while the roster is loading, rather than to the union", () => {
    expect(resolveMachineSelection([], {}).scopeProjectsToDeviceId).toBeNull();
  });
});
