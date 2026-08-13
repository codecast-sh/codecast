// The fleet mirror's server half.
//
// Two things carry the weight here and both are tested against behaviour rather
// than shape:
//
//   The write gate. A fleet's daemons report continuously; a row must only be
//   rewritten when what it says actually changed. Convex versions whole
//   documents, so an unearned write per beat per (device, client, scope) is the
//   hot-document contention this repo has already been burned by. Every
//   "unchanged" case below asserts on `_patched` being EMPTY, not on a status
//   string — a status is a claim, an absent write is the fact.
//
//   Not knowing versus not having. A machine that never reported is not a
//   machine without the capability. Rendering the first as the second invents
//   drift the user cannot resolve, so `unknown` cells get their own tests.

import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import {
  deleteDeviceState,
  foldFleet,
  normalizeReport,
  reportInventory,
  stableHash,
  sweepCatalogCache,
  upsertCatalogEntries,
  webCatalogList,
  webFleetDiff,
  webList,
  type NormalizedInventory,
  type NormalizedReport,
} from "./capabilities";
import {
  CATALOG_STALE_MS,
  LIVENESS_WRITE_INTERVAL_MS,
  MAX_ENTRIES_CHARS,
  MAX_REPORT_CHARS,
  MAX_SCOPE_ROWS_PER_DEVICE,
} from "./capabilitiesSchema";

const OWNER = "u_owner";
const STRANGER = "u_stranger";
const TOKEN = "cast_test_token";

function auth(userId: string | null) {
  return {
    async getUserIdentity() {
      return userId ? { subject: `${userId}|session` } : null;
    },
  };
}

function ctx(userId: string | null, tables: Record<string, any[]>) {
  return {
    auth: auth(userId),
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
  } as any;
}

async function tokenTables(extra: Record<string, any[]> = {}, owner = OWNER) {
  return {
    api_tokens: [{ _id: "tok_1", user_id: owner, token_hash: await hashToken(TOKEN) }],
    users: [{ _id: OWNER }, { _id: STRANGER }],
    devices: [],
    capability_state: [],
    capability_catalog_cache: [],
    ...extra,
  } as Record<string, any[]>;
}

function inventory(items: any[], marketplaces: any[] = []): string {
  return JSON.stringify({ items, marketplaces });
}

const SKILL = { kind: "skill", name: "domain-search", scope: "user", enabled: true };
const PLUGIN = {
  kind: "plugin",
  name: "code-simplifier@official",
  scope: "user",
  enabled: true,
  installed: true,
  meta: { marketplace: "official", sha: "aaaa111" },
};

/** A stored row as `reportInventory` would have written it. */
function stateRow(over: Record<string, any>): Record<string, any> {
  const json = over.entries_json ?? inventory([SKILL]);
  // The hash is over the CANONICAL form, which is what the mutation compares
  // against. A deliberately corrupt payload has no canonical form, so it gets a
  // hash that matches nothing — exactly the "we stored bytes we cannot read"
  // state the diff has to survive.
  const normalized = normalizeReport(json);
  return {
    _id: over._id ?? "cs_seed",
    user_id: OWNER,
    device_id: "dev_a",
    client: "claude",
    scope_key: "",
    entries_json: json,
    entries_hash: "error" in normalized ? "unreadable" : stableHash(normalized.json),
    entry_count: 1,
    reported_at: Date.now(),
    ...over,
  };
}

/* ========================================================================== */

