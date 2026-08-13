import { beforeEach, describe, expect, it } from "bun:test";
import {
  CAPABILITY_CATALOG_CACHE_MAX,
  CAPABILITY_CLIENT_SYNC_REGISTRY,
  CAPABILITY_IDB_STORES,
  CAPABILITY_REPORT_STALE_MS,
  CAPABILITY_SYNC_REGISTRY,
  EMPTY_CAPABILITY_CATALOG,
  _resetCapabilityMemo,
  capabilityIdentity,
  capabilityRowKey,
  capabilityStateRowSig,
  capabilityStateSyncOpts,
  capabilityStateWakeSig,
  createCapabilitySlice,
  isCapabilityReportStale,
  parseCapabilityEntries,
  selectCachedCatalog,
  selectCapabilityBrokenCount,
  selectCapabilityDrift,
  selectCapabilityDriftCount,
  selectCapabilityIndex,
  selectCapabilityRollups,
  selectDeviceCapabilityRollup,
  selectDeviceCapabilityRows,
  type CapabilitySliceData,
  type CapabilityStateRow,
} from "../capabilities";

// A `capability_state` row as the wire actually carries it.
//
// `entries_json` is `JSON.stringify({ items, marketplaces })` — the exact string
// `normalizeReport` stores (packages/convex/convex/capabilities.ts) and the exact
// shape `Inventory` declares (packages/cli/src/capabilities/inventory.ts). Tests
// that invent a friendlier envelope pass while every real machine reads as
// unreadable, which is how the envelope bug survived a green suite.
function stateRow(
  id: string,
  deviceId: string,
  items: any[],
  extra: Partial<CapabilityStateRow> & { marketplaces?: any[] } = {},
): CapabilityStateRow {
  const { marketplaces = [], ...rest } = extra;
  return {
    _id: id,
    device_id: deviceId,
    client: "claude_code",
    scope_key: "",
    entries_json: JSON.stringify({ items, marketplaces }),
    entries_hash: `h-${id}-${items.length}-${marketplaces.length}`,
    entry_count: items.length + marketplaces.length,
    reported_at: 1_000,
    ...rest,
  };
}

// The store passes `sync` from the mutative middleware, which only TAGS the
// function it is handed; the body is an ordinary draft recipe either way. A test
// drives the recipe directly, so identity is the faithful stand-in.
const identity = <T extends (...args: any[]) => any>(fn: T): T => fn;

/**
 * A skill as a daemon reports one.
 *
 * No `installed` key, on purpose. `installed` is plugins only — the scanner sets
 * it from `installed_plugins.json` and nothing else has an install step to fail
 * — so every skill, command, subagent and MCP server on every machine arrives
 * without it. A helper that quietly adds `installed: true` is what let a reader
 * that treats the field as a boolean look correct.
 */
function entry(name: string, over: Record<string, any> = {}) {
  return { kind: "skill", name, scope: "user", enabled: true, ...over };
}

/** A plugin, which is the one kind that really does carry `installed`. */
function plugin(name: string, over: Record<string, any> = {}) {
  return {
    kind: "plugin",
    name,
    scope: "user",
    enabled: true,
    installed: true,
    ...over,
  };
}

function collection(...rows: CapabilityStateRow[]): CapabilitySliceData {
  const capabilityState: Record<string, CapabilityStateRow> = {};
  for (const row of rows) capabilityState[row._id] = row;
  return { capabilityState, capabilityCatalog: EMPTY_CAPABILITY_CATALOG };
}

beforeEach(() => {
  _resetCapabilityMemo();
});

// ── Reading a machine's inventory ───────────────────────────────────────────

