// The smoke baselines' diff (imagediff.mjs): what counts as a change, what a
// mask leaves out, and when a shot fails. PNGs go through ffmpeg, as in the
// smoke suite; the test skips where ffmpeg is missing.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePng } from "../call-e2e/frames.mjs";
import { diffPng } from "./imagediff.mjs";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Each case spawns ffmpeg a few times; a loaded machine takes seconds a spawn.
setDefaultTimeout(120_000);

const W = 40;
const H = 30;
const dir = mkdtempSync(join(tmpdir(), "imagediff-"));

/** A gray image with an optional rectangle painted in another color. */
function png(name: string, paint?: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }, size = { w: W, h: H }) {
  const data = new Uint8Array(size.w * size.h * 4);
  for (let y = 0; y < size.h; y++) {
    for (let x = 0; x < size.w; x++) {
      const o = (y * size.w + x) * 4;
      const inside = paint && x >= paint.x && x < paint.x + paint.w && y >= paint.y && y < paint.y + paint.h;
      const [r, g, b] = inside ? paint!.rgb : [200, 200, 200];
      data.set([r, g, b, 255], o);
    }
  }
  return writePng(join(dir, `${name}.png`), data, size.w, size.h);
}

describe.skipIf(!hasFfmpeg)("diffPng", () => {
  const base = png("base");

  test("an identical shot matches", () => {
    const r = diffPng(base, png("same"));
    expect(r).toMatchObject({ ok: true, differing: 0, compared: W * H, sizeChanged: false });
  });

  test("a shade a person would not see is not a difference", () => {
    const r = diffPng(base, png("faint", { x: 0, y: 0, w: W, h: H, rgb: [203, 203, 203] }));
    expect(r.differing).toBe(0);
  });

  test("a visible change counts each pixel and fails past the ratio, with a diff image", () => {
    const diffPath = join(dir, "red.diff.png");
    const r = diffPng(base, png("red", { x: 0, y: 0, w: 10, h: 3, rgb: [220, 30, 30] }), { diffPath });
    expect(r.differing).toBe(30);
    expect(r.ok).toBe(false);
    expect(existsSync(diffPath)).toBe(true);
    expect(diffPng(base, join(dir, "red.png"), { maxRatio: 0.05 }).ok).toBe(true);
  });

  test("a masked change is left out of both the count and the total", () => {
    const r = diffPng(base, join(dir, "red.png"), { masks: [{ x: 0, y: 0, width: 10, height: 3 }] });
    expect(r).toMatchObject({ ok: true, differing: 0, compared: W * H - 30 });
  });

  test("a size change fails whatever the ratio", () => {
    const r = diffPng(base, png("taller", undefined, { w: W, h: H + 2 }), { maxRatio: 1 });
    expect(r).toMatchObject({ ok: false, sizeChanged: true, baseline: `${W}x${H}`, current: `${W}x${H + 2}` });
  });
});