describe("normalizeReport", () => {
  test("keeps a kind it has never heard of", () => {
    // A kind we do not model yet is still something the user has. An allow-list
    // here would make a newer daemon's new kind vanish without a trace.
    const result = normalizeReport(inventory([{ kind: "widget", name: "thing" }])) as NormalizedReport;
    expect(result.inventory.items.map((i) => i.kind)).toEqual(["widget"]);
  });

  test("drops entries with no name, and survives non-objects", () => {
    const result = normalizeReport(
      inventory([SKILL, { kind: "skill", name: "  " }, null, 7, "nope"]),
    ) as NormalizedReport;
    expect(result.inventory.items).toHaveLength(1);
  });

  test("sorts, so scan order cannot fake a change", () => {
    // readdir order is not stable across machines or even across runs. If the
    // hash followed it, every scan would look like a change and the gate below
    // would never fire.
    const a = normalizeReport(inventory([{ kind: "skill", name: "b" }, { kind: "skill", name: "a" }])) as NormalizedReport;
    const b = normalizeReport(inventory([{ kind: "skill", name: "a" }, { kind: "skill", name: "b" }])) as NormalizedReport;
    expect(a.json).toBe(b.json);
    expect(stableHash(a.json)).toBe(stableHash(b.json));
  });

  test("meta key order does not change the hash either", () => {
    const a = normalizeReport(inventory([{ ...PLUGIN, meta: { sha: "x", marketplace: "m" } }])) as NormalizedReport;
    const b = normalizeReport(inventory([{ ...PLUGIN, meta: { marketplace: "m", sha: "x" } }])) as NormalizedReport;
    expect(a.json).toBe(b.json);
  });

  test("only an explicit false is switched off", () => {
    const result = normalizeReport(
      inventory([{ kind: "skill", name: "a" }, { kind: "skill", name: "b", enabled: false }]),
    ) as NormalizedReport;
    expect(result.inventory.items.map((i) => i.enabled)).toEqual([true, false]);
  });

  test("accepts a bare array of items", () => {
    const result = normalizeReport(JSON.stringify([SKILL])) as NormalizedReport;
    expect(result.inventory.items).toHaveLength(1);
    expect(result.inventory.marketplaces).toEqual([]);
  });

  test("unparseable and oversize payloads are refusals, not throws", () => {
    expect(normalizeReport("{not json")).toEqual({ error: "unparseable_json" });
    expect(normalizeReport("x".repeat(MAX_REPORT_CHARS + 1))).toEqual({ error: "payload_too_large" });
  });

  test("a huge inventory is truncated to the byte budget and says how much", () => {
    // Big enough to blow the 256KB storage budget, small enough to stay under
    // the 1MB parse refusal — the band where truncation is the right answer.
    const many = Array.from({ length: 1500 }, (_, i) => ({
      kind: "skill",
      name: `skill-${String(i).padStart(4, "0")}`,
      description: "d".repeat(300),
      scope: "user",
    }));
    const result = normalizeReport(inventory(many)) as NormalizedReport;
    expect(result.json.length).toBeLessThanOrEqual(MAX_ENTRIES_CHARS);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.count + result.dropped).toBe(1500);
    // Truncation follows the sorted order, so which entries survive is the same
    // on every machine rather than a property of the disk's scan order.
    expect(result.inventory.items[0].name).toBe("skill-0000");
  });

  test("marketplaces are budgeted first — they explain the missing plugins", () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({
      kind: "plugin",
      name: `p-${i}@m`,
      description: "d".repeat(300),
    }));
    const result = normalizeReport(inventory(many, [{ name: "official", repo: "a/b" }])) as NormalizedReport;
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.inventory.marketplaces).toEqual([{ name: "official", repo: "a/b", scope: "user" }]);
  });
});

describe("stableHash", () => {
  test("same bytes, same hash; one changed character, different hash", () => {
    expect(stableHash("abc")).toBe(stableHash("abc"));
    expect(stableHash("abc")).not.toBe(stableHash("abd"));
    expect(stableHash("")).toHaveLength(16);
  });
});

/* ========================================================================== */