describe("parseCapabilityEntries", () => {
  it("reads the envelope the server actually stores", () => {
    const parsed = parseCapabilityEntries(stateRow("r1", "d1", [entry("pdf"), entry("sql")]));
    expect(parsed.entries.map((e) => e.name)).toEqual(["pdf", "sql"]);
    expect(parsed.unreadableEntries).toBe(0);
    expect(parsed.unreadable).toBe(false);
    expect(parsed.withheld).toBe(false);
  });

  it("still reads a bare array from a client that only reports capabilities", () => {
    // The server accepts both shapes; a reader stricter than the writer turns
    // every machine on the fleet into an unreadable one.
    const row: CapabilityStateRow = {
      ...stateRow("r1", "d1", []),
      entries_json: JSON.stringify([entry("pdf")]),
      entry_count: 1,
    };
    const parsed = parseCapabilityEntries(row);
    expect(parsed.entries.map((e) => e.name)).toEqual(["pdf"]);
    expect(parsed.unreadable).toBe(false);
  });

  it("keeps the marketplaces the envelope carries", () => {
    const parsed = parseCapabilityEntries(
      stateRow("r1", "d1", [entry("pdf")], {
        marketplaces: [{ name: "official", repo: "anthropics/marketplace", scope: "user" }, { repo: "no-name" }],
      }),
    );
    expect(parsed.marketplaces).toEqual([
      { name: "official", repo: "anthropics/marketplace", scope: "user" },
    ]);
    // A marketplace with no name cannot be keyed, so it counts as unread rather
    // than vanishing silently.
    expect(parsed.unreadableEntries).toBe(1);
  });

  it("tells an empty scope apart from one it could not read", () => {
    const empty = parseCapabilityEntries({ ...stateRow("r1", "d1", []), entry_count: 0 });
    expect(empty.entries).toEqual([]);
    expect(empty.unreadable).toBe(false);
    expect(empty.withheld).toBe(false);

    const broken = parseCapabilityEntries({ ...stateRow("r2", "d1", []), entries_json: "{oops" });
    expect(broken.unreadable).toBe(true);

    // Valid JSON with no items array is just as unreadable as invalid JSON.
    const wrongShape = parseCapabilityEntries({ ...stateRow("r3", "d1", []), entries_json: '{"a":1}' });
    expect(wrongShape.unreadable).toBe(true);
  });

  it("tells a withheld payload apart from an empty machine, by either signal", () => {
    // The server elided it for its response byte budget and said so.
    const flagged = parseCapabilityEntries({
      ...stateRow("r1", "d1", [entry("pdf")]),
      entries_json: undefined,
      entries_omitted: true,
    });
    expect(flagged.withheld).toBe(true);
    expect(flagged.unreadable).toBe(false);

    // A metadata-only read carries no flag at all — only the count betrays that
    // there is an inventory behind the gap.
    const metadataOnly = parseCapabilityEntries({
      ...stateRow("r2", "d1", []),
      entries_json: undefined,
      entry_count: 148,
    });
    expect(metadataOnly.withheld).toBe(true);

    // No payload, no flag, no count: a machine that scanned and found nothing.
    const reallyEmpty = parseCapabilityEntries({
      ...stateRow("r3", "d1", []),
      entries_json: undefined,
      entry_count: 0,
    });
    expect(reallyEmpty.withheld).toBe(false);
    expect(reallyEmpty.unreadable).toBe(false);
  });

  it("drops the entries it cannot read and counts them, keeping the rest", () => {
    const parsed = parseCapabilityEntries(
      stateRow("r1", "d1", [entry("pdf"), null, { name: "no-kind" }, { kind: "skill" }, 7, entry("sql")]),
    );
    expect(parsed.entries.map((e) => e.name)).toEqual(["pdf", "sql"]);
    expect(parsed.unreadableEntries).toBe(4);
    expect(parsed.unreadable).toBe(false);
  });

  it("accepts a kind the shared enum has not learned yet", () => {
    // Forward compatibility is the point: a machine already reporting a new kind
    // must render, not vanish, on a client shipped before the enum grew.
    const parsed = parseCapabilityEntries(stateRow("r1", "d1", [entry("thing", { kind: "gadget" })]));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].kind).toBe("gadget");
  });

  it("parses each row object once and re-parses a changed row", () => {
    const row = stateRow("r1", "d1", [entry("pdf")]);
    const first = parseCapabilityEntries(row);
    expect(parseCapabilityEntries(row)).toBe(first);

    // The sync layer hands back a NEW object when a field moved.
    const changed = { ...row, entries_json: JSON.stringify({ items: [entry("pdf"), entry("sql")], marketplaces: [] }) };
    const second = parseCapabilityEntries(changed);
    expect(second).not.toBe(first);
    expect(second.entries).toHaveLength(2);
  });

  it("survives a missing row", () => {
    expect(parseCapabilityEntries(undefined).entries).toEqual([]);
    expect(parseCapabilityEntries(null).unreadable).toBe(false);
  });

  it("hands back a shared empty result nobody can grow by accident", () => {
    // One object answers for every empty, unreadable and withheld row on the
    // fleet, so a push onto it would be an inventory appearing out of nowhere on
    // every one of them at once.
    for (const row of [
      { ...stateRow("r1", "d1", []), entries_json: undefined, entry_count: 0 },
      { ...stateRow("r2", "d1", []), entries_json: "{oops" },
      { ...stateRow("r3", "d1", []), entries_json: undefined, entries_omitted: true },
    ]) {
      const parsed = parseCapabilityEntries(row);
      expect(() => (parsed.entries as any).push(entry("ghost"))).toThrow();
    }
  });
});

// ── Identity ────────────────────────────────────────────────────────────────

describe("capability identity", () => {
  it("composes a plugin's marketplace into its identity", () => {
    // Two plugins of the same bare name from different marketplaces are two
    // different things and must not collide into one row.
    expect(capabilityIdentity("plugin", "deploy", { marketplace: "official" })).toBe("deploy@official");
    expect(capabilityIdentity("plugin", "deploy@official", { marketplace: "other" })).toBe("deploy@official");
    expect(capabilityIdentity("plugin", "deploy")).toBe("deploy");
    // Everything else is already the name the ecosystem uses.
    expect(capabilityIdentity("skill", "pdf", { marketplace: "official" })).toBe("pdf");
    expect(capabilityIdentity("skill", "   ")).toBeUndefined();
  });

  it("folds case into the key and not into the display identity", () => {
    expect(capabilityRowKey("skill", "Domain-Search")).toBe("skill:domain-search");
  });

  it("keeps two marketplaces' plugins on separate rows", () => {
    const state = collection(
      stateRow("r1", "laptop", [plugin("deploy", { meta: { marketplace: "official" } })]),
      stateRow("r2", "desktop", [plugin("deploy", { meta: { marketplace: "scratch" } })]),
    );
    const rows = selectCapabilityDrift(state);
    expect(rows.map((r) => r.identity).sort()).toEqual(["deploy@official", "deploy@scratch"]);
  });

  it("treats two spellings of one skill as one row rather than inventing drift", () => {
    const state = collection(
      stateRow("r1", "laptop", [entry("Domain-Search")]),
      stateRow("r2", "desktop", [entry("domain-search")]),
    );
    const rows = selectCapabilityDrift(state);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("skill:domain-search");
    // The display name is the first one reported, not the folded key.
    expect(rows[0].identity).toBe("Domain-Search");
    expect(rows[0].drifting).toBe(false);
  });
});

