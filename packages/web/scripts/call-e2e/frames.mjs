// Generated video frames for the synthetic participant, and the decoder that
// reads them back out of a recording.
//
// Every frame says when it was made twice: once in large type a person can
// read off a screenshot, and once as a timecode strip a script can read off a
// PNG. The strip is what makes frame time alignment testable: snap a frame of
// a recording at a transcript moment, decode the strip, and the difference
// between the decoded capture time and the moment asked for is the alignment
// error, to the frame.
//
// The strip is two bands of equal cells on a black panel. The upper band is a
// timing pattern (white, black, white, ... for every cell, odd count so it
// starts and ends white), so a decoder finds each cell's center from the runs
// it sees and never needs to know the scale; a recording that letterboxes or
// downscales the share still decodes as long as a cell stays about 3px wide.
// The lower band, twice as tall, carries the bits under those centers:
//
//   [1] start   [1] source (0 screen, 1 camera)   [41] capture time, epoch ms
//   [20] frame counter (mod 2^20)   [8] checksum   [1] 1   [1] 0
//
// Both the layout and its reader live in this one file, so they cannot drift.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

// ── 5x7 bitmap font ───────────────────────────────────────────────────────
// Rows top to bottom, five bits each, high bit on the left. Lowercase is
// drawn as uppercase.
const GLYPHS = {
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  "/": [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x00],
  "#": [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  _: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  " ": [0, 0, 0, 0, 0, 0, 0],
};
const UNKNOWN = [0x1f, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1f];

const rgba = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  // Little endian: the Uint32 view writes R first.
  return ((0xff << 24) | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0;
};
const WHITE = rgba("#ffffff");
const BLACK = rgba("#000000");
const INK = rgba("#f4f1ea");
const DIM = rgba("#c9c4b8");

// An RGBA frame with just enough drawing for these slides.
export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    this.px = new Uint32Array(this.data.buffer);
  }

  rect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.floor(x));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y0 = Math.max(0, Math.floor(y));
    const y1 = Math.min(this.height, Math.floor(y + h));
    if (x1 <= x0) return;
    for (let row = y0; row < y1; row++) this.px.fill(color, row * this.width + x0, row * this.width + x1);
  }

  static textWidth(str, scale) {
    return str.length ? str.length * 6 * scale - scale : 0;
  }

  text(str, x, y, scale, color) {
    let cx = Math.floor(x);
    for (const ch of str.toUpperCase()) {
      const rows = GLYPHS[ch] ?? UNKNOWN;
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (rows[r] & (0x10 >> c)) this.rect(cx + c * scale, y + r * scale, scale, scale, color);
        }
      }
      cx += 6 * scale;
    }
  }

  // Centers on x, shrinking the scale until the text fits the frame.
  textCentered(str, cx, y, scale, color) {
    let s = scale;
    while (s > 1 && Canvas.textWidth(str, s) > this.width * 0.94) s--;
    this.text(str, cx - Canvas.textWidth(str, s) / 2, y, s, color);
    return s;
  }
}

// ── Timecode strip ────────────────────────────────────────────────────────
export const STRIP_CELLS = 73;
const MS_BITS = 41;
const FRAME_BITS = 20;

function checksum(payload) {
  let x = 0xa5;
  for (let i = 0; i < payload.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (payload[i + j] ?? 0);
    x ^= byte;
  }
  return x;
}

const toBits = (value, count) =>
  Array.from({ length: count }, (_, i) => Math.floor(value / 2 ** (count - 1 - i)) % 2);
const fromBits = (bits) => bits.reduce((acc, b) => acc * 2 + b, 0);

export function encodeStrip({ source, capturedAtMs, frame }) {
  const payload = [source === "camera" ? 1 : 0, ...toBits(capturedAtMs, MS_BITS), ...toBits(frame % 2 ** FRAME_BITS, FRAME_BITS)];
  return [1, ...payload, ...toBits(checksum(payload), 8), 1, 0];
}

export function parseStripBits(bits) {
  if (bits.length !== STRIP_CELLS || bits[0] !== 1 || bits[71] !== 1 || bits[72] !== 0) return null;
  const payload = bits.slice(1, 63);
  if (fromBits(bits.slice(63, 71)) !== checksum(payload)) return null;
  return {
    source: payload[0] ? "camera" : "screen",
    capturedAtMs: fromBits(payload.slice(1, 1 + MS_BITS)),
    frame: fromBits(payload.slice(1 + MS_BITS)),
  };
}