describe("reportInventory", () => {
  test("a bad token is rejected before anything is read", async () => {
    const tables = await tokenTables();
    await expect(
      (reportInventory as any)._handler(ctx(null, tables), {
        api_token: "wrong",
        device_id: "dev_a",
        entries_json: inventory([SKILL]),
      }),
    ).rejects.toThrow("Unauthorized");
    expect(tables.capability_state).toHaveLength(0);
  });

  test("first report creates the row", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    const result = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([SKILL, PLUGIN]),
      client_version: "2.1.0",
    });
    expect(result.status).toBe("created");
    expect(result.entry_count).toBe(2);
    expect(tables.capability_state).toHaveLength(1);
    const row = tables.capability_state[0];
    expect(row.user_id).toBe(OWNER);
    expect(row.client).toBe("claude");
    expect(row.scope_key).toBe("");
    expect(row.client_version).toBe("2.1.0");
    expect(JSON.parse(row.entries_json).items).toHaveLength(2);
  });

  test("an identical resend inside the hour writes NOTHING", async () => {
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    const c = ctx(null, tables);
    const result = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([SKILL]),
    });
    expect(result.status).toBe("unchanged");
    // The assertion that matters: not one patch. A `reported_at` bump alone
    // rewrites the whole document, and the fleet does this every beat.
    expect(c.db._patched).toHaveLength(0);
    expect(c.db._inserted).toHaveLength(0);
  });

  test("an identical resend after the liveness window touches only reported_at", async () => {
    const stale = Date.now() - LIVENESS_WRITE_INTERVAL_MS - 1000;
    const tables = await tokenTables({ capability_state: [stateRow({ reported_at: stale })] });
    const c = ctx(null, tables);
    const result = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([SKILL]),
    });
    expect(result.status).toBe("refreshed");
    expect(c.db._patched).toHaveLength(1);
    expect(Object.keys(c.db._patched[0].patch)).toEqual(["reported_at"]);
  });

  test("changed entries rewrite the row", async () => {
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    const c = ctx(null, tables);
    const result = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([SKILL, PLUGIN]),
    });
    expect(result.status).toBe("updated");
    expect(c.db._patched).toHaveLength(1);
    expect(tables.capability_state[0].entry_count).toBe(2);
  });

  test("a scan error is a change even when the inventory is byte-identical", async () => {
    // "I could not look" and "there is nothing there" are different facts, and
    // the second must never overwrite the first silently.
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    const c = ctx(null, tables);
    const result = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([SKILL]),
      scan_error: "~/.claude unreadable",
    });
    expect(result.status).toBe("updated");
    expect(tables.capability_state[0].last_error).toBe("~/.claude unreadable");
  });

  test("a fixed machine stops reporting its old error", async () => {
    const tables = await tokenTables({
      capability_state: [stateRow({ last_error: "~/.claude unreadable" })],
    });
    await (reportInventory as any)._handler(ctx(null, tables), {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([SKILL, PLUGIN]),
    });
    expect(tables.capability_state[0].last_error).toBeUndefined();
  });

  test("an over-long identity is refused, never stored as a prefix", async () => {
    // A clipped device id addresses a row its writer will never look for again,
    // and the next report creates a second row beside it.
    const tables = await tokenTables();
    const c = ctx(null, tables);
    expect(
      await (reportInventory as any)._handler(c, {
        api_token: TOKEN,
        device_id: "d".repeat(201),
        entries_json: inventory([SKILL]),
      }),
    ).toEqual({ status: "rejected", reason: "invalid_device_id" });
    expect(
      await (reportInventory as any)._handler(c, {
        api_token: TOKEN,
        device_id: "dev_a",
        scope_key: "git:" + "x".repeat(500),
        entries_json: inventory([SKILL]),
      }),
    ).toEqual({ status: "rejected", reason: "invalid_scope_key" });
    expect(tables.capability_state).toHaveLength(0);
  });

  test("truncation is recorded on the row", async () => {
    const tables = await tokenTables();
    const many = Array.from({ length: 1500 }, (_, i) => ({
      kind: "skill",
      name: `skill-${i}`,
      description: "d".repeat(300),
    }));
    await (reportInventory as any)._handler(ctx(null, tables), {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory(many),
    });
    expect(tables.capability_state[0].dropped_count).toBeGreaterThan(0);
  });

  test("a malformed or oversize report is refused without touching the row", async () => {
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    const c = ctx(null, tables);
    expect(
      await (reportInventory as any)._handler(c, {
        api_token: TOKEN,
        device_id: "dev_a",
        entries_json: "{{{",
      }),
    ).toEqual({ status: "rejected", reason: "unparseable_json" });
    expect(c.db._patched).toHaveLength(0);
  });

  test("a new project scope past the cap evicts the oldest project row, never the machine-wide one", async () => {
    const rows = [stateRow({ _id: "cs_user", scope_key: "", reported_at: 1 })];
    for (let i = 1; i < MAX_SCOPE_ROWS_PER_DEVICE; i++) {
      rows.push(stateRow({ _id: `cs_proj_${i}`, scope_key: `git:repo-${i}`, reported_at: 1000 + i }));
    }
    const tables = await tokenTables({ capability_state: rows });
    const c = ctx(null, tables);
    const result = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      scope_key: "git:repo-new",
      entries_json: inventory([SKILL]),
    });
    expect(result.status).toBe("created");
    // The oldest PROJECT row goes; the machine-wide row — the one the mirror
    // renders — is older still and must survive.
    expect(c.db._deleted).toEqual(["cs_proj_1"]);
    expect(tables.capability_state.some((r: any) => r._id === "cs_user")).toBe(true);
    expect(tables.capability_state).toHaveLength(MAX_SCOPE_ROWS_PER_DEVICE);
  });

  test("when every row is machine-wide the report is refused rather than evicting one", async () => {
    const rows = Array.from({ length: MAX_SCOPE_ROWS_PER_DEVICE }, (_, i) =>
      stateRow({ _id: `cs_${i}`, scope_key: "", client: `client-${i}` }),
    );
    const tables = await tokenTables({ capability_state: rows });
    const c = ctx(null, tables);
    const result = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      client: "client-new",
      entries_json: inventory([SKILL]),
    });
    expect(result).toEqual({ status: "rejected", reason: "scope_cap_reached" });
    expect(c.db._deleted).toHaveLength(0);
  });

  test("the cap is per device — a second machine is unaffected", async () => {
    const rows = Array.from({ length: MAX_SCOPE_ROWS_PER_DEVICE }, (_, i) =>
      stateRow({ _id: `cs_${i}`, scope_key: `git:repo-${i}` }),
    );
    const tables = await tokenTables({ capability_state: rows });
    const result = await (reportInventory as any)._handler(ctx(null, tables), {
      api_token: TOKEN,
      device_id: "dev_b",
      entries_json: inventory([SKILL]),
    });
    expect(result.status).toBe("created");
  });
});