// ── Wake signatures ─────────────────────────────────────────────────────────

describe("capability wake signatures", () => {
  it("is inert to a liveness restamp", () => {
    const base = stateRow("r1", "d1", [entry("pdf")]);
    const restamped = { ...base, reported_at: base.reported_at + 60_000 };
    expect(capabilityStateRowSig(restamped)).toBe(capabilityStateRowSig(base));
  });

  it("flips when the inventory hash moves", () => {
    const base = stateRow("r1", "d1", [entry("pdf")]);
    const changed = { ...base, entries_hash: "h-different" };
    expect(capabilityStateRowSig(changed)).not.toBe(capabilityStateRowSig(base));
  });

  it("flips on an error, a conflict, a client version and an applied revision", () => {
    const base = stateRow("r1", "d1", [entry("pdf")]);
    for (const patch of [
      { last_error: "permission denied" },
      { conflicts_json: '[{"path":"~/.claude/skills/pdf"}]' },
      { client_version: "2.1.220" },
      { applied_revision: 4 },
    ]) {
      expect(capabilityStateRowSig({ ...base, ...patch })).not.toBe(capabilityStateRowSig(base));
    }
  });

  it("flips when a payload is withheld, so the view stops drawing a full machine", () => {
    const base = stateRow("r1", "d1", [entry("pdf")]);
    const withheld: CapabilityStateRow = { ...base, entries_json: undefined, entries_omitted: true };
    expect(capabilityStateRowSig(withheld)).not.toBe(capabilityStateRowSig(base));
  });

  it("falls back to the raw payload when a row carries no hash", () => {
    // An older daemon's row: the cheap proxy is gone, so the whole string goes in
    // rather than letting a content change pass unnoticed.
    const base: CapabilityStateRow = { ...stateRow("r1", "d1", [entry("pdf")]), entries_hash: undefined };
    const changed: CapabilityStateRow = {
      ...base,
      entries_json: JSON.stringify({ items: [entry("pdf"), entry("sql")], marketplaces: [] }),
    };
    expect(capabilityStateRowSig(changed)).not.toBe(capabilityStateRowSig(base));
  });

  it("survives a hashless row whose payload never arrived", () => {
    const row: CapabilityStateRow = {
      ...stateRow("r1", "d1", [entry("pdf")]),
      entries_hash: undefined,
      entries_json: undefined,
    };
    expect(() => capabilityStateRowSig(row)).not.toThrow();
  });

  it("collection signature memoizes on the map ref and notices rows arriving", () => {
    const map: Record<string, CapabilityStateRow> = { r1: stateRow("r1", "d1", [entry("pdf")]) };
    const sig = capabilityStateWakeSig(map);
    expect(capabilityStateWakeSig(map)).toBe(sig);

    const grown = { ...map, r2: stateRow("r2", "d2", [entry("pdf")]) };
    expect(capabilityStateWakeSig(grown)).not.toBe(sig);
  });

  it("collection signature is inert to a fleet-wide restamp", () => {
    const map: Record<string, CapabilityStateRow> = {
      r1: stateRow("r1", "d1", [entry("pdf")]),
      r2: stateRow("r2", "d2", [entry("pdf")]),
    };
    const sig = capabilityStateWakeSig(map);
    const ticked: Record<string, CapabilityStateRow> = {
      r1: { ...map.r1, reported_at: 99_999 },
      r2: { ...map.r2, reported_at: 99_999 },
    };
    expect(capabilityStateWakeSig(ticked)).toBe(sig);
  });

  it("handles a missing row without throwing", () => {
    expect(capabilityStateRowSig(undefined)).toBe("none");
  });
});

// ── Per-device rollups ──────────────────────────────────────────────────────

