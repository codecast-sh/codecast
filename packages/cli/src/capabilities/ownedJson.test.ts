import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyOwnedJson,
  encodeKeyPath,
  LEDGER_SCHEMA_VERSION,
  ledgerPathFor,
  planJsonMerge,
  readLedger,
  readLedgerDetailed,
  type OwnedKey,
} from "./ownedJson.js";

const tmpDirs: string[] = [];
function tmpTarget(seed: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ledger-"));
  tmpDirs.push(dir);
  const target = path.join(dir, "settings.json");
  fs.writeFileSync(target, JSON.stringify(seed, null, 2) + "\n");
  return target;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const key = (...p: string[]) => p;
const want = (keyPath: string[], value: unknown): OwnedKey => ({ keyPath, value });

const PLUGIN = key("enabledPlugins", "frontend-design@claude-plugins-official");
const OTHER = key("enabledPlugins", "code-simplifier@claude-plugins-official");

describe("planJsonMerge — the five ownership rules", () => {
  test("never touches a key we do not own", () => {
    const current = { permissions: { allow: ["Bash(ls)"] }, enabledPlugins: { "theirs@m": true } };
    const plan = planJsonMerge(current, [want(PLUGIN, true)], {});
    expect(plan.next).toMatchObject({
      permissions: { allow: ["Bash(ls)"] },
      enabledPlugins: { "theirs@m": true, "frontend-design@claude-plugins-official": true },
    });
    expect(plan.removals).toEqual([]);
  });

  test("updates a key we own and that nobody changed", () => {
    const ledger = { [encodeKeyPath(PLUGIN)]: true };
    const plan = planJsonMerge({ enabledPlugins: { "frontend-design@claude-plugins-official": true } }, [want(PLUGIN, false)], ledger);
    expect(plan.writes).toEqual([PLUGIN]);
    expect(plan.next).toMatchObject({ enabledPlugins: { "frontend-design@claude-plugins-official": false } });
    expect(plan.conflicts).toEqual([]);
  });

  test("leaves a key the user changed, and reports the conflict", () => {
    const ledger = { [encodeKeyPath(PLUGIN)]: true };
    const current = { enabledPlugins: { "frontend-design@claude-plugins-official": false } }; // user turned it off
    const plan = planJsonMerge(current, [want(PLUGIN, true)], ledger);
    expect(plan.writes).toEqual([]);
    expect(plan.next).toMatchObject({ enabledPlugins: { "frontend-design@claude-plugins-official": false } });
    expect(plan.conflicts).toMatchObject([{ keyPath: PLUGIN, ours: true, theirs: false, intent: "update" }]);
  });

  test("removes a key we own once it is no longer wanted", () => {
    const ledger = { [encodeKeyPath(PLUGIN)]: true };
    const plan = planJsonMerge({ enabledPlugins: { "frontend-design@claude-plugins-official": true } }, [], ledger);
    expect(plan.removals).toEqual([PLUGIN]);
    expect(plan.next).toEqual({});
    expect(plan.ledger).toEqual({});
  });

  // The subtle one. Deleting a value the user has since edited would destroy
  // their work just because we happened to write it first.
  test("does not remove a key the user has taken over", () => {
    const ledger = { [encodeKeyPath(PLUGIN)]: true };
    const current = { enabledPlugins: { "frontend-design@claude-plugins-official": false } };
    const plan = planJsonMerge(current, [], ledger);
    expect(plan.removals).toEqual([]);
    expect(plan.next).toMatchObject({ enabledPlugins: { "frontend-design@claude-plugins-official": false } });
    expect(plan.conflicts).toMatchObject([{ intent: "remove", ours: true, theirs: false }]);
    expect(plan.ledger).toEqual({}); // stop claiming it
  });

  test("adopting a key that already holds the value we wanted writes nothing", () => {
    const current = { enabledPlugins: { "frontend-design@claude-plugins-official": true } };
    const plan = planJsonMerge(current, [want(PLUGIN, true)], {});
    expect(plan.changed).toBe(false);
    expect(plan.conflicts).toEqual([]);
    expect(plan.ledger).toEqual({ [encodeKeyPath(PLUGIN)]: true });
  });

  test("a pre-existing key with a different value is a conflict, not an overwrite", () => {
    const current = { enabledPlugins: { "frontend-design@claude-plugins-official": false } };
    const plan = planJsonMerge(current, [want(PLUGIN, true)], {});
    expect(plan.changed).toBe(false);
    expect(plan.conflicts).toMatchObject([{ intent: "update", theirs: false }]);
  });
});

describe("planJsonMerge — structure", () => {
  test("does not mutate the input document", () => {
    const current = { enabledPlugins: { "theirs@m": true } };
    const snapshot = JSON.stringify(current);
    planJsonMerge(current, [want(PLUGIN, true)], {});
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  test("creates missing containers on the way to a key", () => {
    const plan = planJsonMerge({}, [want(key("mcpServers", "sentry"), { type: "http" })], {});
    expect(plan.next).toEqual({ mcpServers: { sentry: { type: "http" } } });
  });

  test("prunes a container we emptied", () => {
    const ledger = { [encodeKeyPath(key("mcpServers", "sentry"))]: { type: "http" } };
    const plan = planJsonMerge({ mcpServers: { sentry: { type: "http" } } }, [], ledger);
    expect(plan.next).toEqual({});
  });

  test("keeps a container that still holds someone else's key", () => {
    const ledger = { [encodeKeyPath(key("mcpServers", "sentry"))]: { type: "http" } };
    const current = { mcpServers: { sentry: { type: "http" }, theirs: { command: "node" } } };
    const plan = planJsonMerge(current, [], ledger);
    expect(plan.next).toEqual({ mcpServers: { theirs: { command: "node" } } });
  });

  test("compares object values structurally, not by reference", () => {
    const server = { type: "http", url: "https://x" };
    const ledger = { [encodeKeyPath(key("mcpServers", "s"))]: { ...server } };
    const plan = planJsonMerge({ mcpServers: { s: { ...server } } }, [want(key("mcpServers", "s"), { ...server })], ledger);
    expect(plan.changed).toBe(false);
    expect(plan.conflicts).toEqual([]);
  });

  test("a key whose name contains dots and at-signs round-trips", () => {
    const odd = key("enabledPlugins", "a.b@c.d");
    const plan = planJsonMerge({}, [want(odd, true)], {});
    expect(plan.next).toEqual({ enabledPlugins: { "a.b@c.d": true } });
    expect(Object.keys(plan.ledger)).toEqual([encodeKeyPath(odd)]);
  });

  test("a non-object file is replaced rather than crashing", () => {
    const plan = planJsonMerge("not an object", [want(PLUGIN, true)], {});
    expect(plan.next).toEqual({ enabledPlugins: { "frontend-design@claude-plugins-official": true } });
  });
});

describe("applyOwnedJson on disk", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-owned-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  test("writes the file and a ledger beside it", () => {
    const dir = tmp();
    const target = path.join(dir, "settings.json");
    const r = applyOwnedJson(target, [want(PLUGIN, true)]);
    expect(r.wrote).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      enabledPlugins: { "frontend-design@claude-plugins-official": true },
    });
    expect(readLedger(target)).toEqual({ [encodeKeyPath(PLUGIN)]: true });
    expect(fs.existsSync(ledgerPathFor(target))).toBe(true);
  });

  test("a second identical apply writes nothing — no watcher storm", () => {
    const dir = tmp();
    const target = path.join(dir, "settings.json");
    applyOwnedJson(target, [want(PLUGIN, true)]);
    const before = fs.statSync(target).mtimeMs;
    const r = applyOwnedJson(target, [want(PLUGIN, true)]);
    expect(r.wrote).toBe(false);
    expect(r.changed).toBe(false);
    expect(fs.statSync(target).mtimeMs).toBe(before);
  });

  test("preserves unrelated content the user owns", () => {
    const dir = tmp();
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, model: "opus" }, null, 2));
    applyOwnedJson(target, [want(PLUGIN, true)]);
    const doc = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(doc.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(doc.model).toBe("opus");
  });

  test("removal restores the file to what it was before we touched it", () => {
    const dir = tmp();
    const target = path.join(dir, "settings.json");
    const original = { permissions: { allow: ["Bash(ls)"] } };
    fs.writeFileSync(target, JSON.stringify(original, null, 2) + "\n");
    applyOwnedJson(target, [want(PLUGIN, true), want(OTHER, true)]);
    applyOwnedJson(target, []);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual(original);
    // With nothing left to track, the ledger file goes away too.
    expect(fs.existsSync(ledgerPathFor(target))).toBe(false);
  });

  test("dryRun previews exactly what a real apply would do, and touches nothing", () => {
    const dir = tmp();
    const target = path.join(dir, "settings.json");
    const preview = applyOwnedJson(target, [want(PLUGIN, true)], { dryRun: true });
    expect(preview.wrote).toBe(false);
    expect(fs.existsSync(target)).toBe(false);

    const real = applyOwnedJson(target, [want(PLUGIN, true)]);
    expect(real.writes).toEqual(preview.writes);
    expect(real.removals).toEqual(preview.removals);
    expect(real.next).toEqual(preview.next);
  });

  test("a hand-edited value survives, and is reported", () => {
    const dir = tmp();
    const target = path.join(dir, "settings.json");
    applyOwnedJson(target, [want(PLUGIN, true)]);
    // The user turns it off by hand.
    fs.writeFileSync(target, JSON.stringify({ enabledPlugins: { "frontend-design@claude-plugins-official": false } }, null, 2));
    const r = applyOwnedJson(target, [want(PLUGIN, true)]);
    expect(r.conflicts).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(target, "utf-8")).enabledPlugins["frontend-design@claude-plugins-official"]).toBe(false);
    // And we stop claiming it, so a later removal cannot delete their choice.
    expect(readLedger(target)).toEqual({});
    expect(applyOwnedJson(target, []).removals).toEqual([]);
  });

  test("a malformed target is rebuilt rather than throwing", () => {
    const dir = tmp();
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, "{ not json");
    const r = applyOwnedJson(target, [want(PLUGIN, true)]);
    expect(r.wrote).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      enabledPlugins: { "frontend-design@claude-plugins-official": true },
    });
  });

  test("writes a real .mcp.json the way the materializer will", () => {
    const dir = tmp();
    const target = path.join(dir, ".mcp.json");
    const server = { type: "http", url: "https://mcp.example.dev/mcp" };
    applyOwnedJson(target, [want(key("mcpServers", "example"), server)]);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ mcpServers: { example: server } });
    applyOwnedJson(target, []);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({});
  });
});