/* ========================================================================== */

describe("webList", () => {
  test("unauthenticated reads an empty fleet instead of throwing", async () => {
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    expect(await (webList as any)._handler(ctx(null, tables), {})).toEqual({ items: [] });
  });

  test("returns only my machines", async () => {
    const tables = await tokenTables({
      capability_state: [stateRow({ _id: "mine" }), stateRow({ _id: "theirs", user_id: STRANGER })],
    });
    const result = await (webList as any)._handler(ctx(OWNER, tables), {});
    expect(result.items.map((i: any) => i._id)).toEqual(["mine"]);
  });

  test("the machine-wide row sorts first, so a per-device map lands on it", async () => {
    const tables = await tokenTables({
      capability_state: [
        stateRow({ _id: "proj", scope_key: "git:one" }),
        stateRow({ _id: "user", scope_key: "" }),
      ],
    });
    const result = await (webList as any)._handler(ctx(OWNER, tables), {});
    expect(result.items.map((i: any) => i._id)).toEqual(["user", "proj"]);
  });

  test("include_entries:false answers with metadata only", async () => {
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    const result = await (webList as any)._handler(ctx(OWNER, tables), { include_entries: false });
    expect(result.items[0].entries_json).toBeUndefined();
    expect(result.items[0].entries_omitted).toBe(false);
    expect(result.items[0].entry_count).toBe(1);
  });

  test("device_id narrows to one machine", async () => {
    const tables = await tokenTables({
      capability_state: [stateRow({ _id: "a", device_id: "dev_a" }), stateRow({ _id: "b", device_id: "dev_b" })],
    });
    const result = await (webList as any)._handler(ctx(OWNER, tables), { device_id: "dev_b" });
    expect(result.items.map((i: any) => i._id)).toEqual(["b"]);
  });
});

/* ========================================================================== */