describe("device rollups", () => {
  it("counts a capability once however many clients and scopes report it", () => {
    const state = collection(
      stateRow("r1", "d1", [entry("pdf")]),
      stateRow("r2", "d1", [entry("pdf")], { client: "codex", scope_key: "git:github.com/a/b" }),
    );
    const rollup = selectDeviceCapabilityRollup(state, "d1")!;
    expect(rollup.rowCount).toBe(2);
    expect(rollup.readableRows).toBe(2);
    expect(rollup.total).toBe(1);
    expect(rollup.active).toBe(1);
    expect(rollup.clients).toEqual(["claude_code", "codex"]);
    expect(rollup.scopeKeys).toEqual(["", "git:github.com/a/b"]);
    expect(rollup.byKind).toEqual({ skill: 1 });
  });

  it("reads a skill with no installed flag as working, not as a broken install", () => {
    // `installed` is plugins only. Reading it as a boolean marks every skill on
    // every machine as broken and reports the whole fleet as drifting.
    const state = collection(stateRow("r1", "d1", [entry("pdf"), entry("sql"), entry("docx")]));
    const rollup = selectDeviceCapabilityRollup(state, "d1")!;
    expect(rollup.active).toBe(3);
    expect(rollup.broken).toBe(0);
    expect(selectCapabilityDriftCount(state)).toBe(0);
  });

  it("takes the strongest observation when scopes disagree", () => {
    // Claude Code's own scopes stack rather than override, so the same skill is
    // seen twice; "working somewhere on this machine" is the machine's answer.
    const state = collection(
      stateRow("r1", "d1", [entry("pdf", { enabled: false })]),
      stateRow("r2", "d1", [entry("pdf")], { scope_key: "git:github.com/a/b" }),
    );
    const rollup = selectDeviceCapabilityRollup(state, "d1")!;
    expect(rollup.active).toBe(1);
    expect(rollup.off).toBe(0);
    expect(rollup.total).toBe(1);
  });

  it("separates a broken install from something merely switched off", () => {
    const state = collection(
      stateRow("r1", "d1", [
        plugin("live"),
        plugin("never-fetched", { installed: false }),
        plugin("switched-off", { enabled: false }),
        plugin("declared-off-never-fetched", { enabled: false, installed: false }),
      ]),
    );
    const rollup = selectDeviceCapabilityRollup(state, "d1")!;
    expect(rollup.active).toBe(1);
    expect(rollup.broken).toBe(1);
    expect(rollup.off).toBe(1);
    // Neither switched on nor on disk is not a thing this machine has.
    expect(rollup.total).toBe(3);
  });

  it("keeps the newest report, the furthest-behind revision, and distinct errors", () => {
    const state = collection(
      stateRow("r1", "d1", [entry("pdf")], {
        reported_at: 5_000,
        applied_revision: 9,
        last_error: "permission denied",
      }),
      stateRow("r2", "d1", [entry("sql")], {
        reported_at: 2_000,
        applied_revision: 4,
        last_error: "permission denied",
        client: "codex",
      }),
    );
    const rollup = selectDeviceCapabilityRollup(state, "d1")!;
    expect(rollup.reportedAt).toBe(5_000);
    // A machine is only as converged as its furthest-behind scope.
    expect(rollup.appliedRevision).toBe(4);
    expect(rollup.errors).toEqual(["permission denied"]);
  });

  it("does not count an empty conflict payload as a conflict", () => {
    const state = collection(
      stateRow("r1", "d1", [entry("pdf")], { conflicts_json: "[]" }),
      stateRow("r2", "d1", [entry("sql")], { conflicts_json: '[{"path":"x"}]', client: "codex" }),
    );
    expect(selectDeviceCapabilityRollup(state, "d1")!.conflictRows).toBe(1);
  });

  it("counts unreadable rows, unread entries and the server's own truncation apart", () => {
    const state = collection(
      { ...stateRow("r1", "d1", []), entries_json: "{oops" },
      stateRow("r2", "d1", [entry("pdf"), { kind: "skill" }], { client: "codex", dropped_count: 12 }),
    );
    const rollup = selectDeviceCapabilityRollup(state, "d1")!;
    expect(rollup.unreadableRows).toBe(1);
    expect(rollup.readableRows).toBe(1);
    // An item this client could not read and an entry the server never stored
    // have different causes and different fixes, so they stay different numbers.
    expect(rollup.unreadableEntries).toBe(1);
    expect(rollup.truncatedEntries).toBe(12);
  });

  it("says how much a withheld machine is holding instead of drawing it empty", () => {
    const state = collection({
      ...stateRow("r1", "big", [entry("pdf")]),
      entries_json: undefined,
      entries_omitted: true,
      entry_count: 148,
    });
    const rollup = selectDeviceCapabilityRollup(state, "big")!;
    expect(rollup.withheldRows).toBe(1);
    expect(rollup.readableRows).toBe(0);
    expect(rollup.entryCount).toBe(148);
    expect(rollup.total).toBe(0);
  });

  it("ignores a row with no device and answers nothing for an unknown device", () => {
    const state = collection(
      stateRow("r1", "d1", [entry("pdf")]),
      { ...stateRow("r2", "d1", [entry("sql")]), device_id: "" },
    );
    expect(selectCapabilityRollups(state).map((r) => r.deviceId)).toEqual(["d1"]);
    expect(selectDeviceCapabilityRollup(state, "nope")).toBeUndefined();
    expect(selectDeviceCapabilityRollup(state, "")).toBeUndefined();
  });

  it("lists machines in a stable order", () => {
    const state = collection(
      stateRow("r1", "dz", [entry("pdf")]),
      stateRow("r2", "da", [entry("pdf")]),
    );
    expect(selectCapabilityRollups(state).map((r) => r.deviceId)).toEqual(["da", "dz"]);
  });
});

// ── Drift ───────────────────────────────────────────────────────────────────

