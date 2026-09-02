import { describe, it, expect } from "bun:test";
import { compareVersions, isBelowMinimum, isValidVersion, createKillSwitch, INVALID_VERSION_MESSAGE } from "./killSwitch";

describe("compareVersions", () => {
  it("orders numerically per segment", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("1.2.9", "1.2.10")).toBe(-1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });
  it("isBelowMinimum: null minimum never below", () => {
    expect(isBelowMinimum("1.0.0", null)).toBe(false);
    expect(isBelowMinimum("1.0.0", "")).toBe(false);
    expect(isBelowMinimum("1.0.0", "1.0.1")).toBe(true);
    expect(isBelowMinimum("1.0.1", "1.0.1")).toBe(false);
  });
  it("isValidVersion", () => {
    expect(isValidVersion("1.0.12")).toBe(true);
    expect(isValidVersion("v1.0.12")).toBe(false);
    expect(isValidVersion("1.0")).toBe(false);
  });
});

describe("createKillSwitch", () => {
  const make = () => {
    const rows: Record<string, { value: string; by: string }> = {};
    const ks = createKillSwitch<string>({
      storage: {
        get: async (k) => rows[k]?.value ?? null,
        set: async (k, value, by) => {
          rows[k] = { value, by };
        },
      },
      authenticate: async (token) =>
        token === "admin" ? { userId: "u1", admin: true } : token === "user" ? { userId: "u2", admin: false } : null,
    });
    return { ks, rows };
  };
  it("admin sets, everyone reads, clients compare", async () => {
    const { ks, rows } = make();
    expect(await ks.getMinimum("min_cli_version")).toBeNull();
    expect(await ks.mustUpdate("min_cli_version", "0.0.1")).toBe(false);
    expect(await ks.setMinimum("min_cli_version", "1.2.3", "admin")).toEqual({ success: true, version: "1.2.3" });
    expect(rows.min_cli_version).toEqual({ value: "1.2.3", by: "u1" });
    expect(await ks.mustUpdate("min_cli_version", "1.2.2")).toBe(true);
    expect(await ks.mustUpdate("min_cli_version", "1.2.3")).toBe(false);
  });
  it("refuses bad tokens, non admins, bad versions", async () => {
    const { ks } = make();
    await expect(ks.setMinimum("min_cli_version", "1.0.0", "nope")).rejects.toThrow("Unauthorized");
    await expect(ks.setMinimum("min_cli_version", "1.0.0", "user")).rejects.toThrow("Admin access required");
    await expect(ks.setMinimum("min_cli_version", "1.0", "admin")).rejects.toThrow(INVALID_VERSION_MESSAGE);
  });
});
