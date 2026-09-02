import { describe, it, expect } from "bun:test";
import { defineFeatures } from "./catalog";
import { createFeatureGuard, applyFeatureChange } from "./guard";

const catalog = defineFeatures([{ key: "chat", name: "Team chat", desc: "" }]);
const rows: Record<string, { chat?: boolean }> = { t1: { chat: true }, t2: {} };
const guard = createFeatureGuard<"chat", string>({
  catalog,
  loadFlags: async (id) => rows[id] ?? null,
});

describe("createFeatureGuard", () => {
  it("has: on, off, missing scope, null scope", async () => {
    expect(await guard.has("t1", "chat")).toBe(true);
    expect(await guard.has("t2", "chat")).toBe(false);
    expect(await guard.has("nope", "chat")).toBe(false);
    expect(await guard.has(null, "chat")).toBe(false);
  });
  it("require throws codecast's message", async () => {
    await expect(guard.require("t1", "chat")).resolves.toBeUndefined();
    await expect(guard.require("t2", "chat")).rejects.toThrow(
      "Team chat is not enabled for this team. A team admin can turn it on under Settings → Team.",
    );
  });
  it("require uses the injected fail", async () => {
    class Custom extends Error {}
    await expect(
      guard.require("t2", "chat", (m) => {
        throw new Custom(m);
      }),
    ).rejects.toBeInstanceOf(Custom);
  });
});

describe("applyFeatureChange", () => {
  it("admin flips and returns a new bag", () => {
    expect(applyFeatureChange(catalog, { isAdmin: true, current: {}, key: "chat", enabled: true })).toEqual({ chat: true });
  });
  it("refuses non admins, missing scope, unknown key", () => {
    expect(() => applyFeatureChange(catalog, { isAdmin: false, current: {}, key: "chat", enabled: true })).toThrow(
      "Only admins can change team features",
    );
    expect(() =>
      applyFeatureChange(catalog, { isAdmin: true, current: null, scopeExists: false, key: "chat", enabled: true }),
    ).toThrow("Team not found");
    expect(() => applyFeatureChange(catalog, { isAdmin: true, current: {}, key: "zzz", enabled: true })).toThrow(
      "Unknown feature: zzz",
    );
  });
});
