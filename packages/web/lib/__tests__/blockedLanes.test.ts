// The blocked banner's lanes: one answer per group of machines, because
// accounts belong to machines (lib/blockedLanes). The fixture is the incident
// that asked for this: Union line workers parked on five line hosts whose only
// accounts (the line pool) are all spent, while the laptop holds accounts with
// room that the pool keeps off those hosts on purpose.
import { expect, test } from "bun:test";
import { blockedLanes, openedDeviceIds, type LaneDevice, type LanePoolRow } from "../blockedLanes";

const NOW = Date.UTC(2026, 10, 17, 12);
const H = 3_600_000;
const spent = (resetsInH: number) => ({ fetched_at: NOW - 60_000, weekly: { percent: 100, resets_at: NOW + resetsInH * H } });
const room = (pct: number) => ({ fetched_at: NOW - 60_000, weekly: { percent: pct, resets_at: NOW + 150 * H } });

const LINE_POOL = [
  { name: "pool-claude2", email: "claude2@x.com", usage: spent(96) },
  { name: "pool-claude3", email: "claude3@x.com", usage: spent(96) },
  { name: "pool-claude6", email: "claude6@x.com", usage: spent(72) },
];
const host = (n: number): LaneDevice => ({
  device_id: `host-${n}`,
  label: `line-${n}`,
  is_remote: true,
  line_host: true,
  online: true,
  fleet_store: true,
  launch_profile: "pool-claude3",
  profiles: LINE_POOL,
});
const laptop: LaneDevice = {
  device_id: "mac",
  label: "MacBook",
  is_remote: false,
  online: true,
  active_email: "petro@x.com",
  profiles: [
    { name: "petro", email: "petro@x.com", usage: spent(150) },
    { name: "claude", email: "claude@x.com", usage: room(7) },
    { name: "claude4", email: "claude4@x.com", usage: room(52) },
  ],
};
const pool: LanePoolRow[] = [
  { mine: true, team_id: null, email: "claude@x.com", device_ids: ["mac"], usage: room(7) },
  { mine: true, team_id: null, email: "claude4@x.com", device_ids: ["mac"], usage: room(52) },
  { mine: true, team_id: null, email: "r.cameron.musgrave@gmail.com", device_ids: ["mac"], usage: room(5) },
  { mine: true, team_id: null, email: "petro@x.com", device_ids: null, usage: spent(150) },
];
const devices = [host(1), host(2), laptop];
const byId = new Map(devices.map((d) => [d.device_id, d]));

function lanesFor(sessions: Array<{ _id: string; owner: string }>, poolRows = pool) {
  return blockedLanes({
    sessions: sessions.map((s) => ({ _id: s._id, pending_api_error_kind: "limit" })),
    executorFor: (s) => byId.get(sessions.find((x) => x._id === s._id)!.owner),
    pool: poolRows,
    now: NOW,
  });
}

test("line hosts with only spent pool accounts wait, say when, and name the kept-off account that ends the wait", () => {
  const [lane] = lanesFor([{ _id: "a", owner: "host-1" }, { _id: "b", owner: "host-2" }]);
  expect(lane.state).toBe("wait");
  expect(lane.label).toBe("2 line hosts");
  expect(lane.sessionIds).toEqual(["a", "b"]);
  expect(lane.heldAccounts).toBe(3);
  expect(lane.resumesOn).toBe("claude6@x.com");
  expect(lane.resumesAt).toBe(NOW + 72 * H);
  // Freshest first; the account the line hosts refuse is never offered there.
  expect(lane.keptOff.map((a) => a.email)).toEqual(["claude@x.com", "claude4@x.com"]);
  expect(openedDeviceIds(lane.keptOff[0], lane)).toEqual(["host-1", "host-2", "mac"]);
});

test("the laptop and the hosts get separate lanes: one can switch now while the other waits", () => {
  const lanes = lanesFor([{ _id: "a", owner: "host-1" }, { _id: "m", owner: "mac" }]);
  expect(lanes.map((l) => [l.state, l.label])).toEqual([["switch", "MacBook"], ["wait", "line-1"]]);
  expect(lanes[0].accounts.map((a) => a.email)).toEqual(["claude@x.com", "claude4@x.com"]);
  // A lane that can switch is not asked to open accounts elsewhere.
  expect(lanes[0].keptOff).toEqual([]);
});

test("an account opened to the hosts but not landed yet reads as arriving, not as kept off", () => {
  const opened = pool.map((r) => (r.email === "claude@x.com" ? { ...r, device_ids: ["host-1", "mac"] } : r));
  const [lane] = lanesFor([{ _id: "a", owner: "host-1" }], opened);
  expect(lane.arriving).toEqual(["claude@x.com"]);
  expect(lane.keptOff.map((a) => a.email)).toEqual(["claude4@x.com"]);
});

test("once the copy lands the hosts can switch onto it", () => {
  const landed: LaneDevice = { ...host(1), profiles: [...LINE_POOL, { name: "pool-claude", email: "claude@x.com", usage: room(7), setup_token: { expires_at: NOW + 1e10 } }] };
  const lanes = blockedLanes({ sessions: [{ _id: "a", pending_api_error_kind: "limit" }], executorFor: () => landed, pool, now: NOW });
  expect(lanes[0].state).toBe("switch");
  expect(lanes[0].accounts.map((a) => a.email)).toEqual(["claude@x.com"]);
});

test("sessions with no machine online form an offline lane", () => {
  const lanes = blockedLanes({ sessions: [{ _id: "a" }], executorFor: () => undefined, pool, now: NOW });
  expect(lanes[0].state).toBe("offline");
});
