import { describe, expect, test } from "bun:test";
import { monogramColor, monogramLetter, monogramPng } from "./appIcon";
import { ACCENT_RGB } from "./roleIconRaster";
import { unzlibSync } from "fflate";

/** RGBA rows of a PNG this module wrote (one IDAT, filter 0 on every row). */
function pixels(png: Uint8Array, size: number) {
  const view = new DataView(png.buffer);
  let at = 8;
  while (String.fromCharCode(...png.subarray(at + 4, at + 8)) !== "IDAT") at += 12 + view.getUint32(at);
  const raw = unzlibSync(png.subarray(at + 8, at + 8 + view.getUint32(at)));
  return (x: number, y: number) => Array.from(raw.subarray(y * (size * 4 + 1) + 1 + x * 4, y * (size * 4 + 1) + 5 + x * 4));
}

describe("monogram", () => {
  test("the letter is the title's first letter or digit, accents dropped, else the slug's", () => {
    expect(monogramLetter("weekly vitals", "x9")).toBe("W");
    expect(monogramLetter("  — 3 numbers", "x9")).toBe("3");
    expect(monogramLetter("Élan", "x9")).toBe("E");
    expect(monogramLetter("数据", "k2x")).toBe("K");
  });

  test("the colour is an accent fixed by the slug", () => {
    expect(Object.values(ACCENT_RGB)).toContainEqual(monogramColor("abc123"));
    expect(monogramColor("abc123")).toEqual(monogramColor("abc123"));
    const colors = new Set(["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"].map((s) => monogramColor(s).join()));
    expect(colors.size).toBeGreaterThan(2);
  });

  test("every letter and digit draws, as a square RGBA PNG with transparent corners", () => {
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      const png = monogramPng(ch, "s", 32);
      const view = new DataView(png.buffer);
      expect([view.getUint32(16), view.getUint32(20), png[25]]).toEqual([32, 32, 6]);
    }
    const at = pixels(monogramPng("I", "s", 64), 64);
    expect(at(0, 0)[3]).toBe(0);
    expect(at(32, 32)).toEqual([255, 255, 255, 255]);
    expect(at(10, 32)[3]).toBe(255);
  });
});
