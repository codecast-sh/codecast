// Run: node --test packages/electron/installedApps/icons.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pngToIco, pngSize, templateFromIcon, fetchPng, writeIconSet, ICO_SIZES } = require("./icons");
const { solidPng: png } = require("./testPng");

test("an .ico holds each PNG whole, with a directory Windows reads", () => {
  const images = [png(16), png(32), png(256)];
  const ico = pngToIco(images);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  let expectOffset = 6 + 16 * 3;
  images.forEach((img, i) => {
    const at = 6 + i * 16;
    const side = pngSize(img).width;
    assert.equal(ico[at], side === 256 ? 0 : side);
    assert.equal(ico[at + 1], side === 256 ? 0 : side);
    assert.equal(ico.readUInt16LE(at + 4), 1);
    assert.equal(ico.readUInt16LE(at + 6), 32);
    assert.equal(ico.readUInt32LE(at + 8), img.length);
    assert.equal(ico.readUInt32LE(at + 12), expectOffset);
    assert.ok(ico.subarray(expectOffset, expectOffset + img.length).equals(img));
    expectOffset += img.length;
  });
  assert.equal(ico.length, expectOffset);
  assert.throws(() => pngToIco([png(512)]), /at most 256/);
  assert.throws(() => pngToIco([Buffer.from("nope")]), /not a PNG/);
});

test("the tray template is a dot whose ink is the icon's dark parts", () => {
  const size = 16;
  // A dark tile with a white block in the middle (a monogram's letter).
  const bgra = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) bgra.set([40, 40, 40, 255], i * 4);
  for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) bgra.set([255, 255, 255, 255], (y * size + x) * 4);
  const t = templateFromIcon(bgra, size);
  const alpha = (x, y) => t[(y * size + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0, "corners are outside the dot");
  assert.ok(alpha(3, 8) > 200, "the tile's dark body is ink");
  assert.equal(alpha(8, 8), 0, "the white letter is cut out");
  for (let i = 0; i < t.length; i += 4) assert.deepEqual([t[i], t[i + 1], t[i + 2]], [0, 0, 0]);
});

test("fetchPng refuses what is not a PNG", async () => {
  const ok = await fetchPng("x", async () => ({ ok: true, arrayBuffer: async () => png(8) }));
  assert.equal(pngSize(ok).width, 8);
  await assert.rejects(fetchPng("x", async () => ({ ok: true, arrayBuffer: async () => Buffer.from("<html>") })), /not a PNG/);
  await assert.rejects(fetchPng("x", async () => ({ ok: false, status: 403 })), /403/);
});

test("the icon set: .ico on Windows, a template tray on macOS, the declared tray icon when there is one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-icons-"));
  const resized = [];
  const imaging = {
    resize: (_buf, s) => (resized.push(s), png(s)),
    bitmap: (_buf, s) => Buffer.alloc(s * s * 4, 255),
    fromBitmap: (_b, s) => png(s, [0, 0, 0, 255]),
  };
  const win = writeIconSet({ dir: path.join(dir, "w"), png: png(64), platform: "win32", imaging });
  const ico = fs.readFileSync(win.ico);
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
  assert.equal(win.trayTemplate, false);
  assert.ok(fs.existsSync(win.tray) && fs.existsSync(win.tray2x));
  const mac = writeIconSet({ dir: path.join(dir, "m"), png: png(64), platform: "darwin", imaging });
  assert.equal(mac.ico, undefined);
  assert.equal(mac.trayTemplate, true);
  resized.length = 0;
  writeIconSet({ dir: path.join(dir, "d"), png: png(64), trayPng: png(48), platform: "darwin", imaging });
  assert.deepEqual(resized, [16, 32]);
  fs.rmSync(dir, { recursive: true, force: true });
});
