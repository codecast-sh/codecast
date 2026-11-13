import { describe, expect, test } from "bun:test";
import { sanitizeDeviceDisplayName, sanitizeDeviceIcon, sanitizeDeviceIconColor } from "./devices";

describe("sanitizeDeviceDisplayName", () => {
  test("collapses whitespace, trims, and caps at 64", () => {
    expect(sanitizeDeviceDisplayName("  Work   laptop ")).toBe("Work laptop");
    expect(sanitizeDeviceDisplayName("a".repeat(80))).toBe("a".repeat(64));
  });

  test("a blank clears", () => {
    expect(sanitizeDeviceDisplayName("")).toBeNull();
    expect(sanitizeDeviceDisplayName("   ")).toBeNull();
    expect(sanitizeDeviceDisplayName(undefined)).toBeNull();
    expect(sanitizeDeviceDisplayName(null)).toBeNull();
  });
});

describe("sanitizeDeviceIcon", () => {
  test("keeps a token and clears a blank", () => {
    expect(sanitizeDeviceIcon("Rocket")).toBe("rocket");
    expect(sanitizeDeviceIcon("")).toBeNull();
    expect(sanitizeDeviceIcon(null)).toBeNull();
  });

  test("rejects a value that is not a token", () => {
    expect(() => sanitizeDeviceIcon("nope!")).toThrow("icon");
  });
});

describe("sanitizeDeviceIconColor", () => {
  test("keeps a color token and rejects anything else", () => {
    expect(sanitizeDeviceIconColor("Cyan")).toBe("cyan");
    expect(sanitizeDeviceIconColor("")).toBeNull();
    expect(() => sanitizeDeviceIconColor("not a color")).toThrow("color");
  });
});
