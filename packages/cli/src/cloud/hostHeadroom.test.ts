import { expect, test } from "bun:test";
import { chooseCloudHost, headroomFromProbe, sizeFor, tooSmallFor, type Headroom, type HostChoiceDeps } from "./hostHeadroom";
import type { CloudHost } from "../browser/cloudHost";

const linux = (avail: number, swapTotal: number, swapFree: number, fullAvg60 = 0.5) =>
  `Linux\n---\nMemTotal: 3924688 kB\nMemAvailable: ${avail} kB\nSwapTotal: ${swapTotal} kB\nSwapFree: ${swapFree} kB\n---\nsome avg10=1.68 avg60=1.41 avg300=2.45 total=1\nfull avg10=1.23 avg60=${fullAvg60} avg300=1.82 total=1\n`;
const mac = (level: number) =>
  `Darwin\n---\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 2000000.\nPages inactive: 400000.\nPages speculative: 1000.\nPages occupied by compressor: 0.\n---\nvm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\nkern.memorystatus_vm_pressure_level: ${level}\nhw.memsize: 51539607552\n`;

test("a t3.medium with its swap full has no room, though 2 GB reads as available", () => {
  // The ubuntu host on 2026-10-14, minutes after five OOM kills.
  expect(headroomFromProbe(linux(2014028, 2097148, 123712))).toEqual({ fit: false, why: "swap 1.9 of 2.0 GB used", memoryAvailable: 2014028 * 1024, memoryTotal: 3924688 * 1024 });
});

test("memory stalls and low free memory each refuse; a calm host has room", () => {
  expect(headroomFromProbe(linux(3_000_000, 2097148, 2_000_000, 12)).why).toBe("memory pressure critical");
  expect(headroomFromProbe(linux(500_000, 0, 0)).why).toBe("0.5 GB of memory free");
  expect(headroomFromProbe(linux(3_000_000, 2097148, 2_000_000)).fit).toBe(true);
  expect(headroomFromProbe(mac(1)).fit).toBe(true);
  expect(headroomFromProbe(mac(4)).why).toBe("memory pressure critical");
});

const host = (id: string, extra: Partial<CloudHost> = {}): CloudHost => ({ id, provider: "aws", region: "r", user: "u", keyPath: "k", address: "1.2.3.4", deviceId: `dev-${id}`, ...extra });

function deps(hosts: CloudHost[], rooms: Record<string, Headroom>, asleep: string[] = []): HostChoiceDeps & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    resolve: (arg) => hosts.find((h) => h.id === arg) ?? hosts[0],
    hosts: () => hosts,
    state: (h) => (asleep.includes(h.id) ? "stopped" : "running"),
    probe: (h) => { probed.push(h.id); return rooms[h.id]; },
  };
}

test("an isolated placement moves to the awake host with the most room", () => {
  const d = deps([host("small"), host("asleep"), host("mid"), host("big")], {
    small: { fit: false, why: "swap 1.9 of 2.0 GB used" },
    mid: { fit: true, memoryAvailable: 8 * 1024 ** 3 },
    big: { fit: true, memoryAvailable: 30 * 1024 ** 3 },
  }, ["asleep"]);
  const said: string[] = [];
  const r = chooseCloudHost("small", (m) => said.push(m), { fallback: true }, d);
  expect(r).toEqual({ host: host("big"), moved: true, from: host("small"), why: "swap 1.9 of 2.0 GB used" });
  expect(d.probed).not.toContain("asleep");
  expect(said[0]).toContain("small has no room for another session (swap 1.9 of 2.0 GB used): placing on big instead");
});

test("the asked host keeps the session when it has room or is asleep", () => {
  expect(chooseCloudHost("a", () => {}, { fallback: true }, deps([host("a"), host("b")], { a: { fit: true, memoryAvailable: 6 * 1024 ** 3 } })).moved).toBe(false);
  const d = deps([host("a"), host("b")], {}, ["a"]);
  expect(chooseCloudHost("a", () => {}, { fallback: true }, d)).toEqual({ host: host("a"), moved: false });
  expect(d.probed).toEqual([]);
});

test("no room anywhere, or a shared checkout, fails at once with what is full", () => {
  const full = { fit: false, why: "memory pressure critical" };
  expect(() => chooseCloudHost("a", () => {}, { fallback: true }, deps([host("a"), host("b")], { a: full, b: full }))).toThrow("a has no room for another session (memory pressure critical), and no other awake cloud host has room");
  const d = deps([host("a"), host("b")], { a: full, b: { fit: true } });
  expect(() => chooseCloudHost("a", () => {}, { fallback: false }, d)).toThrow("a has no room for another session (memory pressure critical): free memory there");
  expect(d.probed).toEqual(["a"]);
});

const GB = 1024 ** 3;

test("a tight host hands new sessions to a roomier one, same platform first", () => {
  const linux2 = host("linux2"), mac = host("mac", { platform: "darwin" });
  const d = deps([host("tight"), linux2, mac], {
    tight: { fit: true, memoryAvailable: 2 * GB },
    linux2: { fit: true, memoryAvailable: 5 * GB },
    mac: { fit: true, memoryAvailable: 30 * GB },
  });
  const said: string[] = [];
  expect(chooseCloudHost("tight", (m) => said.push(m), { fallback: true }, d)).toEqual({ host: linux2, moved: true, from: host("tight"), why: "only 2.0 GB free" });
  expect(said[0]).toBe("tight is tight (only 2.0 GB free): placing on linux2 instead (5.0 GB free)");
});

