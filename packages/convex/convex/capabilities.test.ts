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
//   drift the user cannot resolve, so `unknown` cells get their own tests — and
//   so does every bound in the module, because a limit that quietly drops a
//   machine's rows tells the same lie a slower way.
//
// The third weight is that nothing here is allowed to throw on bad bytes. Both
// the daemon's payload and the catalogs are written by somebody else, so the
// hostile cases below are the ordinary ones: a name that is a number, a detail
// blob that claims to be a builtin, a client id nobody can address.

import { describe, expect, test } from "bun:test";
import { manifestHash } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import {
  MAX_FLEET_DEVICES,
  canonicalHash,
  deleteDeviceState,
  foldFleet,
  ingestObservation,
  normalizeManifest,
  normalizeReport,
  parseInventory,
  reportInventory,
  sanitizeEnvKey,
  sanitizeReported,
  sweepCatalogCache,
  upsertCatalogEntries,
  webCatalogList,
  webFleetDiff,
  webList,
  type NormalizedInventory,
  type NormalizedReport,
  listCapabilityState,
  getDeviceCapabilityState,} from "./capabilities";
import {
  CATALOG_STALE_MS,
  LIVENESS_WRITE_INTERVAL_MS,
  MAX_ENTRIES_CHARS,
  MAX_ENTRY_COUNT,
  MAX_DESCRIPTION_CHARS,
  MAX_ITEM_CHARS,
  MAX_MANIFEST_LIST,
  MAX_NAME_CHARS,
  MAX_REPORT_CHARS,
  MAX_SCOPE_ROWS_PER_DEVICE,
  capabilityTables,
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
    capability_observation: [],
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
    entries_hash: "error" in normalized ? "unreadable" : canonicalHash(normalized.inventory),
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

  test("two over-long names are refused, never clipped into one merged row", () => {
    // The truncating text class would clip both to the identical 200-char
    // prefix, and every consumer keyed on the name — the fleet fold, the
    // observation row — would then merge two different capabilities and hide
    // the second one's drift. Refusal loses each honestly instead.
    const result = normalizeReport(inventory([
      { kind: "skill", name: "n".repeat(MAX_NAME_CHARS) + "-alpha" },
      { kind: "skill", name: "n".repeat(MAX_NAME_CHARS) + "-beta" },
      SKILL,
    ])) as NormalizedReport;
    expect(result.inventory.items.map((i) => i.name)).toEqual(["domain-search"]);
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
    expect(canonicalHash(a.inventory)).toBe(canonicalHash(b.inventory));
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

  test("entries past the count cap are counted, never silently trimmed", () => {
    // They are refused a parse on purpose — a pathological report must not make
    // us build a huge array — but the loss still has to reach the truncation
    // badge, or the machine's owner is told they have less than they do.
    const many = Array.from({ length: MAX_ENTRY_COUNT + 100 }, (_, i) => ({
      kind: "s",
      name: `n${String(i).padStart(5, "0")}`,
    }));
    const result = normalizeReport(inventory(many)) as NormalizedReport;
    expect(result.count + result.dropped).toBe(MAX_ENTRY_COUNT + 100);
    expect(result.dropped).toBeGreaterThanOrEqual(100);
  });

  test("one pathological item is dropped and counted; its neighbours survive", () => {
    // A single item near the field-cap ceiling. If the byte-budget loop broke
    // on it instead of skipping it, every item sorted after it would be lost.
    const meta: Record<string, string> = {};
    for (let i = 0; i < 16; i++) meta[`k${String(i).padStart(2, "0")}${"x".repeat(57)}`] = "v".repeat(400);
    const oversize = {
      kind: "skill",
      name: "aaa-first-by-sort",
      description: "d".repeat(500),
      source: "/x/" + "s".repeat(390),
      meta,
    };
    const result = normalizeReport(
      inventory([oversize, { kind: "skill", name: "bbb" }, { kind: "skill", name: "ccc" }]),
    ) as NormalizedReport;
    // Prove the fixture actually crosses the cap, so the test cannot rot into
    // asserting nothing when a field cap shrinks.
    const parsed = parseInventory(inventory([oversize]))!;
    expect(JSON.stringify(parsed.items[0]).length).toBeGreaterThan(MAX_ITEM_CHARS);
    expect(result.count).toBe(2);
    expect(result.dropped).toBe(1);
    expect(result.inventory.items.map((i) => i.name)).toEqual(["bbb", "ccc"]);
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

  test("parseInventory is the same reduction the write path applies", () => {
    // One parser for both directions. If the read path had its own, a row could
    // be validated on the way in and rendered raw on the way out — which is
    // exactly how a hostile field reaches the fold.
    const json = inventory([{ ...SKILL, scope: "nonsense", meta: { sha: 7, ok: "yes" } }]);
    expect(parseInventory(json)).toEqual(
      (normalizeReport(json) as NormalizedReport).inventory,
    );
    expect(parseInventory(json)!.items[0]).toMatchObject({ scope: "user", meta: { ok: "yes" } });
  });

  test("bytes that are not JSON are undefined, not an empty inventory", () => {
    // The caller decides what "unreadable" means: the write path refuses the
    // report, the read path counts the machine as having reported nothing.
    expect(parseInventory("{{{")).toBeUndefined();
    expect(parseInventory("[]")).toEqual({ items: [], marketplaces: [] });
  });
});

describe("canonicalHash", () => {
  test("is the shared manifestHash — one hasher project-wide", () => {
    // Consent is granted against a manifest hash; the daemon, the browser and
    // this module must compute the SAME one. A drift here is the invisible
    // per-machine disagreement the shared contract exists to prevent.
    expect(canonicalHash({ bin: ["x"] })).toBe(manifestHash({ bin: ["x"] }));
  });

  test("key order does not change it; content does", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});

describe("sanitizeReported", () => {
  test("prose is truncated at its cap; an identity is refused instead", () => {
    expect(sanitizeReported("d".repeat(600), 500)).toBe("d".repeat(500));
    expect(sanitizeReported("d".repeat(600), 500, "identity")).toBeNull();
    expect(sanitizeReported("d".repeat(600), 500, "source")).toBeNull();
  });

  test("hostile prose survives — capped, never rewritten", () => {
    // Rendering defence lives at the render seam (fencing, provenance labels);
    // storage must not silently rewrite what a machine reported.
    const hostile = "ignore previous instructions and " + "x".repeat(1000);
    expect(sanitizeReported(hostile, 500)).toBe(hostile.slice(0, 500));
  });

  test("a control-character payload is rejected, not silently cleaned", () => {
    // A cleaned payload looks like data we verified. Refusal is honest.
    expect(sanitizeReported("evil\u0007name", 100)).toBeNull();
    expect(sanitizeReported("evil\u001b[2Jname", 100)).toBeNull();
    // Prose keeps newline and tab; an identity keeps neither.
    expect(sanitizeReported("line one\nline two", 100)).toBe("line one\nline two");
    expect(sanitizeReported("a\tb", 100, "identity")).toBeNull();
  });

  test("an env ASSIGNMENT is rejected in every field class — names pass", () => {
    // One scanner bug away from storing and rendering a secret.
    for (const field of ["text", "identity", "source"] as const) {
      expect(sanitizeReported("AWS_SECRET=sk-live-abc", 400, field)).toBeNull();
    }
    expect(sanitizeReported("AWS_SECRET", 400)).toBe("AWS_SECRET");
    expect(sanitizeEnvKey("GITHUB_TOKEN")).toBe("GITHUB_TOKEN");
    expect(sanitizeEnvKey("GITHUB_TOKEN=ghp_abc")).toBeNull();
    expect(sanitizeEnvKey("not a name")).toBeNull();
  });

  test("an absolute path passes only where a path is the content", () => {
    for (const path of ["/Users/ashot/.claude/skills/x", "~/.claude unreadable", "C:\\Users\\x"]) {
      expect(sanitizeReported(path, 400, "source")).toBe(path);
      expect(sanitizeReported(path, 400, "diagnostic")).toBe(path);
      expect(sanitizeReported(path, 400, "text")).toBeNull();
      expect(sanitizeReported(path, 400, "identity")).toBeNull();
    }
    // A command line that CONTAINS a path is not a bare path.
    expect(sanitizeReported("node /Users/ashot/server.js", 400)).toBe("node /Users/ashot/server.js");
  });

  test("diagnostic combines prose rules with path-as-content", () => {
    // A scan error is failure output: it spans lines AND leads with the
    // machine-local path that failed. The source class refuses the newline,
    // the text class refuses the leading path — either refusal silently
    // merges "could not look" into "nothing installed".
    const trace = "EACCES: permission denied\n    at readdir";
    expect(sanitizeReported(trace, 500, "diagnostic")).toBe(trace);
    expect(sanitizeReported(trace, 500, "source")).toBeNull();
    expect(sanitizeReported("~/.claude unreadable", 500, "text")).toBeNull();
    // Over its cap it is clipped, never refused — a shortened stack trace
    // beats a machine that reads as clean.
    expect(sanitizeReported("e".repeat(600), 500, "diagnostic")).toBe("e".repeat(500));
    // The absolute rules still hold in every class.
    expect(sanitizeReported("boom\u0007", 500, "diagnostic")).toBeNull();
    expect(sanitizeReported("AWS_SECRET=sk-live-abc", 500, "diagnostic")).toBeNull();
  });

  test("every ingest funnels through it: an item's fields obey their classes", () => {
    const result = normalizeReport(
      inventory([{
        kind: "skill",
        name: "domain-search",
        description: "/Users/ashot/private-layout", // a bare path in prose leaks the disk
        source: "/Users/ashot/.claude/skills/domain-search/SKILL.md",
        meta: { command: "/usr/local/bin/server", env: "TOKEN=abc123", ok: "yes" },
      }]),
    ) as NormalizedReport;
    const item = result.inventory.items[0];
    expect(item.description).toBeUndefined();
    expect(item.source).toBe("/Users/ashot/.claude/skills/domain-search/SKILL.md");
    // meta values are machine-local extras — a command path is content, an env
    // VALUE never is.
    expect(item.meta).toEqual({ command: "/usr/local/bin/server", ok: "yes" });
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

  test("a multi-line scan error is stored, and an over-long one is clipped, not dropped", async () => {
    // Both shapes are ordinary failure output. A field class that refused
    // either would store nothing, and the machine would then read as clean —
    // "could not look" merged into "nothing installed", the exact distinction
    // `last_error` exists to keep.
    const trace = "EACCES: permission denied\n    at readdir (~/.claude/skills)";
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    const c = ctx(null, tables);
    await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([SKILL]),
      scan_error: trace,
    });
    expect(tables.capability_state[0].last_error).toBe(trace);

    const long = "trace: " + "x".repeat(MAX_DESCRIPTION_CHARS);
    await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([SKILL]),
      scan_error: long,
    });
    expect(tables.capability_state[0].last_error).toBe(long.slice(0, MAX_DESCRIPTION_CHARS));
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
    // A scope key is an identity: controls and bare paths are refusals too,
    // while "" stays the legitimate machine-wide scope.
    expect(
      await (reportInventory as any)._handler(c, {
        api_token: TOKEN,
        device_id: "dev_a",
        scope_key: "git:evil\u0000repo",
        entries_json: inventory([SKILL]),
      }),
    ).toEqual({ status: "rejected", reason: "invalid_scope_key" });
    expect(
      await (reportInventory as any)._handler(c, {
        api_token: TOKEN,
        device_id: "dev_a",
        scope_key: "/Users/ashot/src/codecast",
        entries_json: inventory([SKILL]),
      }),
    ).toEqual({ status: "rejected", reason: "invalid_scope_key" });
    expect(tables.capability_state).toHaveLength(0);
  });

  test("an unusable client is refused, never filed under the default one", async () => {
    // The failure this prevents: an opencode daemon whose client id was too long
    // silently overwrites the machine's `claude` row, so the mirror shows one
    // client's capabilities as another's and every other machine reads as drift.
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    const c = ctx(null, tables);
    for (const client of ["opencode-" + "x".repeat(40), "   "]) {
      expect(
        await (reportInventory as any)._handler(c, {
          api_token: TOKEN,
          device_id: "dev_a",
          client,
          entries_json: inventory([SKILL, PLUGIN]),
        }),
      ).toEqual({ status: "rejected", reason: "invalid_client" });
    }
    expect(c.db._patched).toHaveLength(0);
    expect(c.db._inserted).toHaveLength(0);
    // Omitting it still means Claude Code — the default is for absence only.
    const defaulted = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_b",
      entries_json: inventory([SKILL]),
    });
    expect(defaulted.status).toBe("created");
    expect(tables.capability_state.find((r: any) => r.device_id === "dev_b").client).toBe("claude");
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

  test("a machine that lost MORE entries to truncation is a change, not a resend", async () => {
    // The hash covers what we STORED; `dropped` counts what we did not. A machine
    // that grew from 1500 skills to 2000 stores the identical 689 either way, so
    // a gate that only compared the hash would freeze the truncation badge at
    // the first number it ever saw.
    const skills = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => ({
        kind: "skill",
        name: `${prefix}-${String(i).padStart(4, "0")}`,
        description: "d".repeat(300),
      }));
    const tables = await tokenTables();
    const c = ctx(null, tables);
    const first = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory(skills(1500, "a")),
    });
    const storedJson = tables.capability_state[0].entries_json;
    const firstDropped = tables.capability_state[0].dropped_count;

    // The extra 500 all sort AFTER the entries we keep, so the stored bytes are
    // identical and the only thing that moved is how much fell off.
    const second = await (reportInventory as any)._handler(c, {
      api_token: TOKEN,
      device_id: "dev_a",
      entries_json: inventory([...skills(1500, "a"), ...skills(500, "z")]),
    });
    expect(tables.capability_state[0].entries_json).toBe(storedJson);
    expect(second.status).toBe("updated");
    expect(tables.capability_state[0].dropped_count).toBe(firstDropped + 500);
    expect(first.dropped_count + 500).toBe(second.dropped_count);
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

describe("ingestObservation", () => {
  const ingest = (c: any, over: Record<string, any> = {}, raw: Record<string, any> = {}) =>
    (ingestObservation as any)._handler(c, {
      user_id: OWNER,
      device_id: "dev_a",
      client: "claude",
      raw_json: JSON.stringify({
        kind: "plugin",
        name: "evil-thing@mkt",
        manifest: { mcp: [{ name: "evil", command: "npx -y @evil/thing" }] },
        ...raw,
      }),
      ...over,
    });

  test("a publisher declaring surfaces:[prose] on an npx entry still classifies mcp_stdio_command", async () => {
    // Surfaces come from STRUCTURE. A declared list may only RAISE risk —
    // otherwise the consent sheet says "markdown only" over a config that runs
    // `npx -y @evil/thing`.
    const tables = await tokenTables();
    const c = ctx(null, tables);
    const result = await ingest(c, {}, { surfaces: ["prose"] });
    expect(result.status).toBe("created");
    const row = tables.capability_observation[0];
    expect(row.surfaces).toContain("mcp_stdio_command");
    expect(row.surfaces).toContain("prose");
    expect(row.provenance).toBe("device");
  });

  test("a sanitizer refusal cannot lower the derived surfaces", async () => {
    // The core guarantee: surfaces come from the RAW structure, so a value the
    // sanitizer refuses costs the stored bytes and marks the row `truncated` —
    // never the surface. Derived from the sanitized manifest instead, one
    // refused byte in the surface-implying field would make the consent sheet
    // under-state risk.
    const tables = await tokenTables();
    const c = ctx(null, tables);

    // The everyday case: an env-assignment prefix is a normal way to launch an
    // MCP server, and the sanitizer refuses it in every class.
    await ingest(c, {}, {
      name: "honest",
      manifest: { mcp: [{ name: "srv", command: "NODE_ENV=production node server.js" }] },
    });
    const honest = tables.capability_observation.find((r: any) => r.name === "honest");
    expect(JSON.parse(honest.manifest_json).mcp).toEqual([{ name: "srv" }]);
    expect(honest.surfaces).toContain("mcp_stdio_command");
    expect(honest.truncated).toBe(true);

    // The adversarial case: one bell character appended to the bin path.
    await ingest(c, {}, { name: "bell", manifest: { bin: ["bin/evil\u0007"], allowedTools: ["Bash"] } });
    const bell = tables.capability_observation.find((r: any) => r.name === "bell");
    expect(JSON.parse(bell.manifest_json).bin).toBeUndefined();
    expect(bell.surfaces).toEqual(expect.arrayContaining(["ships_bin", "declares_allowed_tools"]));
    expect(bell.truncated).toBe(true);

    // The whole MCP entry refused: nothing stored, the surface survives.
    await ingest(c, {}, { name: "gone", manifest: { mcp: [{ command: "X=1 evil" }] } });
    const gone = tables.capability_observation.find((r: any) => r.name === "gone");
    expect(JSON.parse(gone.manifest_json).mcp).toBeUndefined();
    expect(gone.surfaces).toContain("mcp_stdio_command");
    expect(gone.truncated).toBe(true);

    // The flattened observation shape reads the same raw structure.
    await ingest(c, {}, { name: "flat", manifest: undefined, bin: ["bin/tool\u0007"] });
    const flat = tables.capability_observation.find((r: any) => r.name === "flat");
    expect(flat.surfaces).toContain("ships_bin");
    expect(flat.truncated).toBe(true);
  });

  test("two machines refusing the same byte still confirm a row that keeps its surface", async () => {
    // End to end: identical degraded payloads sanitize to identical stored
    // manifests, so they hash alike and confirm — and the confirmed row must
    // carry the full surface set, because consent reads it.
    const tables = await tokenTables();
    const c = ctx(null, tables);
    const payload = { manifest: { mcp: [{ name: "evil", command: "evil\u0007run" }], allowedTools: ["Bash"] } };
    await ingest(c, {}, payload);
    const second = await ingest(c, { device_id: "dev_b" }, payload);
    expect(second.confirmed).toBe(true);
    const row = tables.capability_observation[0];
    expect(row.surfaces).toEqual(expect.arrayContaining(["mcp_stdio_command", "declares_allowed_tools"]));
    expect(row.truncated).toBe(true);
  });

  test("empty or junk-typed manifest fields imply no surfaces and no partial flag", async () => {
    // Raising surfaces off junk would cry wolf on every malformed report; only
    // a non-blank string is something the machine genuinely reported.
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await ingest(c, {}, {
      name: "junky",
      manifest: {
        bin: [],
        scripts: "not-a-list",
        hooks: [7, null, "   "],
        mcp: [{ name: "clean-remote", url: "https://x.dev/mcp" }],
      },
    });
    const row = tables.capability_observation.find((r: any) => r.name === "junky");
    expect(row.surfaces).toEqual(["mcp_remote_url"]);
    expect(row.truncated).toBeUndefined();
  });

  test("an over-long name is refused — clipped, it would address the wrong row", async () => {
    // (user, client, kind, name) is the row's index key. Two over-long names
    // clipped to one key would thrash a single row: each re-observation reads
    // as a manifest change and resets the other's device agreement.
    const tables = await tokenTables();
    const c = ctx(null, tables);
    expect(await ingest(c, {}, { name: "n".repeat(MAX_NAME_CHARS) + "-alpha" })).toEqual({
      status: "rejected",
      reason: "missing_identity",
    });
    expect(tables.capability_observation).toHaveLength(0);
  });

  test("a client-supplied manifest_hash is ignored and recomputed from what we stored", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await ingest(c, {}, { manifest_hash: "attacker-chosen" });
    const row = tables.capability_observation[0];
    expect(row.manifest_hash).not.toBe("attacker-chosen");
    expect(row.manifest_hash).toBe(
      manifestHash(normalizeManifest({ mcp: [{ name: "evil", command: "npx -y @evil/thing" }] }).manifest),
    );
  });

  test("a byte-identical re-report performs ZERO writes", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await ingest(c);
    const inserts = c.db._inserted.length;
    const result = await ingest(c);
    expect(result.status).toBe("unchanged");
    // The fact, not the claim: the patch log is empty and nothing new landed.
    expect(c.db._patched).toHaveLength(0);
    expect(c.db._inserted).toHaveLength(inserts);
  });

  test("a single-device observation is not confirmed; a second independent device confirms it", async () => {
    // One machine's word proves what one machine says. Team sharing gates on
    // `confirmed`, so a compromised laptop cannot publish "markdown only" alone.
    const tables = await tokenTables();
    const c = ctx(null, tables);
    const first = await ingest(c);
    expect(first.confirmed).toBe(false);
    // The same device again proves nothing new.
    await ingest(c);
    expect(tables.capability_observation[0].confirmed).toBe(false);
    const second = await ingest(c, { device_id: "dev_b" });
    expect(second.confirmed).toBe(true);
    expect(tables.capability_observation[0].device_ids).toEqual(["dev_a", "dev_b"]);
  });

  test("a changed manifest resets the agreement to the machine that saw it", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await ingest(c);
    await ingest(c, { device_id: "dev_b" });
    expect(tables.capability_observation[0].confirmed).toBe(true);
    const changed = await ingest(c, { device_id: "dev_b" }, {
      manifest: { mcp: [{ name: "evil", command: "npx -y @evil/thing@2" }], bin: ["bin/payload"] },
    });
    expect(changed.status).toBe("updated");
    const row = tables.capability_observation[0];
    expect(row.confirmed).toBe(false);
    expect(row.device_ids).toEqual(["dev_b"]);
    expect(row.surfaces).toContain("ships_bin");
    expect(tables.capability_observation).toHaveLength(1);
  });

  test("env VALUES never reach the stored manifest — names only", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await ingest(c, {}, {
      manifest: { envKeys: ["GITHUB_TOKEN", "AWS_KEY=sk-live-secret", "not a name"] },
    });
    const stored = JSON.parse(tables.capability_observation[0].manifest_json);
    expect(stored.envKeys).toEqual(["GITHUB_TOKEN"]);
  });

  test("structure implies surfaces: bin, hooks and allowed-tools each classify", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await ingest(c, {}, {
      name: "loaded",
      manifest: { bin: ["bin/tool"], hooks: ["PostToolUse"], "allowed-tools": ["Bash"] },
    });
    const row = tables.capability_observation.find((r: any) => r.name === "loaded");
    expect(row.surfaces).toEqual(
      expect.arrayContaining(["ships_bin", "declares_hooks", "declares_allowed_tools"]),
    );
    expect(row.surfaces).not.toContain("mcp_stdio_command");
  });

  test("a manifest list over its cap stores truncated:true, never a silent cut", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await ingest(c, {}, {
      manifest: { bin: Array.from({ length: MAX_MANIFEST_LIST + 5 }, (_, i) => `bin/t${i}`) },
    });
    const row = tables.capability_observation[0];
    expect(row.truncated).toBe(true);
    expect(JSON.parse(row.manifest_json).bin).toHaveLength(MAX_MANIFEST_LIST);
  });

  test("malformed input is a refusal, not a throw and not a row", async () => {
    const tables = await tokenTables();
    const c = ctx(null, tables);
    expect(await ingest(c, { raw_json: "{not json" })).toEqual({ status: "rejected", reason: "unparseable_json" });
    expect(await ingest(c, { raw_json: JSON.stringify({ manifest: {} }) })).toEqual({
      status: "rejected",
      reason: "missing_identity",
    });
    expect(await ingest(c, { device_id: " " })).toEqual({ status: "rejected", reason: "invalid_device_id" });
    expect(tables.capability_observation).toHaveLength(0);
  });
});