describe("drift across the fleet", () => {
  it("finds the machine missing the skill the others run", () => {
    const state = collection(
      stateRow("r1", "laptop", [entry("pdf")]),
      stateRow("r2", "desktop", [entry("pdf")]),
      stateRow("r3", "m1", [entry("sql")]),
    );
    const rows = selectCapabilityDrift(state);
    const pdf = rows.find((r) => r.identity === "pdf")!;
    expect(pdf.activeOn).toEqual(["desktop", "laptop"]);
    expect(pdf.missingOn).toEqual(["m1"]);
    expect(pdf.status).toBe("drift");
    expect(pdf.drifting).toBe(true);
    // The skill only m1 has is not agreement either, so it counts too.
    expect(rows.find((r) => r.identity === "sql")!.status).toBe("unique");
    expect(selectCapabilityDriftCount(state)).toBe(2);
  });

  it("says nothing about a capability every machine runs", () => {
    const state = collection(
      stateRow("r1", "laptop", [entry("pdf")]),
      stateRow("r2", "desktop", [entry("pdf")]),
    );
    expect(selectCapabilityDrift(state).every((r) => r.status === "in_sync")).toBe(true);
    expect(selectCapabilityDriftCount(state)).toBe(0);
  });

  it("treats a settings file that says yes and a disk that says no as drift on its own", () => {
    const state = collection(
      stateRow("r1", "laptop", [plugin("pdf", { installed: false })]),
      stateRow("r2", "desktop", [plugin("pdf", { installed: false })]),
    );
    const pdf = selectCapabilityDrift(state)[0];
    expect(pdf.brokenOn).toEqual(["desktop", "laptop"]);
    expect(pdf.activeOn).toEqual([]);
    // Every machine agrees, so the comparison says in_sync — and it is still
    // broken everywhere, which is what the badge is for.
    expect(pdf.status).toBe("in_sync");
    expect(pdf.drifting).toBe(true);
    expect(selectCapabilityIndex(state).brokenCount).toBe(1);
  });

  it("counts a machine that is merely switched off, not missing", () => {
    const state = collection(
      stateRow("r1", "laptop", [plugin("pdf")]),
      stateRow("r2", "desktop", [plugin("pdf", { enabled: false })]),
    );
    const pdf = selectCapabilityDrift(state)[0];
    expect(pdf.activeOn).toEqual(["laptop"]);
    expect(pdf.offOn).toEqual(["desktop"]);
    expect(pdf.missingOn).toEqual([]);
    expect(pdf.drifting).toBe(true);
  });

  it("does not blame a machine that has never reported", () => {
    // Only devices with rows are in the contest. A machine that is asleep has
    // not lost a skill, and counting it would light the badge for the whole fleet.
    const state = collection(stateRow("r1", "laptop", [entry("pdf")]));
    expect(selectCapabilityIndex(state).deviceIds).toEqual(["laptop"]);
    expect(selectCapabilityDriftCount(state)).toBe(0);
  });

  it("gives no verdict at all on a fleet of one", () => {
    const state = collection(stateRow("r1", "laptop", [entry("pdf"), entry("sql")]));
    const index = selectCapabilityIndex(state);
    expect(index.comparable).toBe(false);
    expect(index.drift.every((r) => r.status === "not_comparable")).toBe(true);
    expect(index.driftCount).toBe(0);
  });

  it("still names a broken install on a fleet of one", () => {
    // There is nothing to compare and there is still something to fix.
    const state = collection(stateRow("r1", "laptop", [plugin("pdf", { installed: false })]));
    const index = selectCapabilityIndex(state);
    expect(index.comparable).toBe(false);
    expect(index.drift[0].status).toBe("not_comparable");
    expect(index.drift[0].drifting).toBe(true);
    expect(index.brokenCount).toBe(1);
    expect(selectCapabilityBrokenCount(state)).toBe(1);
  });

  it("does not blame a machine whose one report we could not read", () => {
    // It has a row, so it is not asleep — but it has told us nothing, and
    // rendering that as "missing every skill on the fleet" is the same
    // fabricated alarm as blaming a sleeping machine.
    const state = collection(
      stateRow("r1", "laptop", [entry("pdf")]),
      stateRow("r2", "desktop", [entry("pdf")]),
      { ...stateRow("r3", "corrupt", []), entries_json: "{oops" },
    );
    const index = selectCapabilityIndex(state);
    expect(index.deviceIds).toEqual(["corrupt", "desktop", "laptop"]);
    expect(index.comparableDeviceIds).toEqual(["desktop", "laptop"]);
    const pdf = index.drift[0];
    expect(pdf.missingOn).toEqual([]);
    expect(pdf.unknownOn).toEqual(["corrupt"]);
    expect(pdf.drifting).toBe(false);
    expect(index.driftCount).toBe(0);
  });

  it("does not blame a machine whose payload the server withheld", () => {
    // The machine with the most installed is the one that blows the response
    // byte budget, so it is exactly the machine at risk of rendering as empty.
    const state = collection(
      stateRow("r1", "laptop", [entry("pdf")]),
      stateRow("r2", "desktop", [entry("pdf")]),
      {
        ...stateRow("r3", "big", []),
        entries_json: undefined,
        entries_omitted: true,
        entry_count: 148,
      },
    );
    const index = selectCapabilityIndex(state);
    expect(index.comparableDeviceIds).toEqual(["desktop", "laptop"]);
    expect(index.drift[0].unknownOn).toEqual(["big"]);
    expect(index.driftCount).toBe(0);
  });

  it("reads a missing enabled flag as present, the way the server does", () => {
    // `normalizeItem` server side is `enabled: raw.enabled !== false`. A reader
    // that demanded the flag would blank every client that does not send one.
    const state = collection(
      stateRow("r1", "laptop", [{ kind: "skill", name: "pdf", scope: "user" }]),
      stateRow("r2", "desktop", [entry("pdf")]),
    );
    expect(selectCapabilityDrift(state)[0].activeOn).toEqual(["desktop", "laptop"]);
  });

  it("keeps a partly readable machine in the comparison, and says it is partial", () => {
    // The trade named in `CapabilityIndex.comparableDeviceIds`: one withheld
    // project scope must not erase the machine, so the machine can be shown as
    // missing something the withheld row held. The rollup is what says so.
    const state = collection(
      stateRow("r1", "laptop", [entry("pdf")]),
      stateRow("r2", "desktop", [entry("pdf")]),
      stateRow("r3", "desktop", [entry("sql")], {
        scope_key: "git:github.com/a/b",
        entries_json: undefined,
        entries_omitted: true,
        entry_count: 40,
      }),
    );
    const index = selectCapabilityIndex(state);
    expect(index.comparableDeviceIds).toEqual(["desktop", "laptop"]);
    expect(index.devices.desktop.readableRows).toBe(1);
    expect(index.devices.desktop.withheldRows).toBe(1);
    expect(index.devices.desktop.entryCount).toBe(41);
  });

  it("puts a plugin's commit sha on the second axis", () => {
    const state = collection(
      stateRow("r1", "laptop", [plugin("deploy", { meta: { marketplace: "official", sha: "aaa" } })]),
      stateRow("r2", "desktop", [plugin("deploy", { meta: { marketplace: "official", sha: "aaa" } })]),
      stateRow("r3", "m1", [plugin("deploy", { meta: { marketplace: "official", sha: "bbb" } })]),
    );
    const row = selectCapabilityDrift(state)[0];
    expect(row.identity).toBe("deploy@official");
    expect(row.activeOn).toEqual(["desktop", "laptop", "m1"]);
    // Present and switched on everywhere, and still not the same thing.
    expect(row.pins).toEqual(["aaa", "bbb"]);
    expect(row.baselinePin).toBe("aaa");
    expect(row.pinByDevice.m1).toBe("bbb");
    expect(row.pinDrift).toBe(true);
    expect(row.status).toBe("drift");
  });

  it("does not call a stdio MCP server's command line a pin", () => {
    // The command embeds absolute paths that differ on every machine for the
    // same server; comparing those reports drift on a synchronised fleet.
    const state = collection(
      stateRow("r1", "laptop", [
        entry("db", { kind: "mcp", meta: { command: "node /Users/ashot/mcp/db.js" } }),
      ]),
      stateRow("r2", "desktop", [
        entry("db", { kind: "mcp", meta: { command: "node /home/build/mcp/db.js" } }),
      ]),
    );
    const row = selectCapabilityDrift(state)[0];
    expect(row.pins).toEqual([]);
    expect(row.pinDrift).toBe(false);
    expect(row.drifting).toBe(false);
  });

  it("counts a remote MCP server's url as a pin, trailing slash and all", () => {
    const state = collection(
      stateRow("r1", "laptop", [entry("api", { kind: "mcp", meta: { url: "https://x.dev/mcp/" } })]),
      stateRow("r2", "desktop", [entry("api", { kind: "mcp", meta: { url: "https://x.dev/mcp" } })]),
      stateRow("r3", "m1", [entry("api", { kind: "mcp", meta: { url: "https://old.dev/mcp" } })]),
    );
    const row = selectCapabilityDrift(state)[0];
    expect(row.pins).toEqual(["https://old.dev/mcp", "https://x.dev/mcp"]);
    expect(row.pinDrift).toBe(true);
  });

  it("folds marketplaces into the same grid, because they explain missing plugins", () => {
    const state = collection(
      stateRow("r1", "laptop", [plugin("deploy", { meta: { marketplace: "official" } })], {
        marketplaces: [{ name: "official", repo: "anthropics/marketplace" }],
      }),
      stateRow("r2", "desktop", [], { marketplaces: [] }),
    );
    const rows = selectCapabilityDrift(state);
    const market = rows.find((r) => r.kind === "marketplace")!;
    expect(market.key).toBe("marketplace:official");
    expect(market.activeOn).toEqual(["laptop"]);
    expect(market.missingOn).toEqual(["desktop"]);
    expect(market.pins).toEqual(["anthropics/marketplace"]);
    expect(market.drifting).toBe(true);
  });

  it("carries the slug without keying on it", () => {
    // A slug is set only once an entry has been matched to a library capability.
    // Keying on it would split one capability into two rows the moment matching
    // lands on one machine and not yet on another.
    const state = collection(
      stateRow("r1", "laptop", [entry("pdf", { slug: "mkt/official/pdf", description: "Read PDFs" })]),
      stateRow("r2", "desktop", [entry("pdf")]),
    );
    const rows = selectCapabilityDrift(state);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("skill:pdf");
    expect(rows[0].slug).toBe("mkt/official/pdf");
    // A machine that omitted the description must not erase the one another sent.
    expect(rows[0].description).toBe("Read PDFs");
    expect(rows[0].drifting).toBe(false);
  });

  it("keeps a kind-and-name entry apart from an unrelated kind of the same name", () => {
    const state = collection(
      stateRow("r1", "laptop", [entry("deploy"), entry("deploy", { kind: "subagent" })]),
      stateRow("r2", "desktop", [entry("deploy"), entry("deploy", { kind: "subagent" })]),
    );
    expect(selectCapabilityDrift(state).map((r) => r.key)).toEqual(["skill:deploy", "subagent:deploy"]);
  });

  it("records which clients saw it", () => {
    const state = collection(
      stateRow("r1", "laptop", [entry("pdf")]),
      stateRow("r2", "laptop", [entry("pdf")], { client: "codex" }),
    );
    expect(selectCapabilityDrift(state)[0].clients).toEqual(["claude_code", "codex"]);
  });

  it("orders rows by key so a list does not reshuffle on every push", () => {
    const state = collection(stateRow("r1", "laptop", [entry("zeta"), entry("alpha")]));
    expect(selectCapabilityDrift(state).map((r) => r.identity)).toEqual(["alpha", "zeta"]);
  });
});