// Draws the strip along the bottom of the canvas and returns its top edge,
// so a slide can lay out above it.
function stripGeometry(canvas) {
  const cell = Math.max(3, Math.floor(canvas.width / (STRIP_CELLS + 8)));
  const band = Math.max(4, Math.round(cell * 0.9));
  return { cell, band, panelTop: canvas.height - band * 5 };
}

export function drawStrip(canvas, fields) {
  const bits = encodeStrip(fields);
  const { cell, band, panelTop } = stripGeometry(canvas);
  const stripW = cell * STRIP_CELLS;
  const x0 = Math.floor((canvas.width - stripW) / 2);
  canvas.rect(x0 - cell * 3, panelTop, stripW + cell * 6, band * 5, BLACK);
  const y0 = panelTop + band;
  for (let i = 0; i < STRIP_CELLS; i++) {
    if (i % 2 === 0) canvas.rect(x0 + i * cell, y0, cell, band, WHITE);
    if (bits[i]) canvas.rect(x0 + i * cell, y0 + band, cell, band * 2, WHITE);
  }
  return panelTop;
}

// Luma (BT.601) of an RGBA buffer, the input decodeStrips reads.
export function grayOf(rgbaBytes, width, height) {
  const g = new Uint8Array(width * height);
  for (let i = 0; i < g.length; i++) {
    g[i] = (rgbaBytes[i * 4] * 299 + rgbaBytes[i * 4 + 1] * 587 + rgbaBytes[i * 4 + 2] * 114) / 1000;
  }
  return g;
}

// Writes an RGBA buffer as a PNG through ffmpeg (a raw file in between,
// because ffmpeg's pipe reader truncates large raw frames).
export function writePng(path, rgbaBytes, width, height) {
  const raw = `${path}.rgba`;
  writeFileSync(raw, rgbaBytes);
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", raw, path], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("ffmpeg is not installed. Install it with: brew install ffmpeg");
    throw err;
  } finally {
    rmSync(raw, { force: true });
  }
  return path;
}

// Reads a PNG back as RGBA through ffmpeg: { width, height, data }. The size
// comes from the IHDR chunk, which every PNG carries first.
export function readPng(path) {
  const head = readFileSync(path).subarray(0, 24);
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  try {
    const data = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
    return { width, height, data };
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("ffmpeg is not installed. Install it with: brew install ffmpeg");
    throw err;
  }
}

// Finds and reads every strip in a grayscale image (one byte a pixel). A
// composite recording can hold two (a screen share and a camera tile), so it
// returns all of them, top to bottom, each with where it was found.
export function decodeStrips(gray, width, height) {
  const runsOf = (y) => {
    const runs = [];
    const row = y * width;
    let start = 0;
    let on = gray[row] >= 128;
    for (let x = 1; x <= width; x++) {
      const v = x < width ? gray[row + x] >= 128 : !on;
      if (v !== on) {
        runs.push({ on, start, len: x - start });
        start = x;
        on = v;
      }
    }
    return runs;
  };

  // Rows holding a timing pattern: STRIP_CELLS alternating runs of even width
  // starting white, with black (or the edge) at least a cell wide either side.
  const hits = [];
  for (let y = 0; y < height; y++) {
    const runs = runsOf(y);
    for (let i = 0; i + STRIP_CELLS <= runs.length; i++) {
      if (!runs[i].on) continue;
      const seq = runs.slice(i, i + STRIP_CELLS);
      const widths = seq.map((r) => r.len).sort((a, b) => a - b);
      const median = widths[STRIP_CELLS >> 1];
      if (median < 2 || widths[0] < median * 0.5 || widths[STRIP_CELLS - 1] > median * 1.6) continue;
      if (!seq.every((r, k) => r.on === (k % 2 === 0))) continue;
      const before = runs[i - 1];
      const after = runs[i + STRIP_CELLS];
      if ((before && before.len < median) || (after && (after.on || after.len < median))) continue;
      hits.push({ y, x: seq[0].start, centers: seq.map((r) => r.start + r.len / 2), cell: median });
      i += STRIP_CELLS - 1;
    }
  }

  // Consecutive rows with the same pattern form one timing band; the data
  // band starts right under it and is twice as tall, so its middle is one
  // band height below the timing band's bottom.
  const bands = [];
  for (const h of hits) {
    const band = bands.find((b) => b.lastY === h.y - 1 && Math.abs(b.x - h.x) <= 2);
    if (band) {
      band.lastY = h.y;
      band.rows++;
    } else bands.push({ ...h, firstY: h.y, lastY: h.y, rows: 1 });
  }

  const sample = (cx, cy) => {
    let sum = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(cx) + dx;
        const y = Math.round(cy) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        sum += gray[y * width + x];
        n++;
      }
    }
    return n ? sum / n : 0;
  };

  const out = [];
  for (const b of bands) {
    const dataY = b.lastY + b.rows;
    if (dataY >= height) continue;
    const parsed = parseStripBits(b.centers.map((cx) => (sample(cx, dataY) >= 128 ? 1 : 0)));
    if (parsed) out.push({ ...parsed, x: b.x, y: b.firstY, cellPx: b.cell });
  }
  return out;
}

