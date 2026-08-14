// The web adapter around the shared fleet diff.
//
// `contracts/fleetDiff.test.ts` already proves the fold, the pin-kind
// discipline and the verdicts. NONE of it touches this file: the adapter is a
// separate module with its own inputs (`CapabilityDevice` plus a per-device
// report map, not `DeviceReport[]`), and every bug this suite is here for lived
// in the adapter while the shared module was already correct.
//
// So these tests go at the seam, and they are written to FAIL if the seam is
// wrong rather than to agree with whatever it does today. Each one names the
// wrong answer it rules out.

import { describe, expect, test } from "bun:test";
import { type FleetDiffCell } from "@codecast/shared/contracts";
import {
  buildFleetRows,
  catalogFromFleet,
  FLEET_FILTERS,
  hasReadableReport,
  isBroken,
  needsAttention,
  pinIsNews,
  shortPin,
  summarizeFleet,
  withFleetInstalls,
  type FleetGridRow,
  type FleetInventoryItem,
} from "../FleetMatrix";
import { buildFleetReports } from "../CapabilitiesPage";
import { type CapabilityStateRow } from "../../../store/capabilities";
import { type CapabilityDevice, type CatalogEntry } from "../CapabilityCard";

// ---------------------------------------------------------------- fixtures

/** A machine in the roster. `reportedAt: null` is the store's "never sent an
 *  inventory"; a number is a report that ARRIVED, which is not the same as one
 *  we could read — that distinction is carried by the report map. */
function machine(deviceId: string, name: string, reportedAt: number | null = 1_000): CapabilityDevice {
  return {
    deviceId,
    name,
    kindLabel: "laptop",
    online: true,
    lastSeen: 1_000,
    reportedAt,
  };
}

function item(over: Partial<FleetInventoryItem> & { kind: string; name: string }): FleetInventoryItem {
  return { scope: "user", enabled: true, ...over };
}

const skill = (name: string, over: Partial<FleetInventoryItem> = {}) =>
  item({ kind: "skill", name, ...over });

const plugin = (name: string, over: Partial<FleetInventoryItem> = {}) =>
  item({ kind: "plugin", name, ...over });

