import { describe, expect, test } from "bun:test";
import twColors from "tailwindcss/colors";
import { THEME_COLOR_TOKENS } from "@codecast/shared/contracts/theme";
import { hexToHslTriplet, themeVars } from "./themeVars";
import { ACCENT_SCALES, SCALES, SHADES, scaleVar } from "./scales";

describe("theme variables", () => {
  test("every scale the config routes exists in Tailwind with every shade", () => {
    for (const s of SCALES) for (const n of SHADES) expect(typeof (twColors as any)[s]?.[n]).toBe("string");
  });

  test("every accent scale names an accent token", () => {
    for (const token of Object.values(ACCENT_SCALES)) expect(THEME_COLOR_TOKENS).toContain(token);
  });

  test("an empty palette changes nothing", () => {
    expect(themeVars({}, "light")).toEqual({});
    expect(themeVars(undefined, "dark")).toEqual({});
  });

  test("an accent sets its own variables and recolors its scales", () => {
    const vars = themeVars({ blue: "#5e81ac" }, "light");
    expect(vars["--sol-blue"]).toBe("#5e81ac");
    expect(vars["--sol-class-blue"]).toBe("#5e81ac");
    expect(vars[scaleVar("sky", 500)]).toBe("#5e81ac");
    expect(vars[scaleVar("blue", 100)]).toContain("var(--sol-bg)");
    expect(vars[scaleVar("zinc", 500)]).toBeUndefined();
  });

  test("neutrals keep Tailwind's direction in both modes: 900 is dark, 50 is pale", () => {
    const light = themeVars({ bg: "#ffffff", text: "#111111" }, "light");
    const dark = themeVars({ bg: "#111111", text: "#ffffff" }, "dark");
    expect(light[scaleVar("zinc", 900)]).toBe("color-mix(in srgb, var(--sol-text) 93%, var(--sol-bg))");
    expect(dark[scaleVar("zinc", 900)]).toBe("color-mix(in srgb, var(--sol-bg) 93%, var(--sol-text))");
  });

  test("shadcn variables get HSL triplets", () => {
    expect(hexToHslTriplet("#ffffff")).toBe("0 0% 100%");
    expect(hexToHslTriplet("#268bd2")).toBe("204.8 69.4% 48.6%");
    expect(themeVars({ bg: "#fff" }, "light")["--background"]).toBe("0 0% 100%");
  });
});