describe("foldFleet", () => {
  const devices = (...ids: string[]) =>
    ids.map((id) => ({ deviceId: id, label: id, reported: true }));
  const reports = (map: Record<string, NormalizedInventory>) =>
    new Map(Object.entries(map).map(([k, v]) => [k, [v]]));
  const inv = (items: any[], marketplaces: any[] = []): NormalizedInventory =>
    (normalizeReport(inventory(items, marketplaces)) as NormalizedReport).inventory;

  test("most machines have it and one does not — the row the product exists for", () => {
    const folded = foldFleet(
      devices("a", "b", "c"),
      reports({ a: inv([SKILL]), b: inv([SKILL]), c: inv([]) }),
    );
    const row = folded.rows[0];
    expect(row.status).toBe("drift");
    expect(row.stateDrift).toBe(true);
    expect(row.cells.map((c) => c.status)).toEqual(["same", "same", "absent"]);
    expect(folded.summary.drifted).toBe(1);
  });

  test("exactly one machine having it reads as unique, not as loss", () => {
    // Often deliberate — a work laptop, a scratch skill. Calling it drift would
    // make the page shout about every one-off a person ever wrote.
    const folded = foldFleet(devices("a", "b"), reports({ a: inv([SKILL]), b: inv([]) }));
    expect(folded.rows[0].status).toBe("unique");
    expect(folded.summary.uniqueToOne).toBe(1);
  });

  test("a machine that never reported reads unknown, not absent", () => {
    // The whole point. `absent` says "it is missing there" — a claim we have no
    // evidence for when the daemon has never spoken.
    const folded = foldFleet(
      [
        { deviceId: "a", label: "a", reported: true },
        { deviceId: "b", label: "b", reported: false },
      ],
      reports({ a: inv([SKILL]) }),
    );
    const row = folded.rows[0];
    expect(row.cells.map((c) => c.status)).toEqual(["same", "unknown"]);
    expect(row.absentCount).toBe(0);
    // One reporting machine is not a fleet: there is no verdict to give.
    expect(row.status).toBe("not_comparable");
    expect(folded.summary.comparable).toBe(false);
    expect(folded.summary.drifted).toBe(0);
  });

  test("the same plugin at two shas is pin drift", () => {
    const folded = foldFleet(
      devices("a", "b", "c"),
      reports({
        a: inv([PLUGIN]),
        b: inv([PLUGIN]),
        c: inv([{ ...PLUGIN, meta: { marketplace: "official", sha: "bbbb222" } }]),
      }),
    );
    const row = folded.rows[0];
    expect(row.pinDrift).toBe(true);
    expect(row.baselinePin).toBe("aaaa111");
    expect(row.cells.map((c) => c.status)).toEqual(["same", "same", "pin_differs"]);
  });

  test("a machine with the plugin but no sha is an unknown pin, not a different one", () => {
    const folded = foldFleet(
      devices("a", "b"),
      reports({
        a: inv([PLUGIN]),
        b: inv([{ kind: "plugin", name: "code-simplifier@official", scope: "user" }]),
      }),
    );
    expect(folded.rows[0].pinDrift).toBe(false);
    expect(folded.rows[0].status).toBe("in_sync");
  });

  test("a stdio MCP server's command line is never a pin", () => {
    // `node /Users/ashot/…` differs on every machine for the same server, so
    // comparing it would report drift across a perfectly synchronised fleet.
    const server = (home: string) => ({
      kind: "mcp",
      name: "gh",
      scope: "user",
      meta: { command: `node ${home}/server.js` },
    });
    const folded = foldFleet(
      devices("a", "b"),
      reports({ a: inv([server("/Users/ashot")]), b: inv([server("/home/build")]) }),
    );
    expect(folded.rows[0].status).toBe("in_sync");
    expect(folded.rows[0].pins).toEqual([]);
  });

  test("a remote MCP server's url IS a pin, ignoring a trailing slash", () => {
    const at = (url: string) => ({ kind: "mcp", name: "gh", scope: "user", meta: { url } });
    const same = foldFleet(
      devices("a", "b"),
      reports({ a: inv([at("https://x.dev/mcp")]), b: inv([at("https://x.dev/mcp/")]) }),
    );
    expect(same.rows[0].pinDrift).toBe(false);
    const moved = foldFleet(
      devices("a", "b"),
      reports({ a: inv([at("https://x.dev/mcp")]), b: inv([at("https://y.dev/mcp")]) }),
    );
    expect(moved.rows[0].pinDrift).toBe(true);
  });

  test("scopes stack: switched on anywhere is switched on here", () => {
    const folded = foldFleet(
      devices("a", "b"),
      reports({
        a: inv([
          { ...PLUGIN, scope: "project", enabled: false },
          { ...PLUGIN, scope: "user", enabled: true },
        ]),
        b: inv([PLUGIN]),
      }),
    );
    expect(folded.rows[0].cells[0].enabled).toBe(true);
    expect(folded.rows[0].cells[0].scopes).toEqual(["project", "user"]);
    expect(folded.rows[0].status).toBe("in_sync");
  });

  test("one machine's disabled copy is drift, and its cell says so", () => {
    const folded = foldFleet(
      devices("a", "b"),
      reports({ a: inv([SKILL]), b: inv([{ ...SKILL, enabled: false }]) }),
    );
    expect(folded.rows[0].cells.map((c) => c.status)).toEqual(["same", "disabled"]);
    expect(folded.rows[0].disabledCount).toBe(1);
    expect(folded.rows[0].status).toBe("drift");
  });

  test("case differences in a name are one row, not two", () => {
    const folded = foldFleet(
      devices("a", "b"),
      reports({
        a: inv([{ kind: "skill", name: "Domain-Search", scope: "user" }]),
        b: inv([{ kind: "skill", name: "domain-search", scope: "user" }]),
      }),
    );
    expect(folded.rows).toHaveLength(1);
    expect(folded.rows[0].status).toBe("in_sync");
  });

  test("marketplaces share the grid, because a missing one explains a missing plugin", () => {
    const known = [{ name: "official", repo: "anthropics/plugins" }];
    const folded = foldFleet(
      devices("a", "b", "c"),
      reports({ a: inv([], known), b: inv([], known), c: inv([]) }),
    );
    expect(folded.rows[0].kind).toBe("marketplace");
    expect(folded.rows[0].identity).toBe("official");
    expect(folded.rows[0].status).toBe("drift");
  });

  test("drift sorts before agreement, and state drift before pin drift", () => {
    const other = { kind: "skill", name: "agreed", scope: "user", enabled: true };
    const drifted = { ...PLUGIN, meta: { marketplace: "official", sha: "zzz" } };
    const folded = foldFleet(
      devices("a", "b", "c"),
      reports({
        a: inv([SKILL, other, PLUGIN]),
        b: inv([SKILL, other, PLUGIN]),
        c: inv([other, drifted]),
      }),
    );
    expect(folded.rows.map((r) => r.status)).toEqual(["drift", "drift", "in_sync"]);
    // A machine missing it entirely outranks a machine merely behind on a sha.
    expect(folded.rows[0].stateDrift).toBe(true);
    expect(folded.rows[0].kind).toBe("skill");
    expect(folded.rows[1].pinDrift).toBe(true);
    expect(folded.rows[1].kind).toBe("plugin");
  });

  test("several rows for one machine fold into one column", () => {
    // The server stores one row per (device, client, scope), so a caller hands us
    // several reports for one machine. Nothing it reported may be lost.
    const folded = foldFleet(devices("a", "b"), new Map([
      ["a", [inv([SKILL]), inv([PLUGIN])]],
      ["b", [inv([SKILL])]],
    ]));
    expect(folded.rows).toHaveLength(2);
    expect(folded.devices).toHaveLength(2);
  });
});

