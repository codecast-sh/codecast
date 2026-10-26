import { describe, expect, test } from "bun:test";
import { pixelVerdict } from "./pixels.js";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("pixelVerdict", () => {
  test("no capture says nothing", () => {
    expect(pixelVerdict(undefined)).toBeUndefined();
  });

  test("identical captures are unchanged", () => {
    expect(pixelVerdict({ changed: null, repainting: null })).toEqual({ state: "unchanged" });
  });

  test("a change that held still is the action's", () => {
    expect(pixelVerdict({ changed: box(10, 20, 80, 16), repainting: null })).toEqual({ state: "changed", region: box(10, 20, 80, 16) });
  });

  test("a blinking text cursor alone is not a change", () => {
    expect(pixelVerdict({ changed: box(40, 12, 1, 17), repainting: null })).toEqual({ state: "cursor", region: box(40, 12, 1, 17) });
  });

  test("a window that keeps changing by itself cannot vouch for the action", () => {
    expect(pixelVerdict({ changed: box(0, 0, 300, 200), repainting: box(5, 5, 24, 24) })).toEqual({ state: "repainting", region: box(5, 5, 24, 24) });
  });

  test("a cursor blinking during the third capture does not mark the window as repainting", () => {
    expect(pixelVerdict({ changed: box(10, 20, 80, 16), repainting: box(90, 20, 1, 16) })).toEqual({ state: "changed", region: box(10, 20, 80, 16) });
  });
});
