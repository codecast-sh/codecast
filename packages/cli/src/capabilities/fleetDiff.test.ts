import { describe, expect, test } from "bun:test";
import type { Inventory, InventoryItem } from "./inventory.js";
import {
  buildFleetDiff,
  capabilityIdentity,
  type DeviceReport,
  type FleetDiff,
  type FleetDiffRow,
} from "./fleetDiff.js";

// ---------------------------------------------------------------- fixtures

function inv(items: Partial<InventoryItem>[], marketplaces: Inventory["marketplaces"] = []): Inventory {
  return {
    items: items.map((i) => ({
      kind: "skill",
      name: "unnamed",
      scope: "user",
      enabled: true,
      // A real inventory always carries an absolute source path, and it is
      // different on every machine — every test here relies on it never
      // reaching identity.
      source: `/Users/${Math.random().toString(36).slice(2)}/.claude/skills/x/SKILL.md`,
      ...i,
    })) as InventoryItem[],
    marketplaces,
  };
}

const skill = (name: string, extra: Partial<InventoryItem> = {}): Partial<InventoryItem> => ({
  kind: "skill",
  name,
  ...extra,
});

const plugin = (id: string, sha?: string, extra: Partial<InventoryItem> = {}): Partial<InventoryItem> => ({
  kind: "plugin",
  name: id,
  installed: true,
  ...extra,
  meta: { plugin: id.split("@")[0], marketplace: id.split("@")[1] ?? "", ...(sha ? { sha } : {}), ...extra.meta },
});

function device(deviceId: string, items: Partial<InventoryItem>[], label?: string): DeviceReport {
  return { deviceId, deviceLabel: label, inventory: inv(items) };
}

