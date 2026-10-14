import { expect, test } from "bun:test";
import { chooseCloudHost, headroomFromProbe, type Headroom, type HostChoiceDeps } from "./hostHeadroom";
import type { CloudHost } from "../browser/cloudHost";

const linux = (avail: number, swapTotal: number, swapFree: number, fullAvg60 = 0.5) =>
  `Linux\n---\nMemTotal: 3924688 kB\nMemAvailable: ${avail} kB\nSwapTotal: ${swapTotal} kB\nSwapFree: ${swapFree} kB\n---\nsome avg10=1.68 avg60=1.41 avg300=2.45 total=1\nfull avg10=1.23 avg60=${fullAvg60} avg300=1.82 total=1\n`;
const mac = (level: number) =>
  `Darwin\n---\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 2000000.\nPages inactive: 400000.\nPages speculative: 1000.\nPages occupied by compressor: 0.\n---\nvm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\nkern.memorystatus_vm_pressure_level: ${level}\nhw.memsize: 51539607552\n`;

test("a t3.medium with its swap full has no room, though 2 GB reads as available", () => {
  // The ubuntu host on 2026-10-14, minutes after five OOM kills.
  expect(headroomFromProbe(linux(2014028, 2097148, 123712))).toEqual({ fit: false, why: "swap 1.9 of 2.0 GB used", memoryAvailable: 2014028 * 1024 });
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
    awake: (h) => !asleep.includes(h.id),
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
  expect(r).toEqual({ host: host("big"), moved: true });
  expect(d.probed).not.toContain("asleep");
  expect(said[0]).toContain("small has no room for another session (swap 1.9 of 2.0 GB used): placing on big instead");
});

test("the asked host keeps the session when it has room or is asleep", () => {
  expect(chooseCloudHost("a", () => {}, { fallback: true }, deps([host("a"), host("b")], { a: { fit: true } })).moved).toBe(false);
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
