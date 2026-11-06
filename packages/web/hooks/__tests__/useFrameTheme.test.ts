import { describe, expect, test } from "bun:test";
import { colorAlpha } from "../useFrameTheme";

describe("colorAlpha", () => {
  test("reads alpha in every serialization a computed background takes", () => {
    expect(colorAlpha("rgb(251, 245, 226)")).toBe(1);
    expect(colorAlpha("rgba(0, 0, 0, 0)")).toBe(0);
    expect(colorAlpha("rgba(10, 20, 30, 0.5)")).toBe(0.5);
    expect(colorAlpha("transparent")).toBe(0);
    expect(colorAlpha("")).toBe(0);
    // A color-mix() tint (the decision card) computes to color(srgb … / a);
    // reading it as opaque painted the framed page see-through over a dark canvas.
    expect(colorAlpha("color(srgb 0.709804 0.537255 0 / 0.06)")).toBe(0.06);
    expect(colorAlpha("color(srgb 0.98 0.96 0.89)")).toBe(1);
    expect(colorAlpha("oklab(0.9 0.01 0.03 / 40%)")).toBe(0.4);
  });
});