function rowFor(diff: FleetDiff, key: string): FleetDiffRow {
  const row = diff.rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key} in ${diff.rows.map((r) => r.key).join(", ")}`);
  return row;
}

/** Cells are documented as positionally parallel to `diff.devices`. */
function cellOn(diff: FleetDiff, row: FleetDiffRow, deviceId: string) {
  const index = diff.devices.findIndex((d) => d.deviceId === deviceId);
  const cell = row.cells[index];
  expect(cell.deviceId).toBe(deviceId);
  return cell;
}

// ------------------------------------------------------------- the classes

describe("the five cell classes", () => {
  const diff = buildFleetDiff([
    device("laptop", [
      skill("deep-research"),
      skill("only-here"),
      plugin("frontend-design@official", "aaa1"),
      plugin("code-simplifier@official", "bbb1"),
    ], "MacBook"),
    device("desktop", [
      skill("deep-research"),
      plugin("frontend-design@official", "aaa1"),
      plugin("code-simplifier@official", "bbb1", { enabled: false }),
    ], "Studio"),
    device("m1", [
      skill("deep-research"),
      plugin("frontend-design@official", "zzz9"),
      plugin("code-simplifier@official", "bbb1"),
    ], "m1"),
    { deviceId: "server", deviceLabel: "build box" }, // never reported
  ]);

  test("present and identical everywhere is in sync", () => {
    const row = rowFor(diff, "skill:deep-research");
    expect(row.status).toBe("in_sync");
    expect(row.cells.map((c) => c.status)).toEqual(["same", "same", "same", "unknown"]);
  });

  test("a different sha is pin drift on the minority machine only", () => {
    const row = rowFor(diff, "plugin:frontend-design@official");
    expect(row.status).toBe("drift");
    expect(row.pinDrift).toBe(true);
    expect(row.stateDrift).toBe(false);
    expect(row.baselinePin).toBe("aaa1"); // two machines agree, one does not
    expect(row.pins).toEqual(["aaa1", "zzz9"]);
    expect(cellOn(diff, row, "laptop").status).toBe("same");
    expect(cellOn(diff, row, "m1").status).toBe("pin_differs");
    expect(cellOn(diff, row, "m1").pin).toBe("zzz9");
  });

  test("switched off on one machine is drift, and the cell says so", () => {
    const row = rowFor(diff, "plugin:code-simplifier@official");
    expect(row.status).toBe("drift");
    expect(row.stateDrift).toBe(true);
    expect(row.disabledCount).toBe(1);
    expect(row.activeCount).toBe(2);
    expect(cellOn(diff, row, "desktop")).toMatchObject({ status: "disabled", present: true, enabled: false });
  });

  test("absent on a machine that reported, unknown on one that never did", () => {
    const row = rowFor(diff, "skill:only-here");
    expect(row.status).toBe("unique");
    expect(cellOn(diff, row, "laptop").status).toBe("same");
    expect(cellOn(diff, row, "desktop").status).toBe("absent");
    expect(cellOn(diff, row, "server").status).toBe("unknown");
    // A machine that never reported must not be counted as missing it.
    expect(row.absentCount).toBe(2);
  });

  test("a device that never reported is a column, not a report", () => {
    expect(diff.devices.map((d) => [d.deviceId, d.label, d.reported])).toEqual([
      ["laptop", "MacBook", true],
      ["desktop", "Studio", true],
      ["m1", "m1", true],
      ["server", "build box", false],
    ]);
    expect(diff.summary.devices).toBe(4);
    expect(diff.summary.reporting).toBe(3);
    expect(diff.summary.comparable).toBe(true);
  });

  test("the summary counts add up the way the header claims", () => {
    const { total, inSync, drifted, uniqueToOne } = diff.summary;
    expect(total).toBe(diff.rows.length);
    expect(inSync + drifted).toBe(total);
    expect(uniqueToOne).toBeLessThanOrEqual(drifted);
    expect({ total, inSync, drifted, uniqueToOne }).toEqual({
      total: 4,
      inSync: 1,
      drifted: 3,
      uniqueToOne: 1,
    });
  });
});

// ------------------------------------------------------------ the invariant

describe("the grid and the header never disagree", () => {
  test("an in-sync row carries no absent or pin_differs cell", () => {
    const diff = buildFleetDiff([
      device("a", [skill("s"), plugin("p@m", "sha"), { kind: "mcp", name: "gh", meta: { transport: "stdio" } }]),
      device("b", [skill("s"), plugin("p@m", "sha"), { kind: "mcp", name: "gh", meta: { transport: "stdio" } }]),
    ]);
    for (const row of diff.rows) {
      expect(row.status).toBe("in_sync");
      for (const cell of row.cells) {
        expect(["same", "disabled"]).toContain(cell.status);
      }
    }
  });

  test("every drifted row has a cell a person can point at", () => {
    const diff = buildFleetDiff([
      device("a", [skill("here"), plugin("p@m", "one"), plugin("off@m", "x")]),
      device("b", [plugin("p@m", "two"), plugin("off@m", "x", { enabled: false })]),
    ]);
    const drifted = diff.rows.filter((r) => r.status !== "in_sync");
    expect(drifted.length).toBe(3);
    for (const row of drifted) {
      expect(row.cells.some((c) => c.status === "absent" || c.status === "pin_differs" || c.status === "disabled")).toBe(
        true,
      );
    }
  });

  test("switched off on every machine, at the same pin, is agreement", () => {
    // The documented corner: the cells all read `disabled`, and the machines
    // still agree, so the header must not call it drift.
    const diff = buildFleetDiff([
      device("a", [plugin("p@m", "sha", { enabled: false })]),
      device("b", [plugin("p@m", "sha", { enabled: false })]),
    ]);
    const row = rowFor(diff, "plugin:p@m");
    expect(row.status).toBe("in_sync");
    expect(row.cells.map((c) => c.status)).toEqual(["disabled", "disabled"]);
    expect(diff.summary.drifted).toBe(0);
  });
});

// ------------------------------------------------------------ one machine

describe("one machine is not a fleet", () => {
  test("a single report renders as nothing to compare, never as all unique", () => {
    const diff = buildFleetDiff([device("laptop", [skill("a"), skill("b"), plugin("p@m", "sha")])]);
    expect(diff.summary.comparable).toBe(false);
    expect(diff.summary.reporting).toBe(1);
    expect(diff.summary.total).toBe(3);
    expect(diff.summary.uniqueToOne).toBe(0);
    expect(diff.summary.drifted).toBe(0);
    expect(diff.summary.inSync).toBe(0);
    expect(diff.rows.every((r) => r.status === "not_comparable")).toBe(true);
    // The one machine's own inventory is still readable, listed by kind.
    expect(diff.rows.map((r) => r.key)).toEqual(["plugin:p@m", "skill:a", "skill:b"]);
  });

  test("one report plus silent machines is still nothing to compare", () => {
    const diff = buildFleetDiff([
      device("laptop", [skill("a")]),
      { deviceId: "desktop" },
      { deviceId: "m1", inventory: null },
    ]);
    expect(diff.summary.comparable).toBe(false);
    expect(diff.summary.uniqueToOne).toBe(0);
    expect(rowFor(diff, "skill:a").cells.map((c) => c.status)).toEqual(["same", "unknown", "unknown"]);
  });

  test("an empty report is a report — a machine with nothing installed", () => {
    const diff = buildFleetDiff([device("laptop", [skill("a")]), device("blank", [])]);
    expect(diff.summary.comparable).toBe(true);
    expect(rowFor(diff, "skill:a").status).toBe("unique");
    expect(rowFor(diff, "skill:a").cells.map((c) => c.status)).toEqual(["same", "absent"]);
  });

  test("no devices at all", () => {
    const diff = buildFleetDiff([]);
    expect(diff).toEqual({
      devices: [],
      rows: [],
      summary: { devices: 0, reporting: 0, comparable: false, total: 0, inSync: 0, drifted: 0, uniqueToOne: 0 },
    });
  });
});

// -------------------------------------------------------------- identity

describe("identity is stable across machines", () => {
  test("absolute paths never reach the key", () => {
    const diff = buildFleetDiff([
      { deviceId: "a", inventory: inv([{ kind: "skill", name: "s", source: "/Users/ashot/.claude/skills/s/SKILL.md" }]) },
      { deviceId: "b", inventory: inv([{ kind: "skill", name: "s", source: "/home/ci/.claude/skills/s/SKILL.md" }]) },
    ]);
    expect(diff.rows.length).toBe(1);
    expect(diff.rows[0].status).toBe("in_sync");
  });

  test("the same skill at different scopes is one capability", () => {
    const diff = buildFleetDiff([
      device("a", [skill("review", { scope: "user" })]),
      device("b", [skill("review", { scope: "project" })]),
    ]);
    expect(diff.rows.length).toBe(1);
    expect(diff.rows[0].status).toBe("in_sync");
    expect(diff.rows[0].scopes).toEqual(["project", "user"]);
  });

  test("case differences are one row, and the first spelling is displayed", () => {
    const diff = buildFleetDiff([device("a", [skill("Domain-Search")]), device("b", [skill("domain-search")])]);
    expect(diff.rows.length).toBe(1);
    expect(diff.rows[0].key).toBe("skill:domain-search");
    expect(diff.rows[0].identity).toBe("Domain-Search");
    expect(diff.rows[0].status).toBe("in_sync");
  });

  test("a plugin is name@marketplace, composed when the report gives them apart", () => {
    expect(capabilityIdentity("plugin", "frontend-design", { marketplace: "official" })).toBe(
      "frontend-design@official",
    );
    expect(capabilityIdentity("plugin", "frontend-design@official", { marketplace: "official" })).toBe(
      "frontend-design@official",
    );
    expect(capabilityIdentity("skill", "  spaced  ")).toBe("spaced");
    expect(capabilityIdentity("skill", "   ")).toBeUndefined();

    const diff = buildFleetDiff([
      { deviceId: "a", inventory: inv([{ kind: "plugin", name: "fd@official", meta: { marketplace: "official" } }]) },
      { deviceId: "b", inventory: inv([{ kind: "plugin", name: "fd", meta: { marketplace: "official" } }]) },
    ]);
    expect(diff.rows.length).toBe(1);
    expect(diff.rows[0].key).toBe("plugin:fd@official");
  });

  test("the same name under two kinds stays two rows", () => {
    const diff = buildFleetDiff([
      device("a", [skill("commit"), { kind: "command", name: "commit" }]),
      device("b", [skill("commit"), { kind: "command", name: "commit" }]),
    ]);
    expect(diff.rows.map((r) => r.key).sort()).toEqual(["command:commit", "skill:commit"]);
  });
});

// ----------------------------------------------------------------- scopes

describe("scopes stack rather than override", () => {
  test("a plugin off at project and on at user is on here", () => {
    // What `claude plugin list --json` reports: one row per scope, and the
    // union is what is actually active.
    const diff = buildFleetDiff([
      {
        deviceId: "a",
        inventory: inv([
          { kind: "plugin", name: "p@m", scope: "project", enabled: false, meta: { sha: "s1" } },
          { kind: "plugin", name: "p@m", scope: "user", enabled: true, meta: { sha: "s1" } },
        ]),
      },
      device("b", [plugin("p@m", "s1")]),
    ]);
    const row = rowFor(diff, "plugin:p@m");
    expect(row.status).toBe("in_sync");
    const cell = cellOn(diff, row, "a");
    expect(cell).toMatchObject({ present: true, enabled: true, status: "same" });
    expect(cell.scopes).toEqual(["project", "user"]);
  });

  test("several reports for one machine fold into one column", () => {
    // The server keeps one report per (device, client, project scope), so a
    // caller passing raw rows hands us the same device more than once.
    const diff = buildFleetDiff([
      { deviceId: "a", inventory: inv([skill("from-user-scope")]) },
      { deviceId: "a", deviceLabel: "MacBook", inventory: inv([skill("from-project-scope")]) },
      device("b", [skill("from-user-scope")]),
    ]);
    expect(diff.devices.length).toBe(2);
    expect(diff.devices[0]).toEqual({ deviceId: "a", label: "MacBook", reported: true });
    expect(rowFor(diff, "skill:from-user-scope").status).toBe("in_sync");
    expect(rowFor(diff, "skill:from-project-scope").status).toBe("unique");
  });
});

// -------------------------------------------------------------------- pins

describe("what counts as a different pin", () => {
  test("a plugin falls back to version when no sha was recorded", () => {
    const diff = buildFleetDiff([
      { deviceId: "a", inventory: inv([{ kind: "plugin", name: "p@m", meta: { version: "1.2.0" } }]) },
      { deviceId: "b", inventory: inv([{ kind: "plugin", name: "p@m", meta: { version: "1.3.0" } }]) },
    ]);
    const row = rowFor(diff, "plugin:p@m");
    expect(row.pins).toEqual(["1.2.0", "1.3.0"]);
    expect(row.status).toBe("drift");
  });

  test("sha wins over version, so one machine cannot look behind on a spelling", () => {
    const diff = buildFleetDiff([
      { deviceId: "a", inventory: inv([{ kind: "plugin", name: "p@m", meta: { sha: "abc", version: "1.0.0" } }]) },
      { deviceId: "b", inventory: inv([{ kind: "plugin", name: "p@m", meta: { sha: "abc", version: "1.0.1" } }]) },
    ]);
    expect(rowFor(diff, "plugin:p@m").status).toBe("in_sync");
    expect(rowFor(diff, "plugin:p@m").pins).toEqual(["abc"]);
  });

  test("an unknown pin is not a different pin", () => {
    // Declared in settings but never fetched: no sha to compare. Calling that
    // drift would report a difference we cannot actually see.
    const diff = buildFleetDiff([
      device("a", [plugin("p@m", "sha1")]),
      { deviceId: "b", inventory: inv([{ kind: "plugin", name: "p@m", installed: false }]) },
    ]);
    const row = rowFor(diff, "plugin:p@m");
    expect(row.status).toBe("in_sync");
    expect(row.pins).toEqual(["sha1"]);
    expect(cellOn(diff, row, "b")).toMatchObject({ status: "same", pin: undefined, installed: false });
  });

  test("an mcp command line is never a pin — its paths differ by machine", () => {
    const diff = buildFleetDiff([
      {
        deviceId: "a",
        inventory: inv([
          { kind: "mcp", name: "pg", meta: { transport: "stdio", command: "node /Users/ashot/mcp/pg.js" } },
        ]),
      },
      {
        deviceId: "b",
        inventory: inv([{ kind: "mcp", name: "pg", meta: { transport: "stdio", command: "node /home/ci/mcp/pg.js" } }]),
      },
    ]);
    expect(rowFor(diff, "mcp:pg").status).toBe("in_sync");
    expect(rowFor(diff, "mcp:pg").pins).toEqual([]);
  });

  test("an mcp url is a pin, and a trailing slash is not a difference", () => {
    const diff = buildFleetDiff([
      { deviceId: "a", inventory: inv([{ kind: "mcp", name: "gh", meta: { transport: "http", url: "https://x/mcp/" } }]) },
      { deviceId: "b", inventory: inv([{ kind: "mcp", name: "gh", meta: { transport: "http", url: "https://x/mcp" } }]) },
      { deviceId: "c", inventory: inv([{ kind: "mcp", name: "gh", meta: { transport: "http", url: "https://old/mcp" } }]) },
    ]);
    const row = rowFor(diff, "mcp:gh");
    expect(row.baselinePin).toBe("https://x/mcp");
    expect(cellOn(diff, row, "c").status).toBe("pin_differs");
  });

  test("a two-way pin split picks a baseline the same way every run", () => {
    const forward = buildFleetDiff([device("a", [plugin("p@m", "zzz")]), device("b", [plugin("p@m", "aaa")])]);
    const reversed = buildFleetDiff([device("b", [plugin("p@m", "aaa")]), device("a", [plugin("p@m", "zzz")])]);
    expect(forward.rows[0].baselinePin).toBe("aaa");
    expect(reversed.rows[0].baselinePin).toBe("aaa");
  });
});

// ------------------------------------------------------------ marketplaces

describe("marketplaces sit in the same grid", () => {
  test("a marketplace one machine never registered is drift", () => {
    const diff = buildFleetDiff([
      { deviceId: "a", inventory: inv([], [{ name: "official", repo: "anthropics/claude-plugins-official", scope: "user" }]) },
      { deviceId: "b", inventory: inv([], []) },
    ]);
    const row = rowFor(diff, "marketplace:official");
    expect(row.kind).toBe("marketplace");
    expect(row.status).toBe("unique");
    expect(row.baselinePin).toBe("anthropics/claude-plugins-official");
  });

  test("the same marketplace name pointed at two repos is pin drift", () => {
    const diff = buildFleetDiff([
      { deviceId: "a", inventory: inv([], [{ name: "team", repo: "acme/plugins", scope: "user" }]) },
      { deviceId: "b", inventory: inv([], [{ name: "team", repo: "acme/plugins-old", scope: "user" }]) },
    ]);
    const row = rowFor(diff, "marketplace:team");
    expect(row.pinDrift).toBe(true);
    expect(row.status).toBe("drift");
  });
});

// ------------------------------------------------------------------ order

describe("drift sorts before agreement", () => {
  // Four machines, one of every verdict. Note that a capability only ONE
  // machine has is `unique`, however many machines lack it — so a drift row
  // needs at least two machines holding it.
  const diff = buildFleetDiff([
    device("a", [
      skill("missing-on-one"), //   absent on d          → rank 0, activeCount 3
      skill("missing-on-two"), //   absent on c and d    → rank 0, activeCount 2
      plugin("behind@m", "new"), // pin drift on c       → rank 1, activeCount 4
      skill("mine-only"), //        one machine only     → rank 2
      skill("everywhere"), //       agreed               → rank 3
    ]),
    device("b", [skill("missing-on-one"), skill("missing-on-two"), plugin("behind@m", "new"), skill("everywhere")]),
    device("c", [skill("missing-on-one"), plugin("behind@m", "old"), skill("everywhere")]),
    device("d", [plugin("behind@m", "new"), skill("everywhere")]),
  ]);

  test("the order is: missing somewhere, then behind, then unique, then agreed", () => {
    expect(diff.rows.map((r) => r.key)).toEqual([
      "skill:missing-on-one",
      "skill:missing-on-two",
      "plugin:behind@m",
      "skill:mine-only",
      "skill:everywhere",
    ]);
  });

  test("within a rank, the capability most machines have leads", () => {
    const first = diff.rows[0];
    const second = diff.rows[1];
    expect(first.activeCount).toBeGreaterThan(second.activeCount);
  });

  test("kind breaks a tie before the name does, and the name always finishes it", () => {
    const tied = buildFleetDiff([
      device("a", [skill("b-skill"), skill("a-skill"), { kind: "mcp", name: "z-mcp" }, plugin("z-plugin@m")]),
      device("b", [skill("b-skill"), skill("a-skill"), { kind: "mcp", name: "z-mcp" }, plugin("z-plugin@m")]),
    ]);
    expect(tied.rows.map((r) => r.key)).toEqual([
      "plugin:z-plugin@m",
      "mcp:z-mcp",
      "skill:a-skill",
      "skill:b-skill",
    ]);
  });

  test("device columns keep the order the caller asked for", () => {
    expect(diff.devices.map((d) => d.deviceId)).toEqual(["a", "b", "c", "d"]);
    for (const row of diff.rows) {
      expect(row.cells.map((c) => c.deviceId)).toEqual(["a", "b", "c", "d"]);
    }
  });
});

// ------------------------------------------------------------------- pure

describe("pure, and total", () => {
  const reports: DeviceReport[] = [
    device("a", [skill("s"), plugin("p@m", "sha")]),
    device("b", [skill("s")]),
  ];

  test("the same input gives the same answer, and the input is untouched", () => {
    const before = JSON.stringify(reports);
    const first = buildFleetDiff(reports);
    const second = buildFleetDiff(reports);
    expect(first).toEqual(second);
    expect(JSON.stringify(reports)).toBe(before);
  });

  test("a malformed report costs its column, not the page", () => {
    const diff = buildFleetDiff([
      device("good", [skill("s")]),
      // Everything a JSON-parsed report can go wrong as.
      { deviceId: "bad", inventory: { items: "not an array", marketplaces: undefined } as unknown as Inventory },
      { deviceId: "junk", inventory: { items: [null, 42, {}, { kind: "skill" }, { kind: "nope", name: "x" }, { kind: "skill", name: "   " }] } as unknown as Inventory },
      { deviceId: " ", inventory: inv([skill("ghost")]) }, // no id: cannot be a column
    ] as DeviceReport[]);
    expect(diff.devices.map((d) => d.deviceId)).toEqual(["good", "bad", "junk"]);
    expect(diff.rows.map((r) => r.key)).toEqual(["skill:s"]);
    expect(rowFor(diff, "skill:s").status).toBe("unique");
  });

  test("a report that is not an object at all", () => {
    const diff = buildFleetDiff([
      { deviceId: "a", inventory: "corrupt" as unknown as Inventory },
      device("b", [skill("s")]),
    ]);
    // It reported something, so it counts as a machine we have heard from —
    // and it has nothing, which is exactly what the row says.
    expect(diff.summary.comparable).toBe(true);
    expect(cellOn(diff, rowFor(diff, "skill:s"), "a").status).toBe("absent");
  });

  test("a device with no label is labelled by its id", () => {
    const diff = buildFleetDiff([{ deviceId: "abc123", deviceLabel: "  ", inventory: inv([]) }]);
    expect(diff.devices[0].label).toBe("abc123");
  });

  test("non-array input", () => {
    expect(buildFleetDiff(undefined as unknown as DeviceReport[]).summary.total).toBe(0);
  });
});
