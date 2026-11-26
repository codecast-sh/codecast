// Test helpers shared by the appshim tests.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

/** Writes a solid-color square RGB PNG, enough for sips and iconutil. */
function writeSolidPng(file, size = 512, [r, g, b] = [40, 120, 220]) {
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
  return file;
}

/**
 * How many pixels of a PNG are within `tolerance` of [r, g, b] on every
 * channel. sips converts it to a 32-bit BMP whose channel masks say where
 * each color sits.
 */
function countColorPixels(pngPath, [r, g, b], tolerance = 12) {
  const bmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "as-px-")), "image.bmp");
  execFileSync("sips", ["-s", "format", "bmp", pngPath, "--out", bmpPath], { stdio: "pipe" });
  const bmp = fs.readFileSync(bmpPath);
  fs.rmSync(path.dirname(bmpPath), { recursive: true, force: true });
  if (bmp.readUInt16LE(28) !== 32) throw new Error(`expected a 32-bit BMP from sips, got ${bmp.readUInt16LE(28)} bits`);
  // BI_BITFIELDS (3) carries the masks; plain 32-bit BMP is BGRA.
  const masks = bmp.readUInt32LE(30) === 3 ? [54, 58, 62].map((o) => bmp.readUInt32LE(o)) : [0xff0000, 0xff00, 0xff];
  const shifts = masks.map((m) => Math.log2(m & -m));
  const width = bmp.readInt32LE(18);
  const height = Math.abs(bmp.readInt32LE(22));
  const start = bmp.readUInt32LE(10);
  const want = [r, g, b];
  let count = 0;
  for (let i = 0; i < width * height; i++) {
    const px = bmp.readUInt32LE(start + i * 4);
    if (want.every((c, k) => Math.abs(((px >>> shifts[k]) & 0xff) - c) <= tolerance)) count++;
  }
  return count;
}

module.exports = { writeSolidPng, countColorPixels };
