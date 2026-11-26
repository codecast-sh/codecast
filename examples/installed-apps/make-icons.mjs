#!/usr/bin/env node
// Draws each example app's icon.png (1024 px, on the macOS icon grid: an
// 824 px rounded square centered with transparent margins) and the menu bar
// template images for Needs you and Team queue. No dependencies: shapes are signed distance
// fields, supersampled, encoded as PNG with zlib.
//
//   node examples/installed-apps/make-icons.mjs              every app
//   node examples/installed-apps/make-icons.mjs needs-you    just the ones named
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── PNG ──
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ── shapes (distance < 0 is inside) ──
const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const ring = (cx, cy, r, w) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - w / 2;
const capsule = (ax, ay, bx, by, r) => (x, y) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
};
const polyline = (pts, r) => {
  const segs = pts.slice(1).map((p, i) => capsule(pts[i][0], pts[i][1], p[0], p[1], r));
  return (x, y) => Math.min(...segs.map((s) => s(x, y)));
};
const minus = (a, b) => (x, y) => Math.max(a(x, y), -b(x, y));

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// A vertical gradient as a paint: (x, y) -> color.
const vgrad = (top, bottom, y0, y1) => (_x, y) => mix(top, bottom, Math.max(0, Math.min(1, (y - y0) / (y1 - y0))));
const solid = (c) => () => c;

/**
 * Renders layers of [shape, paint] onto a transparent square, painter's
 * order, with ss x ss samples per pixel. Shapes are drawn in a 1024 space.
 */
function render(size, layers, ss = 3) {
  const out = Buffer.alloc(size * size * 4);
  const scale = 1024 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * scale, y = (py + (sy + 0.5) / ss) * scale;
          let c = [0, 0, 0, 0]; // premultiplied
          for (const [shape, paint] of layers) {
            if (shape(x, y) > 0) continue;
            const p = paint(x, y);
            const a = p[3];
            c = [p[0] * a + c[0] * (1 - a), p[1] * a + c[1] * (1 - a), p[2] * a + c[2] * (1 - a), a + c[3] * (1 - a)];
          }
          acc = acc.map((v, i) => v + c[i]);
        }
      }
      const n = ss * ss, a = acc[3] / n, o = (py * size + px) * 4;
      out[o] = a ? Math.round((acc[0] / n / a) * 255) : 0;
      out[o + 1] = a ? Math.round((acc[1] / n / a) * 255) : 0;
      out[o + 2] = a ? Math.round((acc[2] / n / a) * 255) : 0;
      out[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, out);
}

// The macOS grid: an 824 px body centered on the 1024 canvas, corner 185.
const BODY = roundRect(512, 512, 412, 412, 185);
// A soft top highlight inside the body, for depth.
const SHEEN = roundRect(512, 330, 380, 200, 170);

const icons = {
  // A card waiting on a blue tile, with a red count dot at its corner.
  "needs-you": [
    [BODY, vgrad(hex("#3346ff"), hex("#1424b0"), 100, 924)],
    [SHEEN, solid(hex("#ffffff", 0.06))],
    [roundRect(490, 560, 230, 190, 56), solid(hex("#f6f4ee"))],
    [capsule(360, 500, 600, 500, 30), solid(hex("#1424b0"))],
    [capsule(360, 620, 520, 620, 30), solid(hex("#1424b0", 0.35))],
    [circle(712, 340, 124), solid(hex("#1d2fd8"))],
    [circle(712, 340, 92), vgrad(hex("#ff6a55"), hex("#ec3a2a"), 250, 430)],
  ],
  // A ring with a hot dot at its shoulder: something is waiting.
  "team-queue": [
    [BODY, vgrad(hex("#16243f"), hex("#070c17"), 100, 924)],
    [SHEEN, solid(hex("#ffffff", 0.035))],
    [ring(500, 540, 210, 74), vgrad(hex("#62f7cf"), hex("#1fbf98"), 330, 750)],
    [circle(680, 360, 112), solid(hex("#070c17"))],
    [circle(680, 360, 82), vgrad(hex("#ff7a6b"), hex("#f0443a"), 280, 440)],
  ],
  // Three people's rows on paper; one is short and red: blocked.
  "standup-board": [
    [BODY, vgrad(hex("#fbf6ec"), hex("#efe5d2"), 100, 924)],
    [capsule(290, 340, 734, 340, 46), solid(hex("#2643d9"))],
    [capsule(290, 512, 610, 512, 46), solid(hex("#2643d9"))],
    [capsule(290, 684, 470, 684, 46), solid(hex("#e8432e"))],
    [circle(690, 684, 46), solid(hex("#1d1a16", 0.14))],
  ],
  // A commit line with three nodes, crossed by a heartbeat.
  "repo-pulse": [
    [BODY, vgrad(hex("#10221a"), hex("#050c08"), 100, 924)],
    [SHEEN, solid(hex("#ffffff", 0.03))],
    [capsule(512, 200, 512, 824, 16), solid(hex("#2b5a43"))],
    [polyline([[200, 540], [380, 540], [440, 400], [530, 690], [600, 470], [650, 540], [824, 540]], 26), vgrad(hex("#9dffb0"), hex("#3fd97a"), 400, 700)],
    [circle(512, 300, 58), solid(hex("#050c08"))],
    [ring(512, 300, 40, 26), solid(hex("#9dffb0"))],
    [circle(512, 780, 58), solid(hex("#050c08"))],
    [ring(512, 780, 40, 26), solid(hex("#3fd97a"))],
  ],
};

const only = process.argv.slice(2);
const wanted = (name) => !only.length || only.includes(name);

for (const [name, layers] of Object.entries(icons)) {
  if (!wanted(name)) continue;
  writeFileSync(join(HERE, name, "icon.png"), render(1024, layers));
  console.log(`wrote ${name}/icon.png`);
}

// The menu bar image: black on transparent, a template macOS tints for the bar.
const trays = {
  "needs-you": [[minus(minus(roundRect(470, 570, 330, 290, 90), roundRect(470, 570, 210, 170, 40)), circle(740, 300, 230)), solid(hex("#000000"))], [circle(740, 300, 150), solid(hex("#000000"))]],
  "team-queue": [[minus(ring(470, 560, 270, 120), circle(720, 300, 210)), solid(hex("#000000"))], [circle(720, 300, 140), solid(hex("#000000"))]],
};
for (const [name, layers] of Object.entries(trays)) {
  if (!wanted(name)) continue;
  writeFileSync(join(HERE, name, "tray.png"), render(44, layers, 6));
  console.log(`wrote ${name}/tray.png`);
}