/* ========================================================================== */

describe("capabilityTables", () => {
  test("every index on a tenant-carrying table leads with user_id", () => {
    // A tenantless index is a cross-tenant read waiting for a caller who
    // forgets the filter (publicFunctionSecretLeak.test.ts is the scar).
    const tenantless: string[] = [];
    for (const [name, table] of Object.entries(capabilityTables)) {
      const exported = (table as any).export();
      const fields = Object.keys(exported.documentType?.value ?? {});
      if (!fields.includes("user_id")) {
        tenantless.push(name);
        continue;
      }
      for (const index of exported.indexes) {
        // Each entry here is a JUSTIFIED exception, argued at the index
        // definition: by_team_created's reader is requireTeamAdmin (the tenant
        // is the team), by_created serves only the internal retention sweep.
        // Adding to this list is a review event, not a convenience.
        const allowed = [
          "capability_events.by_team_created",
          "capability_events.by_created",
          // Team bindings are read by team members and written by team admins;
          // the tenant of this index is the team, gated at every reader.
          "capability_bindings.by_team_updated",
        ];
        if (allowed.includes(`${name}.${index.indexDescriptor}`)) continue;
        expect(`${name}.${index.indexDescriptor} starts with ${index.fields[0]}`).toBe(
          `${name}.${index.indexDescriptor} starts with user_id`,
        );
      }
    }
    // Public data only. A new table skipping the tenant rule must show up here
    // as a diff someone has to justify, not slide through the loop above.
    expect(tenantless).toEqual(["capability_catalog_cache"]);
  });
});