test("a tight host keeps the session when nothing roomier is awake", () => {
  const d = deps([host("tight"), host("other")], { tight: { fit: true, memoryAvailable: 2 * GB }, other: { fit: true, memoryAvailable: 3 * GB } });
  expect(chooseCloudHost("tight", () => {}, { fallback: true }, d)).toEqual({ host: host("tight"), moved: false });
});

const full: Headroom = { fit: false, why: "swap 1.9 of 2.0 GB used" };

test("autoscale wakes a sleeping host before it launches one", () => {
  const nap = host("nap", { autoscaled: true });
  const d = deps([host("a"), nap], { a: full }, ["nap"]);
  const said: string[] = [];
  const r = chooseCloudHost("a", (m) => said.push(m), { fallback: true, autoscale: { template: host("a"), maxExtra: 2, size: "t3.xlarge" } }, d);
  expect(r).toEqual({ host: nap, moved: true, from: host("a"), why: "swap 1.9 of 2.0 GB used" });
  expect(said[0]).toBe("a has no room for another session (swap 1.9 of 2.0 GB used): waking nap (autoscale)");
  // Without autoscale the sleeping host is left asleep.
  expect(() => chooseCloudHost("a", () => {}, { fallback: true }, d)).toThrow("no other awake cloud host has room");
});

test("autoscale launches like the template under its cap, and says when the cap is reached", () => {
  const plan = { template: host("a"), maxExtra: 1, size: "t3.xlarge" };
  const r = chooseCloudHost("a", () => {}, { fallback: true, autoscale: plan }, deps([host("a")], { a: full }));
  expect(r.launch).toEqual({ like: host("a"), size: "t3.xlarge" });
  const added = host("auto1", { autoscaled: true });
  const busy = deps([host("a"), added], { a: full, auto1: full });
  expect(() => chooseCloudHost("a", () => {}, { fallback: true, autoscale: plan }, busy)).toThrow("autoscale already added 1 of 1 hosts");
});

test("a tight host that still fits keeps the session rather than waiting on a launch", () => {
  const d = deps([host("a")], { a: { fit: true, memoryAvailable: 2 * GB } });
  expect(chooseCloudHost("a", () => {}, { fallback: true, autoscale: { template: host("a"), maxExtra: 3, size: "t3.xlarge" } }, d)).toEqual({ host: host("a"), moved: false });
});

const GiB = 1024 ** 3;
const need = { memoryBytes: 12 * GiB };

test("a host is measured against the memory the repo declares", () => {
  expect(headroomFromProbe(mac(1)).memoryTotal).toBe(48 * GiB);
  // The t3.medium of jx72f3a against codecast's need.
  expect(tooSmallFor({ memoryTotal: 3924688 * 1024 }, need)).toStartWith("it has 3.7 GB of memory and this repo needs 12.0 GB");
  // A 16 GB instance reports 15.3 GiB to the kernel and fits.
  expect(tooSmallFor({ memoryTotal: 15.3 * GiB }, need)).toBeUndefined();
  expect(tooSmallFor({ memoryTotal: 2 * GiB }, undefined)).toBeUndefined();
  expect(tooSmallFor({}, need)).toBeUndefined();
});

test("new hosts are sized to the need, never below the size asked for", () => {
  expect(sizeFor(need, "t3.large")).toBe("t3.xlarge");
  expect(sizeFor({ memoryBytes: 8 * GiB }, "t3.large")).toBe("t3.xlarge");
  expect(sizeFor(undefined, "t3.large")).toBe("t3.large");
  expect(sizeFor(need, "t3.2xlarge")).toBe("t3.2xlarge");
  expect(sizeFor({ memoryBytes: 64 * GiB }, "t3.large")).toBe("t3.large");
});

test("a host too small for the repo yields to one that fits, even with room of its own", () => {
  const d = deps([host("small"), host("big")], {
    small: { fit: true, memoryAvailable: 2 * GiB, memoryTotal: 3.7 * GiB },
    big: { fit: true, memoryAvailable: 6 * GiB, memoryTotal: 15.3 * GiB },
  });
  const r = chooseCloudHost("small", () => {}, { fallback: true, need }, d);
  expect(r.host.id).toBe("big");
  expect(r.why).toStartWith("too small: it has 3.7 GB");
  // A roomier host that is itself too small is no better.
  const d2 = deps([host("small"), host("other")], {
    small: { fit: true, memoryAvailable: 2 * GiB, memoryTotal: 3.7 * GiB },
    other: { fit: true, memoryAvailable: 5 * GiB, memoryTotal: 7.6 * GiB },
  });
  const said: string[] = [];
  const r2 = chooseCloudHost("small", (m) => said.push(m), { fallback: true, need }, d2);
  expect(r2).toMatchObject({ host: host("small"), moved: false });
  expect(r2.small).toStartWith("it has 3.7 GB");
  expect(said.at(-1)).toContain("placing there anyway");
});

test("autoscale launches a host big enough for the repo; a shared checkout lands with the reason", () => {
  const rooms = { small: { fit: true, memoryAvailable: 2 * GiB, memoryTotal: 3.7 * GiB } };
  const r = chooseCloudHost("small", () => {}, { fallback: true, need, autoscale: { template: host("small"), maxExtra: 1, size: "t3.large" } }, deps([host("small")], rooms));
  expect(r.launch?.size).toBe("t3.xlarge");
  const shared = chooseCloudHost("small", () => {}, { fallback: false, need }, deps([host("small")], rooms));
  expect(shared).toMatchObject({ host: host("small"), moved: false });
  expect(shared.small).toContain("needs 12.0 GB");
});