// ── Slides ────────────────────────────────────────────────────────────────
// A scene lasts SCENE_MS and owns one color, so scene change sampling over a
// share has exactly one cut to find every ten seconds, and a frame's scene
// says which ten second window it came from even without the strip.
export const SCENE_MS = 10_000;
export const SCENES = [
  { name: "CRIMSON", color: "#b3122e" },
  { name: "COBALT", color: "#1f4fd1" },
  { name: "EMERALD", color: "#0e8a4a" },
  { name: "AMBER", color: "#b86e00" },
  { name: "VIOLET", color: "#6b2fb8" },
  { name: "TEAL", color: "#0b7480" },
  { name: "SLATE", color: "#3a4250" },
  { name: "MAGENTA", color: "#a3166f" },
];

const pad = (n, w = 2) => String(n).padStart(w, "0");
const clock = (d, utc) => {
  const h = utc ? d.getUTCHours() : d.getHours();
  const m = utc ? d.getUTCMinutes() : d.getMinutes();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  return `${pad(h)}:${pad(m)}:${pad(s)}.${Math.floor(d.getMilliseconds() / 100)}`;
};
const elapsed = (ms) => `T+${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}.${Math.floor(ms / 100) % 10}`;

export function sceneAt(nowMs) {
  const index = Math.floor(nowMs / SCENE_MS);
  return { index, ...SCENES[index % SCENES.length], second: Math.floor((nowMs % SCENE_MS) / 1000) };
}

// Lays items out top to bottom between two edges with even gaps, so a slide
// reads the same at 1080p and at 360p. Each item is { h, draw(y) }.
function stack(top, bottom, items) {
  const gap = Math.max(0, (bottom - top - items.reduce((s, it) => s + it.h, 0)) / (items.length + 1));
  let y = top + gap;
  for (const it of items) {
    it.draw(Math.round(y));
    y += it.h + gap;
  }
}

// The largest scale at which a line fits the given width.
const fitScale = (str, width, max) => Math.max(1, Math.min(max, Math.floor((width + max) / (str.length * 6 || 1))));

