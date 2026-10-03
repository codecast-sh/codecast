import { describe, expect, test } from "bun:test";
import { areaColor, areaFill, areaVar, ink } from "../areaColor";

describe("areaColor", () => {
  test("named areas and surfaces share one color", () => {
    expect(areaColor("web")).toBe("var(--sol-blue)");
    expect(areaColor("cli")).toBe("var(--sol-green)");
    expect(areaColor("convex")).toBe(areaColor("backend"));
    expect(areaColor("desktop")).toBe(areaColor("electron"));
    expect(areaColor("docs")).toBe("var(--sol-text-dim)");
    expect(areaColor("CLI")).toBe(areaColor("cli"));
  });

  test("an unnamed area hashes to a stable accent, never a hex", () => {
    const a = areaVar("billing");
    expect(a).toBe(areaVar("billing"));
    expect(a).toMatch(/^--sol-(blue|cyan|green|violet|magenta|orange|yellow)$/);
    const spread = new Set(["api", "billing", "infra", "ios", "android", "site", "auth", "search"].map(areaVar));
    expect(spread.size).toBeGreaterThan(2);
  });

  test("fills and ink mix a theme variable", () => {
    expect(areaFill("web")).toBe("color-mix(in srgb, var(--sol-blue) 14%, transparent)");
    expect(ink(42.4)).toBe("color-mix(in srgb, var(--sol-text) 42%, transparent)");
  });
});