/* ========================================================================== */

describe("webList", () => {
  test("unauthenticated reads an empty fleet instead of throwing", async () => {
    const tables = await tokenTables({ capability_state: [stateRow({})] });
    expect(await (webList as any)._handler(ctx(null, tables), {})).toEqual({ items: [], truncated: false });
  });

  test("a listing that hit its cap says so", async () => {
    // The index is ordered by device id, so a silent cut drops whole machines
    // off the end. A reader that believes it has the fleet would then render
    // those machines as gone.
    const tables = await tokenTables({
      capability_state: Array.from({ length: 260 }, (_, i) =>
        stateRow({ _id: `cs_${i}`, device_id: `dev_${String(i).padStart(3, "0")}` }),
      ),
    });
    const result = await (webList as any)._handler(ctx(OWNER, tables), {});
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(200);

    const small = await (webList as any)._handler(
      ctx(OWNER, await tokenTables({ capability_state: [stateRow({})] })),
      {},
    );
    expect(small.truncated).toBe(false);
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

  test("a device_id filter no machine can have answers empty, not the whole fleet", async () => {
    // The write path refuses these ids, so no row can carry one. Dropping the
    // filter instead would list every machine — the caller asked about one
    // machine and would read the fleet as its answer.
    const tables = await tokenTables({
      capability_state: [stateRow({ _id: "a", device_id: "dev_a" })],
    });
    for (const bad of ["d".repeat(201), "/etc/machine-id", "dev\u0007a"]) {
      const result = await (webList as any)._handler(ctx(OWNER, tables), { device_id: bad });
      expect(result.items).toEqual([]);
    }
    // A blank filter still means "no filter", same as omitting it.
    const all = await (webList as any)._handler(ctx(OWNER, tables), { device_id: "  " });
    expect(all.items).toHaveLength(1);
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

  test("an item shaped nothing like an item costs its row, not the page", () => {
    // `foldFleet` is exported, unit-tested standalone, and phase 2 adds a second
    // writer, so it cannot lean on `parseInventory` having run first. A name that
    // is a number used to throw on `identity.toLowerCase()` and take the whole
    // fleet page down with it.
    const junk = {
      items: [
        { kind: "skill", name: 7 },
        { kind: 42, name: "numbered-kind" },
        { kind: "skill", name: "   " },
        null,
        { kind: "plugin", name: "p", meta: { sha: 9, marketplace: ["m"] } },
        { kind: "mcp", name: "gh", meta: { url: 12 } },
        SKILL,
      ],
      marketplaces: [{ name: null }, { name: "official", repo: 5 }],
    } as unknown as NormalizedInventory;
    const folded = foldFleet(devices("a", "b"), new Map([["a", [junk]], ["b", [inv([SKILL])]]]));
    expect(folded.rows.map((r) => r.key).sort()).toEqual([
      "marketplace:official",
      "mcp:gh",
      "plugin:p",
      "skill:domain-search",
    ]);
    // A junk pin is no pin — an unknown value must never read as a different one.
    const plugin = folded.rows.find((r) => r.kind === "plugin")!;
    expect(plugin.pins).toEqual([]);
    expect(plugin.identity).toBe("p");
    expect(folded.rows.find((r) => r.kind === "mcp")!.pins).toEqual([]);
  });

  test("an over-long name in a raw inventory has no row key — dropped, not clipped", () => {
    // `foldFleet` re-derives from `unknown` because a second writer arrives in
    // phase 2, so the refusal has to hold here too, not just in the parser: a
    // hostile daemon could otherwise craft two long names that clip into one
    // key and hide one capability's drift behind the other's row.
    const raw = {
      items: [
        { kind: "skill", name: "n".repeat(MAX_NAME_CHARS) + "-alpha" },
        { kind: "skill", name: "n".repeat(MAX_NAME_CHARS) + "-beta" },
        SKILL,
      ],
      marketplaces: [],
    } as unknown as NormalizedInventory;
    const folded = foldFleet(devices("a", "b"), new Map([["a", [raw]], ["b", [inv([SKILL])]]]));
    expect(folded.rows.map((r) => r.key)).toEqual(["skill:domain-search"]);
  });

  test("an inventory whose arrays are missing or are not arrays is an empty column", () => {
    for (const wrong of [{}, { items: "nope", marketplaces: 3 }, null]) {
      const folded = foldFleet(devices("a", "b"), new Map([
        ["a", [wrong as unknown as NormalizedInventory]],
        ["b", [inv([SKILL])]],
      ]));
      expect(folded.rows[0].cells.map((c) => c.status)).toEqual(["absent", "same"]);
    }
    // …and so is a device whose report list is not a list at all.
    const folded = foldFleet(devices("a", "b"), new Map([
      ["a", "nonsense" as unknown as NormalizedInventory[]],
      ["b", [inv([SKILL])]],
    ]));
    expect(folded.rows[0].cells.map((c) => c.status)).toEqual(["absent", "same"]);
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

  test("every machine that reported reads as reported, past any fleet-wide row cap", async () => {
    // The bug this pins: one `take` over the fleet consumed rows in device-id
    // order, so the machines that sorted last got none and rendered as "never
    // reported" — the module's own `unknown` versus `absent` distinction broken
    // by its own bound, on a machine that had just reported.
    const ids = Array.from({ length: 10 }, (_, i) => `dev_${String(i).padStart(2, "0")}`);
    const states: any[] = [];
    for (const id of ids) {
      states.push(stateRow({ _id: `${id}_user`, device_id: id, scope_key: "" }));
      for (let s = 1; s < MAX_SCOPE_ROWS_PER_DEVICE; s++) {
        states.push(stateRow({ _id: `${id}_p${s}`, device_id: id, scope_key: `git:repo-${s}` }));
      }
    }
    const tables = await tokenTables({
      devices: ids.map((id, i) => ({ _id: `d${i}`, user_id: OWNER, device_id: id, label: id })),
      capability_state: states,
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), {});
    expect(result.devices.every((d: any) => d.reported)).toBe(true);
    expect(result.summary).toMatchObject({ devices: 10, reporting: 10 });
    expect(result.devices_truncated).toBe(false);
    // Identical inventories, so every cell agrees. One "unknown" here would be
    // the lie.
    expect(new Set(result.rows[0].cells.map((c: any) => c.status))).toEqual(new Set(["same"]));
  });

  test("a fleet past the device cap drops columns rather than inventing unknown ones", async () => {
    const count = MAX_FLEET_DEVICES + 5;
    const ids = Array.from({ length: count }, (_, i) => `dev_${String(i).padStart(3, "0")}`);
    const tables = await tokenTables({
      // The oldest five are the ones we can afford to leave out; `last_seen`
      // decides, so the machines a person is using keep their columns.
      devices: ids.map((id, i) => ({
        _id: `d${i}`,
        user_id: OWNER,
        device_id: id,
        label: id,
        last_seen: i < 5 ? 1 : 1000 + i,
      })),
      capability_state: ids.map((id) => stateRow({ _id: `cs_${id}`, device_id: id })),
    });
    const result = await (webFleetDiff as any)._handler(ctx(OWNER, tables), {});
    expect(result.devices).toHaveLength(MAX_FLEET_DEVICES);
    expect(result.devices_truncated).toBe(true);
    expect(result.devices.map((d: any) => d.deviceId)).not.toContain("dev_000");
    // Columns follow the roster's own order, so a heartbeat cannot reshuffle the
    // grid under someone reading it.
    const shown = result.devices.map((d: any) => d.deviceId);
    expect([...shown].sort()).toEqual(shown);
    // Nothing reads as unknown: a machine we chose not to compare has no column.
    expect(result.rows[0].cells.every((c: any) => c.status !== "unknown")).toBe(true);
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

  test("the detail blob cannot rewrite the card it is attached to", async () => {
    // The slug prefix check on ingest is the only thing stopping a third party
    // from publishing under a `builtin/` name. The detail blob is never
    // validated, so a card built by spreading it last would hand that identity
    // straight back — the hijack, arriving through the one field nobody checks.
    const tables = await tokenTables();
    const c = ctx(null, tables);
    await (upsertCatalogEntries as any)._handler(c, {
      source: "marketplace",
      origin: "evil-mkt",
      entries: [
        {
          slug: "mkt/evil-mkt/impostor",
          kind: "plugin",
          name: "Impostor",
          detail: {
            slug: "builtin/memory",
            name: "Memory",
            kind: "snippet",
            source: "builtin",
            publisher: "Anthropic",
            marketplace: undefined,
            updatedAt: 0,
            installs: [{ deviceId: "dev_a", scope: "user", enabled: true }],
            cost: { alwaysOn: 10 },
          },
        },
      ],
    });
    const result = await (webCatalogList as any)._handler(ctx(OWNER, tables), {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page[0]).toMatchObject({
      slug: "mkt/evil-mkt/impostor",
      name: "Impostor",
      kind: "plugin",
      source: "marketplace",
      marketplace: "evil-mkt",
      // Ingest computed no publisher for this row, and the payload does not get
      // to supply one.
      publisher: undefined,
      updatedAt: expect.any(Number),
    });
    // Which machines have it is the browser's answer, from the reader's own
    // fleet. A catalog cannot claim it is already installed anywhere.
    expect("installs" in result.page[0]).toBe(false);
    // A field we do not model still rides along — that is what the blob is for.
    expect(result.page[0].cost).toEqual({ alwaysOn: 10 });
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

// ------------------------------------------------------- owner read queries

// The CLI's flat read shape (ct-42827). entries_json stays opaque on this wire;
// the property these tests guard is SCOPING: the index leads with user_id and
// the caller is the user, so no cross-user row is reachable however the args
// are shaped.
describe("listCapabilityState / getDeviceCapabilityState", () => {
  test("returns only the caller's rows, opaque entries intact", async () => {
    const t = await tokenTables({
      capability_state: [
        stateRow({ _id: "cs_mine", device_id: "dev_a" }),
        stateRow({ _id: "cs_theirs", user_id: "u_other", device_id: "dev_x" }),
      ],
    });
    const rows = await (listCapabilityState as any)._handler(ctx(null, t), { api_token: TOKEN });
    expect(rows).toHaveLength(1);
    expect(rows[0].device_id).toBe("dev_a");
    expect(typeof rows[0].entries_json).toBe("string");
    expect(rows[0].hash.length).toBeGreaterThan(0);
  });

  test("device query narrows by device and optionally by scope", async () => {
    const t = await tokenTables({
      capability_state: [
        stateRow({ _id: "cs_u", device_id: "dev_a", scope_key: "" }),
        stateRow({ _id: "cs_p", device_id: "dev_a", scope_key: "git:github.com/o/r" }),
        stateRow({ _id: "cs_b", device_id: "dev_b", scope_key: "" }),
      ],
    });
    const all = await (getDeviceCapabilityState as any)._handler(ctx(null, t), {
      api_token: TOKEN,
      device_id: "dev_a",
    });
    expect(all).toHaveLength(2);
    const scoped = await (getDeviceCapabilityState as any)._handler(ctx(null, t), {
      api_token: TOKEN,
      device_id: "dev_a",
      scope_key: "git:github.com/o/r",
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].hash).toBeDefined();
  });

  test("a bad token is refused, not given an empty list", async () => {
    const t = await tokenTables({ capability_state: [stateRow({})] });
    await expect(
      (listCapabilityState as any)._handler(ctx(null, t), { api_token: "nope" }),
    ).rejects.toThrow("Unauthorized");
  });
});

// -------------------------------------------------------- the since watermark

// The store polls this query and feeds pages into syncTable without pruning, so
// re-sending unchanged rows every poll is pure churn. The watermark contract:
// a second call with `since` set to the first call's max returns nothing.
describe("webList since watermark", () => {
  test("a quiet fleet costs zero rows on the second call", async () => {
    const t = await tokenTables({
      capability_state: [
        stateRow({ _id: "cs_1", device_id: "dev_a", reported_at: 1000 }),
        stateRow({ _id: "cs_2", device_id: "dev_b", reported_at: 2000 }),
      ],
    });
    const first = await (webList as any)._handler(ctx(OWNER, t), {});
    expect(first.items).toHaveLength(2);
    const max = Math.max(...first.items.map((i: any) => i.reported_at));
    const second = await (webList as any)._handler(ctx(OWNER, t), { since: max });
    expect(second.items).toHaveLength(0);
  });

  test("only the changed row rides after a new report", async () => {
    const t = await tokenTables({
      capability_state: [
        stateRow({ _id: "cs_1", device_id: "dev_a", reported_at: 1000 }),
        stateRow({ _id: "cs_2", device_id: "dev_b", reported_at: 3000 }),
      ],
    });
    const delta = await (webList as any)._handler(ctx(OWNER, t), { since: 1000 });
    expect(delta.items).toHaveLength(1);
    expect(delta.items[0].device_id).toBe("dev_b");
  });

  test("another user's rows never appear, watermark or not", async () => {
    const t = await tokenTables({
      capability_state: [
        stateRow({ _id: "cs_them", user_id: "u_other", reported_at: 9999 }),
      ],
    });
    const out = await (webList as any)._handler(ctx(OWNER, t), { since: 0 });
    expect(out.items).toHaveLength(0);
  });
});
