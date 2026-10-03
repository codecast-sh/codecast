import { describe, expect, test } from "bun:test";
import { areaColor, areaFill, areaLabel, areaVar, assignAreaColors, ink } from "../areaColor";

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
    const spread = new Set(["api", "billing", "infra", "ios", "android", "site", "auth", "search"].map((a) => areaVar(a)));
    expect(spread.size).toBeGreaterThan(2);
  });

  test("fills and ink mix a theme variable", () => {
    expect(areaFill("web")).toBe("color-mix(in srgb, var(--sol-blue) 14%, transparent)");
    expect(ink(42.4)).toBe("color-mix(in srgb, var(--sol-text) 42%, transparent)");
  });

  test("areas on one page never share an accent while the palette lasts", () => {
    // Hashed alone, these two land on the same accent.
    expect(areaVar("landing")).toBe(areaVar("outreach"));
    const colors = assignAreaColors(["outreach", "landing", "backend", "web", "mobile"]);
    expect(areaVar("landing", colors)).not.toBe(areaVar("outreach", colors));
    const vars = ["outreach", "landing", "backend", "web", "mobile"].map((a) => areaVar(a, colors));
    expect(new Set(vars).size).toBe(vars.length);
    for (const v of vars) expect(v).toMatch(/^--sol-[a-z-]+$/);
  });

  test("named areas keep their color, and an unnamed one never takes a named area's on the same page", () => {
    const colors = assignAreaColors(["web", "cli", "convex", "docs", "billing", "infra", "CLI "]);
    expect(areaColor("web", colors)).toBe("var(--sol-blue)");
    expect(areaColor("cli", colors)).toBe("var(--sol-green)");
    expect(areaColor("convex", colors)).toBe("var(--sol-violet)");
    expect(areaColor("docs", colors)).toBe("var(--sol-text-dim)");
    for (const a of ["billing", "infra"]) expect(["--sol-blue", "--sol-green", "--sol-violet"]).not.toContain(areaVar(a, colors));
    // An area the page did not assign still resolves, by name or hash.
    expect(areaColor("desktop", colors)).toBe("var(--sol-cyan)");
    expect(areaVar("search", colors)).toBe(areaVar("search"));
  });

  test("the assignment depends on the set of areas, not their order, and the story areas choose first", () => {
    const a = assignAreaColors(["outreach", "landing", "infra"]);
    const b = assignAreaColors(["infra", "landing", "outreach"]);
    expect([...a]).toEqual([...b]);
    // An area that only holds files inside other stories never moves a story area's color.
    const withRest = assignAreaColors(["outreach", "landing", "infra"], ["aaa", "scripts", "github"]);
    for (const k of ["outreach", "landing", "infra"]) expect(withRest.get(k)).toBe(a.get(k));
  });

  test("past seven unnamed areas the extras fall back to their hash", () => {
    const many = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8", "i9"];
    const colors = assignAreaColors(many);
    expect(new Set(many.slice(0, 7).map((a) => colors.get(a))).size).toBe(7);
    expect(colors.get("h8")).toBe(areaVar("h8"));
  });

  test("a dot folder prints without its dot", () => {
    expect(areaLabel(".claude")).toBe("claude");
    expect(areaLabel("web")).toBe("web");
  });
});
