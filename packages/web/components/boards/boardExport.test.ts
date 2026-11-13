import { describe, expect, test } from "bun:test";
import { srgbToRgb } from "./boardExport";

describe("export colors", () => {
  test("a computed color(srgb …) becomes rgb() or rgba(); other colors pass through", () => {
    expect(srgbToRgb("color(srgb 0.338235 0.40549 0.467451)")).toBe("rgb(86, 103, 119)");
    expect(srgbToRgb("color(srgb 1 0 0 / 0.5)")).toBe("rgba(255, 0, 0, 0.5)");
    expect(srgbToRgb("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
  });
});
