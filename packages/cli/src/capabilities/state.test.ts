import { describe, expect, test } from "bun:test";
import * as crypto from "crypto";
import { buildCapabilityStateReport, MAX_SCOPE_ROWS } from "./state.js";
import type { Inventory, InventoryItem } from "./inventory.js";

const item = (name: string, scope: InventoryItem["scope"] = "user", scopeKey?: string): InventoryItem => ({
  kind: "skill",
  name,
  scope,
  enabled: true,
  source: `/x/${name}`,
  ...(scopeKey ? { meta: { scopeKey } } : {}),
});

const inv = (items: InventoryItem[]): Inventory => ({ items, marketplaces: [], unreadable: [] });

const hashOf = (report: unknown) =>
  crypto.createHash("sha1").update(JSON.stringify(report)).digest("hex");

describe("buildCapabilityStateReport", () => {
  test("identical inventory twice yields identical serialization (then the gate yields null)", () => {
    // The ride's hash gate (heartbeat.ts) compares serialized payloads, so the
    // property this module owes it is determinism: same inventory, same bytes.
    const inventory = inv([item("a"), item("b", "project", "git:github.com/o/r")]);
    const one = buildCapabilityStateReport(inventory, { enumeratedAll: true });
    const two = buildCapabilityStateReport(inventory, { enumeratedAll: true });
    expect(hashOf(one)).toBe(hashOf(two));
  });

  test("a changed skill yields a new hash", () => {
    const before = buildCapabilityStateReport(inv([item("deploy")]), { enumeratedAll: true });
    const after = buildCapabilityStateReport(inv([item("deploy-v2")]), { enumeratedAll: true });
    expect(hashOf(before)).not.toBe(hashOf(after));
  });

  test("400 scopes produce at most the cap plus one summary", () => {
    const items: InventoryItem[] = [];
    for (let i = 0; i < 400; i++) {
      items.push(item(`skill-${i}`, "project", `git:github.com/o/repo-${String(i).padStart(3, "0")}`));
    }
    const report = buildCapabilityStateReport(inv(items), { enumeratedAll: true });
    expect(report.rows.length).toBe(MAX_SCOPE_ROWS);
    expect(report.overflow).toEqual({ scopes: 400 - MAX_SCOPE_ROWS, items: 400 - MAX_SCOPE_ROWS });
    // The fold is visible, never silent: the omitted tail is counted.
  });

  test("a partial enumeration never sets full:true", () => {
    const report = buildCapabilityStateReport(inv([item("a")]), { enumeratedAll: false });
    expect(report.full).toBe(false);
  });

  test("a capped report is forced to full:false even when the caller claims full", () => {
    // "I showed you everything" and "I folded 350 scopes away" cannot both be
    // true; the server's retention sweep keys on this flag, and a wrong true
    // deletes scopes a partial report merely omitted.
    const items: InventoryItem[] = [];
    for (let i = 0; i < 60; i++) items.push(item(`s${i}`, "project", `git:x/${i}`));
    const report = buildCapabilityStateReport(inv(items), { enumeratedAll: true });
    expect(report.overflow).toBeDefined();
    expect(report.full).toBe(false);
  });

  test("user scope sorts first and keeps its empty key", () => {
    const report = buildCapabilityStateReport(
      inv([item("proj", "project", "git:x/y"), item("home")]),
      { enumeratedAll: true },
    );
    expect(report.rows[0].scope_key).toBe("");
    expect(report.rows[0].items[0].name).toBe("home");
    expect(report.full).toBe(true);
  });
});
