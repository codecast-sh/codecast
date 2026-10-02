// node --test   (from this folder)
//
// The strip has to survive what a recording does to a share: H.264 at a
// lower resolution, letterboxed inside a bigger composite frame. These tests
// paint real slides, push them through ffmpeg that way when it is installed,
// and read the strips back.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Canvas, decodeStrips, grayOf, encodeStrip, paintCamera, paintScreen, parseStripBits, sceneAt, STRIP_CELLS } from "./frames.mjs";

const T = Date.UTC(2026, 9, 2, 21, 3, 22, 400);

const toGray = (c) => grayOf(c.data, c.width, c.height);

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("strip bits round trip and reject corruption", () => {
  const bits = encodeStrip({ source: "camera", capturedAtMs: T, frame: 1_234_567 });
  assert.equal(bits.length, STRIP_CELLS);
  assert.deepEqual(parseStripBits(bits), { source: "camera", capturedAtMs: T, frame: 1_234_567 % 2 ** 20 });
  for (const i of [1, 20, 50, 66]) {
    const flipped = bits.slice();
    flipped[i] ^= 1;
    assert.equal(parseStripBits(flipped), null, `bit ${i} flipped must not parse`);
  }
});

test("screen and camera slides decode from their own pixels", () => {
  const screen = new Canvas(1280, 720);
  paintScreen(screen, { nowMs: T, frame: 421, startedAtMs: T - 42_300, label: "RILEY CHEN" });
  assert.deepEqual(
    decodeStrips(toGray(screen), 1280, 720).map(({ source, capturedAtMs, frame }) => ({ source, capturedAtMs, frame })),
    [{ source: "screen", capturedAtMs: T, frame: 421 }],
  );
  const cam = new Canvas(640, 480);
  paintCamera(cam, { nowMs: T + 5, frame: 9, name: "Guest Pat", colorHex: "#1f4fd1" });
  assert.equal(decodeStrips(toGray(cam), 640, 480)[0]?.capturedAtMs, T + 5);
});

test("scenes cut on the wall clock every ten seconds", () => {
  const a = sceneAt(T - (T % 10_000));
  assert.equal(a.second, 0);
  assert.equal(sceneAt(T - (T % 10_000) + 9_999).index, a.index);
  assert.notEqual(sceneAt(T - (T % 10_000) + 10_000).name, a.name);
});

test("a share survives H.264 at half size inside a letterboxed composite", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "call-e2e-test-"));
  const screen = new Canvas(1920, 1080);
  paintScreen(screen, { nowMs: T, frame: 77, startedAtMs: T - 1000, label: "SCRATCH" });
  const raw = join(dir, "f.rgba");
  writeFileSync(raw, screen.data);
  const mp4 = join(dir, "f.mp4");
  // 1920x1080 into a 1280x720 composite at 900x506, offset like a stage tile.
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1920x1080", "-i", raw,
    "-vf", "scale=900:506,pad=1280:720:300:150:color=0x202020", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", mp4,
  ]);
  const gray = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
    maxBuffer: 1 << 26,
  });
  const found = decodeStrips(gray, 1280, 720);
  assert.equal(found.length, 1);
  assert.equal(found[0].capturedAtMs, T);
  assert.equal(found[0].frame, 77);
});
