import { describe, expect, it } from "bun:test";
import { dedupeProjectsByRepoName, defaultMachineId, pathOnMyMachines, type MachineCandidate } from "./machinePicker";

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

  it("prefers an online local that has the checkout over a more recent one that doesn't", () => {
    const devices = [
      dev("laptop", { last_seen: 9000 }),
      dev("desktop", { last_seen: 1000, local_project_roots: ["/Users/j/code/codecast"] }),
    ];
    expect(defaultMachineId(devices, { projectPath: "/Users/j/code/codecast" })).toBe("desktop");
  });

  it("falls back to the most-recently-seen online local when nobody has the checkout", () => {
    const devices = [dev("laptop", { last_seen: 9000 }), dev("desktop", { last_seen: 1000 })];
    expect(defaultMachineId(devices, { projectPath: "/Users/j/code/nowhere" })).toBe("laptop");
  });

  it("holds a sticky answer against heartbeat churn, but only within the candidate pool", () => {
    // Both online and idle: whichever heartbeated last would otherwise win, and
    // that flips every ~30s.
    const churned = [dev("laptop", { last_seen: 9000 }), dev("desktop", { last_seen: 8000 })];
    expect(defaultMachineId(churned, { sticky: "desktop" })).toBe("desktop");

    // A folder that only exists on the laptop still moves the highlight.
    const scoped = [
      dev("laptop", { last_seen: 9000, local_project_roots: ["/repo"] }),
      dev("desktop", { last_seen: 8000 }),
    ];
    expect(defaultMachineId(scoped, { sticky: "desktop", projectPath: "/repo" })).toBe("laptop");
  });

  it("ignores a sticky machine that went offline", () => {
    const devices = [dev("laptop"), dev("desktop", { online: false, last_seen: 9000 })];
    expect(defaultMachineId(devices, { sticky: "desktop" })).toBe("laptop");
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
    expect(defaultMachineId(devices, { projectPath: "/repo" })).toBe("laptop");
  });

  it("falls back to an online remote for a cloud-only user", () => {
    expect(defaultMachineId([dev("nose", { is_remote: true })])).toBe("nose");
  });

  it("is null with no devices at all", () => {
    expect(defaultMachineId([])).toBeNull();
  });
});

describe("dedupeProjectsByRepoName", () => {
  const p = (path: string) => ({ path });

  it("collapses the same repo name across machines to one entry", () => {
    const out = dedupeProjectsByRepoName([p("/Users/me/src/codecast"), p("/Users/m1/work/codecast"), p("/Users/me/src/app")]);
    expect(out.map((o) => o.path)).toEqual(["/Users/me/src/codecast", "/Users/me/src/app"]);
  });

  it("keeps the variant the routed machine can open", () => {
    const m1 = dev("m1", { local_project_roots: ["/Users/m1/work/codecast"] });
    const out = dedupeProjectsByRepoName([p("/Users/me/src/codecast"), p("/Users/m1/work/codecast")], m1);
    expect(out.map((o) => o.path)).toEqual(["/Users/m1/work/codecast"]);
  });

  it("keeps the current path over the routed machine's variant", () => {
    const m1 = dev("m1", { local_project_roots: ["/Users/m1/work/codecast"] });
    const out = dedupeProjectsByRepoName(
      [p("/Users/me/src/codecast"), p("/Users/m1/work/codecast")],
      m1,
      "/Users/me/src/codecast",
    );
    expect(out.map((o) => o.path)).toEqual(["/Users/me/src/codecast"]);
  });

  it("preserves rank order: the group stays where its best-ranked variant first appeared", () => {
    const out = dedupeProjectsByRepoName([p("/a/codecast"), p("/a/app"), p("/b/codecast")]);
    expect(out.map((o) => o.path)).toEqual(["/a/codecast", "/a/app"]);
  });

  it("returns the input array untouched when there are no duplicates", () => {
    const input = [p("/a/codecast"), p("/a/app")];
    expect(dedupeProjectsByRepoName(input)).toBe(input);
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