// ── Derived, never stored ───────────────────────────────────────────────────

describe("derived values stay derived", () => {
  it("holds only the two raw keys in state — no rollup, no drift count", () => {
    const slice = createCapabilitySlice(identity);
    const dataKeys = Object.entries(slice)
      .filter(([, v]) => typeof v !== "function")
      .map(([k]) => k)
      .sort();
    expect(dataKeys).toEqual(["capabilityCatalog", "capabilityState"]);
  });

  it("recomputes only when the collection ref changes", () => {
    const state = collection(stateRow("r1", "d1", [entry("pdf")]));
    const first = selectCapabilityIndex(state);
    expect(selectCapabilityIndex(state)).toBe(first);

    const next = collection(stateRow("r1", "d1", [entry("pdf")]), stateRow("r2", "d2", [entry("pdf")]));
    const second = selectCapabilityIndex(next);
    expect(second).not.toBe(first);
    expect(second.deviceIds).toEqual(["d1", "d2"]);
  });

  it("answers for an empty or missing collection", () => {
    expect(selectCapabilityIndex({ capabilityState: {} }).drift).toEqual([]);
    expect(selectCapabilityIndex({} as any).driftCount).toBe(0);
  });
});

// ── One machine's rows ──────────────────────────────────────────────────────

describe("selectDeviceCapabilityRows", () => {
  it("returns one machine's rows, newest report first", () => {
    const state = collection(
      stateRow("r1", "d1", [entry("pdf")], { reported_at: 1_000 }),
      stateRow("r2", "d1", [entry("sql")], { reported_at: 9_000, client: "codex" }),
      stateRow("r3", "d2", [entry("pdf")]),
    );
    expect(selectDeviceCapabilityRows(state, "d1").map((r) => r._id)).toEqual(["r2", "r1"]);
    expect(selectDeviceCapabilityRows(state, "nope")).toEqual([]);
    expect(selectDeviceCapabilityRows(state, "")).toEqual([]);
  });

  it("breaks a tie on client then scope so the order never flickers", () => {
    const state = collection(
      stateRow("r1", "d1", [], { client: "codex", scope_key: "b" }),
      stateRow("r2", "d1", [], { client: "claude_code", scope_key: "b" }),
      stateRow("r3", "d1", [], { client: "claude_code", scope_key: "a" }),
    );
    expect(selectDeviceCapabilityRows(state, "d1").map((r) => r._id)).toEqual(["r3", "r2", "r1"]);
  });
});