function rowFor(rows: FleetGridRow[], key: string): FleetGridRow {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}; built: ${rows.map((r) => r.key).join(", ") || "(none)"}`);
  return row;
}

const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";

// ------------------------------------------------- the two kinds of silence

describe("a machine that told us nothing is never drawn as a machine with nothing", () => {
  // The bug this exists to prevent: `reportedAt` is stamped when the row lands,
  // BEFORE anything parses the payload. Deciding "reported" on the timestamp
  // hands an unreadable machine an empty inventory, so every capability the
  // rest of the fleet has draws `absent` on that column — the page inventing
  // the drift it exists to detect.
  const devices = [machine("a", "MacBook"), machine("b", "Studio")];

  test("no entry in the report map is unknown, even with a timestamp", () => {
    const reports = { a: [skill("deep-research")] };
    const rows = buildFleetRows(devices, reports);
    const row = rowFor(rows, "skill:deep-research");
    expect(row.byDevice.b.status).toBe("unknown");
    // One readable report is not a fleet, so there is nothing to compare — and
    // certainly nothing to call drift. The header has to agree with the cells:
    // counting b as reporting would print "2 machines" over a column of
    // question marks.
    expect(row.status).toBe("not_comparable");
    expect(summarizeFleet(rows, devices, reports)).toMatchObject({
      reporting: 1,
      silent: 1,
      comparable: false,
      drift: 0,
    });
  });

  test("an EMPTY entry is an answer: the machine really has nothing", () => {
    // The mirror image, so the fix above cannot be "call everything unknown".
    const reports = { a: [skill("deep-research")], b: [] };
    const rows = buildFleetRows(devices, reports);
    const row = rowFor(rows, "skill:deep-research");
    expect(row.byDevice.b.status).toBe("absent");
    expect(row.status).toBe("unique");
    expect(summarizeFleet(rows, devices, reports)).toMatchObject({
      reporting: 2,
      silent: 0,
      comparable: true,
      missing: 1,
    });
  });

  test("a machine that never reported outranks whatever the map says about it", () => {
    // A stale entry for a device the roster says is silent must not resurrect
    // it as a reporter. The two clauses of `hasReadableReport` are not
    // redundant: this is the one the report map alone cannot answer, and it
    // errs toward `unknown`, which is the state that invents no drift.
    const devices = [machine("a", "MacBook"), machine("b", "Studio", null)];
    const reports = { a: [skill("deep-research")], b: [skill("deep-research")] };
    expect(hasReadableReport(devices[1], reports)).toBe(false);
    const rows = buildFleetRows(devices, reports);
    expect(rowFor(rows, "skill:deep-research").byDevice.b.status).toBe("unknown");
  });
});

// ---------------------------------------------- what counts as a report AT ALL
//
// The seam above trusts its input: an entry in the report map means "this
// machine answered". `buildFleetReports` is what has to earn that, reading the
// store's rows and deciding which of them are answers.
//
// Getting it wrong is not a cosmetic bug. A machine seeded with `[]` here has
// every capability the rest of the fleet holds drawn as `absent` down its whole
// column, and every one of those rows badged drift.
describe("a row with no entries is only an answer when it PARSED to none", () => {
  const row = (over: Partial<CapabilityStateRow> & { _id: string; device_id: string }): CapabilityStateRow => ({
    client: "claude_code",
    scope_key: "",
    reported_at: 1_000,
    ...over,
  });

  /** Entries carry no scope of their own, so the row's `scope_key` is what
   *  decides theirs — the fallback the last test here pins down. */
  const inventory = (...names: string[]) =>
    JSON.stringify({ items: names.map((name) => ({ kind: "skill", name })) });

  test("a payload the server withheld is NOT an empty machine", () => {
    // `webList` spends a response byte budget across the fleet and drops the
    // payload of the rows past it, so the machine with the MOST installed is
    // the first to lose one (`CapabilityStateRow.entries_json`). Seeding it as
    // empty renders the richest machine as the emptiest.
    const reports = buildFleetReports({
      r1: row({ _id: "r1", device_id: "a", entries_json: inventory("deep-research") }),
      r2: row({ _id: "r2", device_id: "b", entries_omitted: true, entry_count: 412 }),
    });
    expect(reports.b).toBeUndefined();

    const devices = [machine("a", "MacBook"), machine("b", "Studio")];
    const rows = buildFleetRows(devices, reports);
    // The whole point: `unknown`, not `absent`, and therefore no verdict.
    expect(rowFor(rows, "skill:deep-research").byDevice.b.status).toBe("unknown");
    expect(rowFor(rows, "skill:deep-research").status).toBe("not_comparable");
    expect(summarizeFleet(rows, devices, reports)).toMatchObject({ reporting: 1, silent: 1, drift: 0 });
  });

  test("a payload that would not parse is NOT an empty machine either", () => {
    const reports = buildFleetReports({
      r1: row({ _id: "r1", device_id: "a", entries_json: inventory("deep-research") }),
      r2: row({ _id: "r2", device_id: "b", entries_json: "{not json" }),
    });
    expect(reports.b).toBeUndefined();
  });

  test("a row that parsed to nothing IS an answer — the machine is simply bare", () => {
    // The mirror image, so the guard above cannot be "call every empty row
    // unknown". A bare machine reported, and its column must read `absent`.
    const reports = buildFleetReports({
      r1: row({ _id: "r1", device_id: "a", entries_json: inventory("deep-research") }),
      r2: row({ _id: "r2", device_id: "b", entries_json: inventory() }),
    });
    expect(reports.b).toEqual([]);
    const rows = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], reports);
    expect(rowFor(rows, "skill:deep-research").byDevice.b.status).toBe("absent");
  });

  test("one client's missing payload does not silence a machine another client answered for", () => {
    // A machine sends one row per agent client. Skipping the withheld row must
    // not skip the machine, or a Codex report going missing would blank a
    // column Claude Code answered in full.
    const reports = buildFleetReports({
      r1: row({ _id: "r1", device_id: "a", client: "claude_code", entries_json: inventory("deploy") }),
      r2: row({ _id: "r2", device_id: "a", client: "codex", entries_omitted: true, entry_count: 9 }),
    });
    expect(reports.a?.map((i) => i.name)).toEqual(["deploy"]);
  });

  test("the union across clients and scopes is still one machine's inventory", () => {
    const reports = buildFleetReports({
      r1: row({ _id: "r1", device_id: "a", entries_json: inventory("deploy") }),
      r2: row({ _id: "r2", device_id: "a", scope_key: "repo:acme", entries_json: inventory("review") }),
    });
    expect(reports.a?.map((i) => [i.name, i.scope])).toEqual([
      ["deploy", "user"],
      // `scope_key` is "" for user scope and a repo identity for a project, so
      // an entry that named no scope of its own inherits the row's.
      ["review", "project"],
    ]);
  });

  test("a row with no device to attach to is dropped, not keyed on a blank", () => {
    const reports = buildFleetReports({
      r1: row({ _id: "r1", device_id: "", entries_json: inventory("orphan") }),
    });
    expect(Object.keys(reports)).toEqual([]);
  });
});

// ------------------------------------------------------------ scopes stack

describe("scopes stack — the bug the shared move existed to kill", () => {
  test("a capability declared twice on one machine keeps both scopes", () => {
    const rows = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], {
      a: [skill("deep-research", { scope: "project" }), skill("deep-research", { scope: "user" })],
      b: [skill("deep-research", { scope: "user" })],
    });
    const row = rowFor(rows, "skill:deep-research");
    // Narrowest first, and BOTH present. A single `scope` field would have
    // dropped one of them, which is the whole reason to track scope at all.
    expect(row.cells.map((c) => c.scopes)).toEqual([["project", "user"], ["user"]]);
    // Two scopes on one machine is not two machines disagreeing.
    expect(row.status).toBe("in_sync");
  });

  test("switched off at one scope and on at another is ON here", () => {
    const rows = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], {
      a: [
        plugin("x@official", { scope: "project", enabled: false }),
        plugin("x@official", { scope: "user", enabled: true }),
      ],
      b: [plugin("x@official", { scope: "user", enabled: true })],
    });
    const row = rowFor(rows, "plugin:x@official");
    expect(row.byDevice.a.enabled).toBe(true);
    expect(row.status).toBe("in_sync");
  });
});

// ------------------------------------------------------- the display join

describe("display facts join on the diff's own row key", () => {
  test("a slug reported by one machine reaches the row", () => {
    const rows = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], {
      a: [skill("deep-research", { slug: "lib/deep-research", cost: { tokens: 900 } as never })],
      b: [skill("deep-research")],
    });
    expect(rowFor(rows, "skill:deep-research").slug).toBe("lib/deep-research");
  });

  test("two machines spelling one skill differently still find their slug", () => {
    // The join is the case-folded key. A key spelled a second way here — the
    // separator, the folding, anything — silently loses the slug on exactly
    // this input, and nothing else on the page would notice.
    const rows = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], {
      a: [skill("Domain-Search")],
      b: [skill("domain-search", { slug: "lib/domain-search", marketplace: "official" })],
    });
    expect(rows).toHaveLength(1);
    const row = rowFor(rows, "skill:domain-search");
    expect(row.identity).toBe("Domain-Search"); // first spelling displayed
    expect(row.slug).toBe("lib/domain-search");
    expect(row.marketplace).toBe("official");
  });

  test("a later blank never erases an earlier value", () => {
    const rows = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], {
      a: [skill("deep-research", { slug: "lib/deep-research" })],
      b: [skill("deep-research")],
    });
    expect(rowFor(rows, "skill:deep-research").slug).toBe("lib/deep-research");
  });
});

// --------------------------------------------------------------- driftKeys

describe("driftKeys escalate a verdict, they never invent one", () => {
  const devices = [machine("a", "MacBook"), machine("b", "Studio")];
  const reports = { a: [skill("deep-research")], b: [skill("deep-research")] };

  test("an in-sync row named by the store becomes drift", () => {
    const rows = buildFleetRows(devices, reports, new Set(["skill:deep-research"]));
    expect(rowFor(rows, "skill:deep-research").status).toBe("drift");
  });

  test("a not_comparable row is left alone — one machine cannot disagree with itself", () => {
    const rows = buildFleetRows([machine("a", "MacBook")], { a: [skill("deep-research")] }, new Set(["skill:deep-research"]));
    expect(rowFor(rows, "skill:deep-research").status).toBe("not_comparable");
  });
});

// ------------------------------------------------------- the dormant split

describe("two builds nobody is running is not agreement", () => {
  const devices = [machine("a", "MacBook"), machine("b", "Studio")];
  const reports = {
    a: [plugin("x@official", { enabled: false, sha: SHA_A })],
    b: [plugin("x@official", { enabled: false, sha: SHA_B })],
  };
  const rows = buildFleetRows(devices, reports);
  const row = rowFor(rows, "plugin:x@official");

  test("the shared verdict stays what it is: nobody is living with the difference", () => {
    // Deliberately unchanged. `cast cap status` and the stored summary read the
    // same field, and a UI opinion must not move a number three runtimes share.
    expect(row.status).toBe("in_sync");
    expect(row.pinDrift).toBe(false);
    expect(row.pins).toEqual([SHA_A, SHA_B]);
  });

  test("but the grid files it under needs attention, never under in sync", () => {
    expect(needsAttention(row)).toBe(true);
  });

  test("and the pin drift stat reaches it, so the header cannot contradict the grid", () => {
    expect(FLEET_FILTERS.mismatched(row)).toBe(true);
    expect(summarizeFleet(rows, devices, reports).mismatched).toBe(1);
    // Still not drift: that stat mirrors the shared diff.
    expect(summarizeFleet(rows, devices, reports).drift).toBe(0);
  });

  test("switched off everywhere at the SAME pin is genuine agreement", () => {
    const same = buildFleetRows(devices, {
      a: [plugin("x@official", { enabled: false, sha: SHA_A })],
      b: [plugin("x@official", { enabled: false, sha: SHA_A })],
    });
    const quiet = rowFor(same, "plugin:x@official");
    expect(needsAttention(quiet)).toBe(false);
    expect(FLEET_FILTERS.mismatched(quiet)).toBe(false);
  });
});

// ----------------------------------------------------------- the pin gate

describe("a cell prints its pin exactly when the pin is news", () => {
  const devices = [machine("a", "MacBook"), machine("b", "Studio")];

  test("agreement prints no pin — the column would be a wall of the same sha", () => {
    const rows = buildFleetRows(devices, {
      a: [plugin("x@official", { sha: SHA_A })],
      b: [plugin("x@official", { sha: SHA_A })],
    });
    const row = rowFor(rows, "plugin:x@official");
    expect(row.cells.map((c) => pinIsNews(row, c))).toEqual([false, false]);
  });

  test("a machine behind on a sha prints it, and so does the majority", () => {
    const rows = buildFleetRows(devices, {
      a: [plugin("x@official", { sha: SHA_A })],
      b: [plugin("x@official", { sha: SHA_B })],
    });
    const row = rowFor(rows, "plugin:x@official");
    // Both sides: "you are on 1111111" is only useful next to what the other
    // machine is on.
    expect(row.cells.map((c) => pinIsNews(row, c))).toEqual([true, true]);
  });

  test("a switched-off machine holding a WEAKER pin kind still shows it", () => {
    // The half-fixed case. `row.pins` is filtered to `pinKind`, so a version on
    // a row compared by sha is missing from it however far behind it is — and
    // the cell would draw a bare slash with the only identifier it has hidden,
    // on a row already badged drift.
    const rows = buildFleetRows(devices, {
      a: [plugin("x@official", { sha: SHA_A })],
      b: [plugin("x@official", { enabled: false, version: "2.0.0" })],
    });
    const row = rowFor(rows, "plugin:x@official");
    expect(row.status).toBe("drift");
    expect(row.pinKind).toBe("sha");
    expect(row.pins).toEqual([SHA_A]); // b's version never entered the list
    expect(pinIsNews(row, row.byDevice.b)).toBe(true);
    expect(row.byDevice.b.pin).toBe("2.0.0");
  });

  test("a cell with no pin at all prints its scope instead", () => {
    const rows = buildFleetRows(devices, {
      a: [skill("deep-research", { scope: "project" })],
      b: [skill("deep-research")],
    });
    const row = rowFor(rows, "skill:deep-research");
    expect(row.cells.map((c) => pinIsNews(row, c))).toEqual([false, false]);
  });
});

// -------------------------------------------------------- broken installs

describe("broken is a fact about one machine, not a disagreement", () => {
  const cell = (over: Partial<FleetDiffCell>): FleetDiffCell => ({
    deviceId: "a",
    status: "same",
    present: true,
    enabled: true,
    scopes: ["user"],
    ...over,
  });

  test("declared and never downloaded", () => {
    expect(isBroken(cell({ installed: false }))).toBe(true);
  });

  test("downloaded and switched off is an offer, not a break", () => {
    expect(isBroken(cell({ enabled: false, installed: true, status: "disabled" }))).toBe(false);
  });

  test("a kind that never reports `installed` is never broken", () => {
    // Undefined means the machine did not say. Only an explicit `false` is
    // evidence, or every skill on every machine would badge red.
    expect(isBroken(cell({ installed: undefined }))).toBe(false);
  });

  test("it reaches the top of the page on a fleet of one, where drift cannot", () => {
    const devices = [machine("a", "MacBook")];
    const reports = { a: [plugin("x@official", { installed: false })] };
    const rows = buildFleetRows(devices, reports);
    const row = rowFor(rows, "plugin:x@official");
    expect(row.status).toBe("not_comparable");
    expect(needsAttention(row)).toBe(true);
    expect(summarizeFleet(rows, devices, reports)).toMatchObject({ broken: 1, drift: 0, comparable: false });
  });
});

// ----------------------------------------------------------- the counters

describe("no stat can show a different number of rows than the view it opens", () => {
  const devices = [machine("a", "MacBook"), machine("b", "Studio"), machine("c", "m1", null)];
  const reports = {
    a: [
      skill("only-here"),
      plugin("behind@official", { sha: SHA_A }),
      plugin("off-here@official", { enabled: false }),
      plugin("no-bytes@official", { installed: false }),
    ],
    b: [
      plugin("behind@official", { sha: SHA_B }),
      plugin("off-here@official"),
      plugin("no-bytes@official", { installed: true }),
    ],
  };
  const rows = buildFleetRows(devices, reports);
  const counts = summarizeFleet(rows, devices, reports);

  test("every count is its filter applied to the same rows", () => {
    for (const [name, predicate] of Object.entries(FLEET_FILTERS)) {
      if (name === "all") continue;
      expect([name, counts[name as keyof typeof counts]]).toEqual([name, rows.filter(predicate).length]);
    }
  });

  test("the roster numbers separate reporting from silent", () => {
    expect(counts).toMatchObject({ devices: 3, reporting: 2, silent: 1, comparable: true });
  });

  test("a silent machine never counts as missing it", () => {
    // `absentCount` is reporting machines only. Counting the silent one would
    // make every row on the page read "missing somewhere".
    expect(rowFor(rows, "plugin:behind@official").absentCount).toBe(0);
    expect(FLEET_FILTERS.missing(rowFor(rows, "plugin:behind@official"))).toBe(false);
  });
});

// ------------------------------------------------------------ the catalog

describe("the fleet is a real catalog of what you already have", () => {
  const rows = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], {
    a: [plugin("code-simplifier@official", { sha: SHA_A, marketplace: "official", scope: "project" })],
    b: [plugin("code-simplifier@official", { version: "2.0.0", marketplace: "official", enabled: false, installed: true })],
  });

  test("a card keys on the row key, so clicking back lands on the same row", () => {
    const entry = catalogFromFleet(rows)[0];
    expect(entry.slug).toBe("plugin:code-simplifier@official");
    expect(entry.name).toBe("code-simplifier@official");
  });

  test("each install site carries how it got there", () => {
    const [a, b] = catalogFromFleet(rows)[0].installs;
    expect(a).toMatchObject({ deviceId: "a", scope: "project", enabled: true, sha: SHA_A });
    expect(a.version).toBeUndefined(); // a sha is not a version
    expect(b).toMatchObject({ deviceId: "b", enabled: false, installedOnly: true, version: "2.0.0" });
    expect(b.sha).toBeUndefined();
  });

  test("a machine that does not have it is not an install site", () => {
    const sparse = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], {
      a: [skill("only-here")],
      b: [],
    });
    expect(catalogFromFleet(sparse)[0].installs.map((i) => i.deviceId)).toEqual(["a"]);
  });
});

describe("a public catalog entry finds its real installs", () => {
  const rows = buildFleetRows([machine("a", "MacBook"), machine("b", "Studio")], {
    a: [plugin("code-simplifier@official", { marketplace: "official" })],
    b: [skill("deep-research")],
  });
  const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
    slug: "mkt/official/code-simplifier",
    name: "code-simplifier",
    kind: "plugin",
    installs: [],
    ...over,
  });

  test("the bare name matches the machine's name@marketplace spelling", () => {
    const [out] = withFleetInstalls([entry({ marketplace: "official" })], rows);
    expect(out.installs.map((i) => i.deviceId)).toEqual(["a"]);
  });

  test("two marketplaces publishing one name are not the same capability", () => {
    // The failure this rules out is a silent cross-attach: the card would claim
    // the plugin is installed on a machine that has a DIFFERENT plugin of the
    // same name.
    const [out] = withFleetInstalls([entry({ marketplace: "acme" })], rows);
    expect(out.installs).toEqual([]);
  });

  test("the marketplace segment of a slug is not a name", () => {
    // `code-simplifier@acme` must not answer to a catalog row called `acme`.
    const [out] = withFleetInstalls([entry({ slug: "mkt/official", name: "official" })], rows);
    expect(out.installs).toEqual([]);
  });

  test("a kind mismatch never matches", () => {
    const [out] = withFleetInstalls([entry({ kind: "skill", marketplace: "official" })], rows);
    expect(out.installs).toEqual([]);
  });

  test("an entry that already knows its installs is left alone", () => {
    const seeded = entry({
      marketplace: "official",
      installs: [{ deviceId: "z", scope: "user", enabled: true }],
    });
    expect(withFleetInstalls([seeded], rows)[0].installs).toBe(seeded.installs);
  });
});

// -------------------------------------------------------------- the column

describe("the short pin", () => {
  test("a 40-char sha becomes seven, which is enough to tell two installs apart", () => {
    expect(shortPin(SHA_A)).toBe("1111111");
  });

  test("a version is never truncated — 2.0.0 shortened is a lie", () => {
    expect(shortPin("2.0.0")).toBe("2.0.0");
  });

  test("a url is left whole", () => {
    expect(shortPin("https://mcp.example.com/sse")).toBe("https://mcp.example.com/sse");
  });

  test("nothing in, nothing out", () => {
    expect(shortPin(undefined)).toBeUndefined();
    expect(shortPin("")).toBeUndefined();
  });
});

// ------------------------------------------------------------ degenerate

describe("total, like the diff under it", () => {
  test("no devices", () => {
    expect(buildFleetRows([], {})).toEqual([]);
    expect(summarizeFleet([], [], {})).toMatchObject({ devices: 0, reporting: 0, comparable: false });
  });

  test("a report the roster has no device for is ignored, not a phantom column", () => {
    const rows = buildFleetRows([machine("a", "MacBook")], { a: [skill("x")], ghost: [skill("y")] });
    expect(rows.map((r) => r.key)).toEqual(["skill:x"]);
  });

  test("an entry with no name is dropped rather than keyed on a blank", () => {
    const rows = buildFleetRows([machine("a", "MacBook")], { a: [skill("  "), skill("real")] });
    expect(rows.map((r) => r.key)).toEqual(["skill:real"]);
  });

  test("a kind the diff does not rank is dropped, and takes nothing with it", () => {
    const rows = buildFleetRows([machine("a", "MacBook")], {
      a: [item({ kind: "wormhole", name: "x" }), skill("real")],
    });
    expect(rows.map((r) => r.key)).toEqual(["skill:real"]);
  });
});

// ------------------------------------------------- the store-to-UI drift join

// The matrix folds the store's own drift verdict into its own:
//
//     status = row.status === "in_sync" && driftKeys.has(row.key) ? "drift" : row.status
//
// That union is only worth anything if both sides name a capability the same
// way. They did not: the matrix used to key rows as `item.slug ?? <kind>:<name>`
// — not case folded, no marketplace — while the store keys
// `<kind>:<identity lowercased>`. So `driftKeys.has(row.key)` almost never
// matched and the store's verdict was silently discarded.
//
// Both sides now go through the same two shared functions, and these tests hold
// them to it. Each asserts on a key the OLD scheme could not have produced.
describe("the store's drift verdict reaches the grid", () => {
  const devices = [machine("a", "MacBook"), machine("b", "Studio")];

  test("a plugin's row key is <kind>:<name@marketplace>, lowercased", () => {
    const rows = buildFleetRows(devices, {
      a: [plugin("Code-Simplifier", { marketplace: "Claude-Plugins-Official" })],
      b: [plugin("Code-Simplifier", { marketplace: "Claude-Plugins-Official" })],
    });
    // The old scheme produced `plugin:Code-Simplifier` — wrong case, no
    // marketplace — so a store key could never match it.
    expect(rows.map((r) => r.key)).toEqual(["plugin:code-simplifier@claude-plugins-official"]);
  });

  test("a store drift key flips an otherwise in-sync row", () => {
    const same = { a: [skill("deploy")], b: [skill("deploy")] };
    const withoutStore = buildFleetRows(devices, same);
    expect(rowFor(withoutStore, "skill:deploy").status).toBe("in_sync");

    const withStore = buildFleetRows(devices, same, new Set(["skill:deploy"]));
    expect(rowFor(withStore, "skill:deploy").status).toBe("drift");
  });

  test("the join survives case and marketplace differences in the store's key", () => {
    // The store lowercases the identity when it builds its key. If the matrix
    // kept the reported casing, this union would miss — which is precisely the
    // shape of the original bug.
    const rows = buildFleetRows(
      devices,
      {
        a: [plugin("Frontend-Design", { marketplace: "Official" })],
        b: [plugin("Frontend-Design", { marketplace: "Official" })],
      },
      new Set(["plugin:frontend-design@official"]),
    );
    expect(rowFor(rows, "plugin:frontend-design@official").status).toBe("drift");
  });

  test("one machine knowing a library slug does not split the row in two", () => {
    // Matching lands on one machine before another. Keying on the slug would
    // make the same capability two rows and manufacture drift out of our own
    // bookkeeping — the store's comment forbids it for exactly this reason.
    const rows = buildFleetRows(devices, {
      a: [skill("deploy", { slug: "mkt/acme/deploy" })],
      b: [skill("deploy")],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("skill:deploy");
    expect(rows[0].status).toBe("in_sync");
    // The slug still reaches the row for display — it just is not the identity.
    expect(rows[0].slug).toBe("mkt/acme/deploy");
  });

  test("a drift key that matches nothing is inert, not an invented row", () => {
    const rows = buildFleetRows(devices, { a: [skill("deploy")], b: [skill("deploy")] },
      new Set(["skill:does-not-exist"]));
    expect(rows).toHaveLength(1);
    expect(rowFor(rows, "skill:deploy").status).toBe("in_sync");
  });
});
