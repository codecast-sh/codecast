// The accounts × machines grid: the incident's setup, read cell by cell.
import { expect, test } from "bun:test";
import { accountLabel, accountMachineGrid, toggledDeviceIds, type GridMachine, type GridPoolRow } from "../accountMachineGrid";

const NOW = Date.UTC(2026, 10, 17, 12);
const use = (pct: number) => ({ fetched_at: NOW, weekly: { percent: pct, resets_at: NOW + 1e8 } });

const machines: GridMachine[] = [
  { device_id: "mac", label: "MacBook", is_remote: false },
  { device_id: "mini", label: "Mac mini", is_remote: false },
  { device_id: "h1", label: "line-1", is_remote: true, line_host: true },
  { device_id: "h2", label: "line-2", is_remote: true, line_host: true },
];
const accounts = [
  { device_id: "mac", profiles: [{ name: "claude", email: "claude@x.com" }, { name: "claude3", email: "claude3@x.com" }, { name: "solo", email: "solo@x.com" }, { name: "cam", email: "r.cameron.musgrave@gmail.com" }] },
  { device_id: "mini", profiles: [{ name: "pool-claude3", email: "claude3@x.com", pool_share_id: "s3" }] },
  { device_id: "h1", profiles: [{ name: "pool-claude3", email: "claude3@x.com", pool_share_id: "t3" }] },
  { device_id: "h2", profiles: [] },
];
const pool: GridPoolRow[] = [
  { mine: true, team_id: null, email: "claude@x.com", device_ids: ["mac", "mini"], usage: use(7) },
  { mine: true, team_id: null, email: "claude3@x.com", device_ids: ["mac", "mini"], usage: use(100) },
  { mine: true, team_id: "T", email: "claude3@x.com", pools: ["line"], usage: use(100) },
  { mine: true, team_id: null, email: "r.cameron.musgrave@gmail.com", device_ids: null, usage: use(5) },
];
const grid = accountMachineGrid({ machines, accounts, pool, now: NOW });
const row = (email: string) => grid.rows.find((r) => r.email === email)!;
const states = (email: string) => row(email).cells.map((c) => c.state);

test("line hosts are one column after the machines", () => {
  expect(grid.columns.map((c) => c.label)).toEqual(["Mac mini", "MacBook", "2 line hosts"]);
});

test("cloud hosts that run the same accounts share a column; one that differs stands alone", () => {
  const clouds: GridMachine[] = [
    { device_id: "c1", label: "cloud-1", is_remote: true },
    { device_id: "c2", label: "cloud-2", is_remote: true },
    { device_id: "c3", label: "cloud-3", is_remote: true },
  ];
  const narrowed = pool.map((r) => (r.email === "claude@x.com" ? { ...r, device_ids: ["mac", "c1", "c2"] } : r));
  const g = accountMachineGrid({ machines: [...machines, ...clouds], accounts, pool: narrowed, now: NOW });
  expect(g.columns.map((c) => c.label)).toEqual(["Mac mini", "MacBook", "2 cloud hosts", "cloud-3", "2 line hosts"]);
});

test("an account label keeps the domain only when two accounts share a name", () => {
  expect(accountLabel("ashot@union.app", ["ashot@union.app", "ashot@apetrosian.com", "claude@x.com"])).toBe("ashot@union.app");
  expect(accountLabel("claude@x.com", ["ashot@union.app", "claude@x.com"])).toBe("claude");
});

test("each cell says why: own login, opened, kept off, line pool, refused, no token", () => {
  // Kept off the line hosts by the personal list: one press opens it.
  expect(states("claude@x.com")).toEqual(["arriving", "own", "off"]);
  expect(row("claude@x.com").cells[2].toggle).toBe("open");
  // A line pool account reaches the hosts through the team share, not the personal list.
  expect(states("claude3@x.com")).toEqual(["on", "own", "line"]);
  // The line hosts refuse this one whatever the pool says.
  expect(states("r.cameron.musgrave@gmail.com")).toEqual(["arriving", "own", "refused"]);
  expect(row("r.cameron.musgrave@gmail.com").cells[2].toggle).toBeNull();
  // No setup-token, no personal row: it stays where it logged in.
  expect(row("solo@x.com").shareable).toBe(false);
  expect(states("solo@x.com")).toEqual(["local", "own", "local"]);
});

test("rows rank by room left", () => {
  expect(grid.rows[0].email).toBe("r.cameron.musgrave@gmail.com");
});

test("toggling writes the personal machine list, null once it reaches every machine", () => {
  const all = machines.map((m) => m.device_id);
  const lineCol = grid.columns[2];
  expect(toggledDeviceIds(row("claude@x.com"), lineCol, true, all)).toBeNull();
  expect(toggledDeviceIds(row("claude@x.com"), grid.columns[0], false, all)).toEqual(["mac"]);
  expect(toggledDeviceIds({ deviceIds: null }, lineCol, false, all)).toEqual(["mac", "mini"]);
});
