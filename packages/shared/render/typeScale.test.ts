import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TYPE_SCALE, floorTextSize } from "./typeScale";

const WEB = join(import.meta.dir, "..", "..", "web");

describe("type scale", () => {
  test("matches the web's tailwind fontSize steps and --fs-* variables", () => {
    const tailwind = readFileSync(join(WEB, "tailwind.config.ts"), "utf8");
    const css = readFileSync(join(WEB, "app", "globals.css"), "utf8");
    for (const [step, { size, lineHeight }] of Object.entries(TYPE_SCALE)) {
      expect(tailwind).toContain(`${step}: ['${size}px', { lineHeight: '${lineHeight}px' }]`);
      expect(css).toContain(`--fs-${step}: ${size}px;`);
    }
  });

  test("words sit at 12 or more; capitals may sit at 11", () => {
    expect(floorTextSize(9, undefined, false)).toEqual({ fontSize: 12, lineHeight: undefined });
    expect(floorTextSize(11.5, undefined, false).fontSize).toBe(12);
    expect(floorTextSize(9, undefined, true).fontSize).toBe(11);
    expect(floorTextSize(10.5, undefined, true).fontSize).toBe(11);
    // At or above the floor, nothing moves.
    expect(floorTextSize(12, 16, false)).toEqual({ fontSize: 12, lineHeight: 16 });
    expect(floorTextSize(11, 14, true)).toEqual({ fontSize: 11, lineHeight: 14 });
    expect(floorTextSize(20, 26, false)).toEqual({ fontSize: 20, lineHeight: 26 });
    expect(floorTextSize(undefined, 18, false)).toEqual({ fontSize: undefined, lineHeight: 18 });
  });

  test("a raised size keeps its leading", () => {
    expect(floorTextSize(10, 14, false)).toEqual({ fontSize: 12, lineHeight: 17 });
    expect(floorTextSize(11, 16, false)).toEqual({ fontSize: 12, lineHeight: 17 });
    expect(floorTextSize(9, 12, true)).toEqual({ fontSize: 11, lineHeight: 15 });
  });
});