// The screen share: a full colored slide whose scene is wall clock aligned
// (every share started anywhere cuts at the same instants), with the time in
// local and UTC, the frame counter and elapsed time, a ten box second meter,
// and the strip.
export function paintScreen(canvas, { nowMs, frame, startedAtMs, label }) {
  const { width: W, height: H } = canvas;
  const scene = sceneAt(nowMs);
  const d = new Date(nowMs);
  canvas.rect(0, 0, W, H, rgba(scene.color));
  const unit = Math.max(1, Math.floor(H / 120));
  const margin = unit * 4;

  // Header: who is sharing on the left, the scene on the right.
  const sceneLabel = `SCENE ${scene.index % 1000} ${scene.name}`;
  const head = Math.max(1, Math.round(unit * 0.6));
  canvas.text(sceneLabel, W - margin - Canvas.textWidth(sceneLabel, head), margin, head, INK);
  const leftRoom = W - margin * 3 - Canvas.textWidth(sceneLabel, head);
  const who = `SCREEN SHARE - ${label}`;
  canvas.text(who.slice(0, Math.max(0, Math.floor((leftRoom + head) / (6 * head)))), margin, margin, head, INK);

  const usable = W - margin * 2;
  const clockText = clock(d, false);
  const utcText = `UTC ${clock(d, true)}  ${d.toISOString().slice(0, 10)}`;
  const frameText = `FRAME ${pad(frame, 6)}   ${elapsed(nowMs - startedAtMs)}`;
  const big = fitScale(clockText, usable, unit * 4);
  const mid = fitScale(frameText, usable, unit * 2);
  const small = fitScale(utcText, usable, Math.max(1, Math.round(unit * 1.2)));

  // The second meter: one box per second of the scene, the current one solid.
  const boxes = SCENE_MS / 1000;
  const gap = unit * 2;
  const boxW = Math.floor((W * 0.6 - gap * (boxes - 1)) / boxes);
  const boxH = unit * 5;
  const meterX = (W - (boxW * boxes + gap * (boxes - 1))) / 2;
  const meter = (y) => {
    for (let i = 0; i < boxes; i++) {
      const x = meterX + i * (boxW + gap);
      if (i <= scene.second) canvas.rect(x, y, boxW, boxH, i === scene.second ? WHITE : DIM);
      else {
        canvas.rect(x, y, boxW, unit, DIM);
        canvas.rect(x, y + boxH - unit, boxW, unit, DIM);
        canvas.rect(x, y, unit, boxH, DIM);
        canvas.rect(x + boxW - unit, y, unit, boxH, DIM);
      }
    }
  };

  const top = margin + head * 7;
  const bottom = drawStrip(canvas, { source: "screen", capturedAtMs: nowMs, frame });
  stack(top, bottom, [
    { h: big * 7, draw: (y) => canvas.textCentered(clockText, W / 2, y, big, WHITE) },
    { h: small * 7, draw: (y) => canvas.textCentered(utcText, W / 2, y, small, DIM) },
    { h: mid * 7, draw: (y) => canvas.textCentered(frameText, W / 2, y, mid, INK) },
    { h: boxH, draw: meter },
  ]);
}

// The camera: a dark tile in the participant's own color with their initials,
// a square that orbits it once every two seconds (so the encoder always has
// motion to send and a frozen track is obvious), the clock, and the strip.
export function paintCamera(canvas, { nowMs, frame, name, colorHex }) {
  const { width: W, height: H } = canvas;
  canvas.rect(0, 0, W, H, rgba("#14161a"));
  const unit = Math.max(1, Math.floor(H / 96));
  const usable = W - unit * 8;

  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("") || "?";
  const disc = Math.round(H * 0.3);
  const orbit = Math.round(disc * 0.72);
  const dot = unit * 3;
  const nameText = name.toUpperCase();
  const clockText = `${clock(new Date(nowMs), false)}  #${pad(frame, 5)}`;
  const nameScale = fitScale(nameText, usable, unit * 2);
  const clockScale = fitScale(clockText, usable, Math.max(1, Math.round(unit * 1.4)));

  const bottom = drawStrip(canvas, { source: "camera", capturedAtMs: nowMs, frame });
  stack(0, bottom, [
    {
      h: orbit * 2 + dot,
      draw: (y) => {
        const cx = W / 2;
        const cy = y + orbit + dot / 2;
        canvas.rect(cx - disc / 2, cy - disc / 2, disc, disc, rgba(colorHex));
        const s = Math.max(1, Math.floor(disc / (initials.length * 6 + 4)));
        canvas.textCentered(initials, cx, cy - (s * 7) / 2, s, WHITE);
        const angle = ((nowMs % 2000) / 2000) * Math.PI * 2;
        canvas.rect(cx + Math.cos(angle) * orbit - dot / 2, cy + Math.sin(angle) * orbit - dot / 2, dot, dot, WHITE);
      },
    },
    { h: nameScale * 7, draw: (y) => canvas.textCentered(nameText, W / 2, y, nameScale, INK) },
    { h: clockScale * 7, draw: (y) => canvas.textCentered(clockText, W / 2, y, clockScale, DIM) },
  ]);
}

// A stable color per identity, from the scene palette, so two synthetic
// participants in one room are told apart at a glance.
export function identityColor(identity) {
  let h = 0;
  for (const ch of identity) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SCENES[h % SCENES.length].color;
}