// ── Freshness ───────────────────────────────────────────────────────────────

describe("isCapabilityReportStale", () => {
  it("takes the clock as an argument so a coarse ticker can drive it", () => {
    const row = { reported_at: 1_000_000 };
    expect(isCapabilityReportStale(row, 1_000_000 + CAPABILITY_REPORT_STALE_MS - 1)).toBe(false);
    expect(isCapabilityReportStale(row, 1_000_000 + CAPABILITY_REPORT_STALE_MS + 1)).toBe(true);
  });

  it("treats a row it cannot date as stale, never as fresh", () => {
    expect(isCapabilityReportStale(undefined, 1)).toBe(true);
    expect(isCapabilityReportStale({ reported_at: undefined } as any, 1)).toBe(true);
  });
});

// ── Catalog cache ───────────────────────────────────────────────────────────

describe("catalog cache", () => {
  const cap = (slug: string) => ({ slug, kind: "skill" as const, source: "marketplace" as const, name: slug });

  function draft(): CapabilitySliceData {
    return { capabilityState: {}, capabilityCatalog: EMPTY_CAPABILITY_CATALOG };
  }

  // The middleware only TAGS these functions; the body is an ordinary draft
  // recipe, so a test drives it the same way the store does.
  const slice = createCapabilitySlice(identity);
  const cache = (state: CapabilitySliceData, query: string, page: any[]) =>
    (slice.cacheCapabilityCatalogPage as any).call(state, query, page);
  const clear = (state: CapabilitySliceData) =>
    (slice.clearCapabilityCatalogCache as any).call(state);

  it("keeps a page in delivery order", () => {
    const state = draft();
    cache(state, "q:skills", [cap("a"), cap("b")]);
    expect(selectCachedCatalog(state, "q:skills").map((e) => e.slug)).toEqual(["a", "b"]);
    expect(state.capabilityCatalog.fetchedAt).toBeGreaterThan(0);
  });

  it("puts the newest page first and never lists a slug twice", () => {
    const state = draft();
    cache(state, "q", [cap("a"), cap("b")]);
    cache(state, "q", [cap("b"), cap("c")]);
    expect(selectCachedCatalog(state, "q").map((e) => e.slug)).toEqual(["b", "c", "a"]);
  });

  it("does not answer one query with another query's page", () => {
    const state = draft();
    cache(state, "q:skills", [cap("a")]);
    expect(selectCachedCatalog(state, "q:mcp")).toEqual([]);

    cache(state, "q:mcp", [cap("z")]);
    // Switching the filter drops the old page rather than blending the two.
    expect(selectCachedCatalog(state, "q:mcp").map((e) => e.slug)).toEqual(["z"]);
    expect(state.capabilityCatalog.entries.a).toBeUndefined();
  });

  it("evicts the least recently delivered rows at the cap", () => {
    const state = draft();
    const first = Array.from({ length: CAPABILITY_CATALOG_CACHE_MAX }, (_, i) => cap(`s${i}`));
    cache(state, "q", first);
    cache(state, "q", [cap("fresh")]);

    const slugs = selectCachedCatalog(state, "q").map((e) => e.slug);
    expect(slugs).toHaveLength(CAPABILITY_CATALOG_CACHE_MAX);
    expect(slugs[0]).toBe("fresh");
    // The oldest delivery is gone from the index AND from the entries map, so
    // the cache cannot grow past the cap on disk either.
    expect(slugs).not.toContain(`s${CAPABILITY_CATALOG_CACHE_MAX - 1}`);
    expect(state.capabilityCatalog.entries[`s${CAPABILITY_CATALOG_CACHE_MAX - 1}`]).toBeUndefined();
  });

  it("refuses a row it cannot key", () => {
    const state = draft();
    cache(state, "q", [cap("a"), { kind: "skill", name: "no slug" }, { slug: "" }, null]);
    expect(selectCachedCatalog(state, "q").map((e) => e.slug)).toEqual(["a"]);
  });

  it("leaves the blob untouched when a page adds nothing under the same query", () => {
    const state = draft();
    cache(state, "q", [cap("a")]);
    const before = state.capabilityCatalog;
    cache(state, "q", []);
    // Same object: no subscriber wakes and nothing is re-written to disk.
    expect(state.capabilityCatalog).toBe(before);
  });

  it("resets to a real empty page when the query changes to one with no results", () => {
    const state = draft();
    cache(state, "q", [cap("a")]);
    cache(state, "q:none", []);
    expect(state.capabilityCatalog.query).toBe("q:none");
    expect(selectCachedCatalog(state, "q:none")).toEqual([]);
  });

  it("clears", () => {
    const state = draft();
    cache(state, "q", [cap("a")]);
    clear(state);
    expect(state.capabilityCatalog.recent).toEqual([]);
    expect(state.capabilityCatalog.query).toBe("");
    expect(selectCachedCatalog(state, "q")).toEqual([]);
  });

  it("survives a non-array page", () => {
    const state = draft();
    cache(state, "q", undefined as any);
    expect(selectCachedCatalog(state, "q")).toEqual([]);
  });
});