/* ========================================================================== */

describe("webFleetDiff", () => {
  const devicesTable = [
    { _id: "d1", user_id: OWNER, device_id: "dev_a", label: "Laptop" },
    { _id: "d2", user_id: OWNER, device_id: "dev_b", label: "Mac mini" },
  ];

  test("unauthenticated returns an empty, honest answer", async () => {
    const tables = await tokenTables({ devices: devicesTable });
    const result = await (webFleetDiff as any)._handler(ctx(null, tables), {});
    expect(result.rows).toEqual([]);
    expect(result.summary.comparable).toBe(false);
  });

  test("a device with no report still gets a column, labelled and unknown", async () => {
    const tables = await tokenTables({
      devices: devicesTable,
      capability_state: [stateRow({ device_id: "dev_a" })],
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), {});
    expect(result.devices.map((d: any) => [d.label, d.reported])).toEqual([
      ["Laptop", true],
      ["Mac mini", false],
    ]);
    expect(result.rows[0].cells.map((c: any) => c.status)).toEqual(["same", "unknown"]);
  });

  test("two reporting machines produce a real verdict", async () => {
    const tables = await tokenTables({
      devices: devicesTable,
      capability_state: [
        stateRow({ _id: "a", device_id: "dev_a", entries_json: inventory([SKILL, PLUGIN]) }),
        stateRow({ _id: "b", device_id: "dev_b", entries_json: inventory([SKILL]) }),
      ],
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), {});
    expect(result.summary.comparable).toBe(true);
    expect(result.rows[0].identity).toBe("code-simplifier@official");
    expect(result.rows[0].status).toBe("unique");
  });

  test("another user's reports never enter my fleet", async () => {
    const tables = await tokenTables({
      devices: devicesTable,
      capability_state: [
        stateRow({ _id: "mine", device_id: "dev_a", entries_json: inventory([SKILL]) }),
        stateRow({ _id: "theirs", user_id: STRANGER, device_id: "dev_x", entries_json: inventory([PLUGIN]) }),
      ],
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), {});
    expect(result.devices.map((d: any) => d.deviceId)).toEqual(["dev_a", "dev_b"]);
    expect(result.rows.map((r: any) => r.kind)).toEqual(["skill"]);
  });

  test("a report from a machine no longer in the roster gets no column", async () => {
    // A rotated device id (a cloned disk re-keys itself) would otherwise leave a
    // permanent column for a machine the user cannot act on.
    const tables = await tokenTables({
      devices: [devicesTable[0]],
      capability_state: [
        stateRow({ _id: "a", device_id: "dev_a" }),
        stateRow({ _id: "ghost", device_id: "dev_gone", entries_json: inventory([PLUGIN]) }),
      ],
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), {});
    expect(result.devices.map((d: any) => d.deviceId)).toEqual(["dev_a"]);
    expect(result.rows.map((r: any) => r.kind)).toEqual(["skill"]);
  });

  test("stored bytes we cannot parse cost that machine its items, not the page", async () => {
    const tables = await tokenTables({
      devices: devicesTable,
      capability_state: [
        stateRow({ _id: "a", device_id: "dev_a" }),
        stateRow({ _id: "b", device_id: "dev_b", entries_json: "{{{ corrupt" }),
      ],
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), {});
    expect(result.devices.every((d: any) => d.reported)).toBe(true);
    expect(result.rows[0].cells.map((c: any) => c.status)).toEqual(["same", "absent"]);
  });

  test("filters narrow the rows but never the summary", async () => {
    const tables = await tokenTables({
      devices: devicesTable,
      capability_state: [
        stateRow({ _id: "a", device_id: "dev_a", entries_json: inventory([SKILL, PLUGIN]) }),
        stateRow({ _id: "b", device_id: "dev_b", entries_json: inventory([SKILL]) }),
      ],
    });
    const c = ctx(OWNER, tables);
    const kinds = await (webFleetDiff as any)._handler(c, { kinds: ["plugin"] });
    expect(kinds.rows.map((r: any) => r.kind)).toEqual(["plugin"]);
    // A count that shrinks when you filter is a count nobody can act on.
    expect(kinds.summary.total).toBe(2);

    const drifting = await (webFleetDiff as any)._handler(c, { include_in_sync: false });
    expect(drifting.rows.map((r: any) => r.status)).toEqual(["unique"]);
  });

  test("device_ids narrows the comparison to the named machines", async () => {
    const tables = await tokenTables({
      devices: devicesTable,
      capability_state: [
        stateRow({ _id: "a", device_id: "dev_a", entries_json: inventory([SKILL]) }),
        stateRow({ _id: "b", device_id: "dev_b", entries_json: inventory([PLUGIN]) }),
      ],
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), { device_ids: ["dev_a"] });
    expect(result.devices.map((d: any) => d.deviceId)).toEqual(["dev_a"]);
    expect(result.rows.every((r: any) => r.status === "not_comparable")).toBe(true);
  });

  test("limit truncates and says so", async () => {
    const tables = await tokenTables({
      devices: devicesTable,
      capability_state: [
        stateRow({ _id: "a", device_id: "dev_a", entries_json: inventory([SKILL, PLUGIN]) }),
        stateRow({ _id: "b", device_id: "dev_b", entries_json: inventory([]) }),
      ],
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), { limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

/* ========================================================================== */

describe("catalog cache", () => {
  const entry = (over: Record<string, any> = {}) => ({
    slug: "mkt/official/code-simplifier",
    kind: "plugin",
    name: "Code Simplifier",
    description: "Simplifies code",
    publisher: "Anthropic",
    detail: { cost: { alwaysOn: 800 } },
    ...over,
  });

  test("ingest inserts, and a re-ingest of the same bytes writes nothing", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    const first = await (upsertCatalogEntries as any)._handler(c, {
      source: "marketplace",
      origin: "official",
      entries: [entry()],
    });
    expect(first).toEqual({ inserted: 1, updated: 0, unchanged: 0, skipped: 0 });

    const second = await (upsertCatalogEntries as any)._handler(c, {
      source: "marketplace",
      origin: "official",
      entries: [entry()],
    });
    expect(second.unchanged).toBe(1);
    // A refresh cron that rewrote every row would invalidate every browse
    // subscription on every run.
    expect(c.db._patched).toHaveLength(0);
  });

  test("a changed card rewrites the row", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await (upsertCatalogEntries as any)._handler(c, {
      source: "marketplace", origin: "official", entries: [entry()],
    });
    const result = await (upsertCatalogEntries as any)._handler(c, {
      source: "marketplace", origin: "official", entries: [entry({ description: "Now with fewer bugs" })],
    });
    expect(result.updated).toBe(1);
    expect(tables.capability_catalog_cache[0].description).toBe("Now with fewer bugs");
  });

  test("a slug that does not belong to its source is refused", async () => {
    // Slugs render as identities. A marketplace publishing under `builtin/`
    // would look like ours.
    const tables = await tokenTables();
    const result = await (upsertCatalogEntries as any)._handler(ctx(null, tables), {
      source: "marketplace",
      origin: "official",
      entries: [entry({ slug: "builtin/memory" }), entry()],
    });
    expect(result).toEqual({ inserted: 1, updated: 0, unchanged: 0, skipped: 1 });
    expect(tables.capability_catalog_cache.map((r: any) => r.slug)).toEqual(["mkt/official/code-simplifier"]);
  });

  test("an over-long slug is skipped rather than clipped into a different identity", async () => {
    const tables = await tokenTables();
    const result = await (upsertCatalogEntries as any)._handler(ctx(null, tables), {
      source: "marketplace",
      origin: "official",
      entries: [entry({ slug: "mkt/official/" + "x".repeat(300) })],
    });
    expect(result.skipped).toBe(1);
    expect(tables.capability_catalog_cache).toHaveLength(0);
  });

  test("an unknown source is a programming error, and throws", async () => {
    const tables = await tokenTables();
    await expect(
      (upsertCatalogEntries as any)._handler(ctx(null, tables), {
        source: "totally-made-up",
        origin: "x",
        entries: [entry()],
      }),
    ).rejects.toThrow("Unknown capability source");
  });

  test("browse requires a signed-in reader", async () => {
    const tables = await tokenTables({
      capability_catalog_cache: [
        { _id: "c1", slug: "mkt/official/a", source: "marketplace", origin: "official", kind: "plugin", name: "A", entry_json: "{}", entry_hash: "h", fetched_at: 1 },
      ],
    });
    const anon = await (webCatalogList as any)._handler(ctx(null, tables), {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(anon.page).toEqual([]);
    const authed = await (webCatalogList as any)._handler(ctx(OWNER, tables), {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(authed.page).toHaveLength(1);
  });

  test("browse flattens the detail blob onto the card", async () => {
    const tables = await tokenTables({
      capability_catalog_cache: [
        {
          _id: "c1", slug: "mkt/official/a", source: "marketplace", origin: "official",
          kind: "plugin", name: "A", entry_json: JSON.stringify({ cost: { alwaysOn: 800 } }),
          entry_hash: "h", fetched_at: 42,
        },
      ],
    });
    const result = await (webCatalogList as any)._handler(ctx(OWNER, tables), {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page[0]).toMatchObject({
      slug: "mkt/official/a",
      marketplace: "official",
      cost: { alwaysOn: 800 },
      updatedAt: 42,
    });
  });

  test("a corrupt detail blob renders the card without it", async () => {
    const tables = await tokenTables({
      capability_catalog_cache: [
        { _id: "c1", slug: "mkt/official/a", source: "marketplace", origin: "official", kind: "plugin", name: "A", entry_json: "{{{", entry_hash: "h", fetched_at: 1 },
      ],
    });
    const result = await (webCatalogList as any)._handler(ctx(OWNER, tables), {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page[0].name).toBe("A");
  });

  test("the sweep drops stale rows and keeps fresh ones", async () => {
    const now = Date.now();
    const tables = await tokenTables({
      capability_catalog_cache: [
        { _id: "old", slug: "mkt/o/a", source: "marketplace", origin: "o", kind: "plugin", name: "A", entry_json: "{}", entry_hash: "h", fetched_at: now - CATALOG_STALE_MS - 1000 },
        { _id: "new", slug: "mkt/o/b", source: "marketplace", origin: "o", kind: "plugin", name: "B", entry_json: "{}", entry_hash: "h", fetched_at: now },
      ],
    });
    const result = await (sweepCatalogCache as any)._handler(ctx(null, tables), {});
    expect(result).toEqual({ deleted: 1 });
    expect(tables.capability_catalog_cache.map((r: any) => r._id)).toEqual(["new"]);
  });
});

/* ========================================================================== */

describe("deleteDeviceState", () => {
  test("removes every row for one machine and nothing else", async () => {
    const tables = await tokenTables({
      capability_state: [
        stateRow({ _id: "a1", device_id: "dev_a", scope_key: "" }),
        stateRow({ _id: "a2", device_id: "dev_a", scope_key: "git:one" }),
        stateRow({ _id: "b1", device_id: "dev_b" }),
        stateRow({ _id: "other", device_id: "dev_a", user_id: STRANGER }),
      ],
    });
    const result = await (deleteDeviceState as any)._handler(ctx(null, tables), {
      user_id: OWNER,
      device_id: "dev_a",
    });
    expect(result).toEqual({ deleted: 2 });
    expect(tables.capability_state.map((r: any) => r._id).sort()).toEqual(["b1", "other"]);
  });
});