// ------------------------------------------------- the versioned, MACed ledger

describe("ledger envelope (schema_version + MAC)", () => {
  test("a fresh write produces a versioned envelope, and reads back", () => {
    const target = tmpTarget({});
    applyOwnedJson(target, [{ keyPath: ["a"], value: 1 }]);
    const raw = JSON.parse(fs.readFileSync(ledgerPathFor(target), "utf-8"));
    expect(raw.schema_version).toBe(LEDGER_SCHEMA_VERSION);
    expect(raw.entries).toBeDefined();
    const detailed = readLedgerDetailed(target);
    expect(detailed.needsUpgrade).toBe(false);
    expect(detailed.tampered).toBe(false);
    expect(Object.keys(detailed.entries)).toHaveLength(1);
  });

  test("a legacy bare-map ledger stays readable and upgrades on the next write", () => {
    const target = tmpTarget({ a: 1 });
    fs.writeFileSync(ledgerPathFor(target), JSON.stringify({ a: 1 }) + "\n");
    expect(readLedger(target)).toEqual({ a: 1 });
    // The upgrade happens on the next REAL write — an unchanged apply stays
    // zero-write (that property has its own tests) and must not churn mtimes
    // just to modernize an envelope.
    applyOwnedJson(target, [{ keyPath: ["a"], value: 2 }]);
    const raw = JSON.parse(fs.readFileSync(ledgerPathFor(target), "utf-8"));
    expect(raw.schema_version).toBe(LEDGER_SCHEMA_VERSION);
  });

  test("a NEWER schema version means write nothing, remove nothing, say upgrade", () => {
    const target = tmpTarget({ a: 1, keep: "user value" });
    const before = fs.readFileSync(target, "utf-8");
    fs.writeFileSync(
      ledgerPathFor(target),
      JSON.stringify({ schema_version: LEDGER_SCHEMA_VERSION + 1, entries: { a: 1 }, future_field: true }) + "\n",
    );
    const result = applyOwnedJson(target, [{ keyPath: ["b"], value: 2 }]);
    expect(result.wrote).toBe(false);
    expect(result.conflicts.some((c: any) => c.reason === "ledger_needs_upgrade")).toBe(true);
    // The document AND the newer ledger are byte-untouched — unknown entries
    // are preserved by not touching the file at all.
    expect(fs.readFileSync(target, "utf-8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(ledgerPathFor(target), "utf-8")).future_field).toBe(true);
  });

  test("a tampered MAC is reported, and the entries stay readable", () => {
    const target = tmpTarget({});
    applyOwnedJson(target, [{ keyPath: ["a"], value: 1 }]);
    const raw = JSON.parse(fs.readFileSync(ledgerPathFor(target), "utf-8"));
    if (raw.mac === undefined) {
      // No machine key on this runner: the MAC layer is honestly absent.
      return;
    }
    raw.entries.a = 999; // hand-edit without re-MACing
    fs.writeFileSync(ledgerPathFor(target), JSON.stringify(raw) + "\n");
    const detailed = readLedgerDetailed(target);
    expect(detailed.tampered).toBe(true);
    expect(detailed.entries.a).toBe(999);
  });
});