// ── Registry fragments ──────────────────────────────────────────────────────

describe("registry fragments", () => {
  it("registers capability state as a delta overlay with no stub to supersede", () => {
    expect(CAPABILITY_SYNC_REGISTRY.capabilityState).toEqual({ isDelta: true });
    // reported_at stays in the identity compare on purpose: excluding it would
    // freeze each row's own "last reported" stamp. The churn is handled in the
    // wake signature instead.
    expect((CAPABILITY_SYNC_REGISTRY.capabilityState as any).ignoreFields).toBeUndefined();
    // The catalog is written by a named action, never by syncTable.
    expect((CAPABILITY_SYNC_REGISTRY as any).capabilityCatalog).toBeUndefined();
  });

  it("prunes only within the devices a complete crawl covered", () => {
    const opts = capabilityStateSyncOpts(["d1", "d2"]);
    expect(opts.isDelta).toBe(true);
    expect(opts.pruneAbsentScope({ device_id: "d1" })).toBe(true);
    expect(opts.pruneAbsentScope({ device_id: "d3" })).toBe(false);
    expect(opts.pruneAbsentScope({})).toBe(false);
  });

  it("persists both keys, deferred, and protects neither", () => {
    const state = CAPABILITY_CLIENT_SYNC_REGISTRY.capabilityState;
    expect(state.persistence).toEqual({ kind: "collection", key: "capabilityState" });
    expect(state.hydration).toEqual({ phase: "deferred" });
    // A machine's report is never a local write, so field protection could only
    // ever mask the truth with a guess.
    expect((state as any).localFirst).toBeUndefined();
    expect((state as any).dispatchTable).toBeUndefined();

    const catalog = CAPABILITY_CLIENT_SYNC_REGISTRY.capabilityCatalog;
    expect(catalog.persistence).toEqual({ kind: "meta", key: "capabilityCatalog" });
    expect(catalog.hydration).toEqual({ phase: "deferred" });
  });

  it("refuses a foreign document persisted under capabilityState", () => {
    const valid = CAPABILITY_CLIENT_SYNC_REGISTRY.capabilityState.validRow;
    expect(valid({ _id: "x", device_id: "d1", client: "claude_code" })).toBe(true);
    // A device row, a session row, an empty object: none of them is a report.
    expect(valid({ _id: "x", device_id: "d1" })).toBe(false);
    expect(valid({ _id: "x", client: "claude_code" })).toBe(false);
    expect(valid({ _id: "x", device_id: "", client: "" })).toBe(false);
    expect(valid({})).toBe(false);
  });

  it("names a Dexie table for the collection, indexed by device", () => {
    expect(CAPABILITY_IDB_STORES).toEqual({ capabilityState: "_id, device_id" });
    // Every persisted collection key needs a table, or the whole cache degrades
    // for it (MISSING_COLLECTION_TABLES).
    for (const [key, entry] of Object.entries(CAPABILITY_CLIENT_SYNC_REGISTRY)) {
      if ((entry as any).persistence?.kind !== "collection") continue;
      expect(CAPABILITY_IDB_STORES).toHaveProperty(key);
    }
  });
});
