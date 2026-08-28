// Draw every walkie cue as a waveform PNG.
//
// Nobody working on these cues is allowed to play them out loud, so the only
// way to review one is to look at it. This renders each cue from the same spec
// `sounds.ts` plays and `cueRender.ts` measures, at one shared vertical scale
// with the ring's peak marked, so "is this loud enough" is a question you can
// answer by looking rather than by trusting a number in a comment.
//
//   bun run scripts/renderCueWaveforms.ts [outDir]
//
// No canvas, no image library, no browser: a PNG is a zlib stream of rows and
// four chunks around it, which is less code than reaching for a dependency.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cueDuration, cuePeak, renderCue } from "../lib/cueRender";
import type { CueSpec } from "../lib/cueSpec";
import {
  WALKIE_AWAY, WALKIE_JOINED, WALKIE_KEY_UP, WALKIE_OPEN, WALKIE_ROGER, WALKIE_SQUELCH,
} from "../lib/cueSpec";

// ── a bitmap of RGB pixels, and the few marks we make on it ───────────────

type Rgb = [number, number, number];

const BG: Rgb = [0, 43, 54];
const GRID: Rgb = [7, 54, 66];
const DIM: Rgb = [88, 110, 117];
const TEXT: Rgb = [147, 161, 161];
const WARM: Rgb = [203, 75, 22];
const COOL: Rgb = [42, 161, 152];

class Bitmap {
  data: Uint8Array;
  constructor(readonly w: number, readonly h: number, fill: Rgb) {
    this.data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.data.set(fill, i * 3);
  }
  px(x: number, y: number, c: Rgb) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data.set(c, (y * this.w + x) * 3);
  }
  vline(x: number, y0: number, y1: number, c: Rgb) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.px(x, y, c);
  }
  hline(y: number, x0: number, x1: number, c: Rgb, dash = 0) {
    for (let x = x0; x <= x1; x++) if (!dash || Math.floor(x / dash) % 2 === 0) this.px(x, y, c);
  }
}

// A 5x7 font, enough for a chart annotation. Uppercase only on purpose: the
// labels are short and this keeps the glyph table something a person can read.
const GLYPHS: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "####.", "#...#", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "####.", "#....", "#....", "#....", "#####"],
  F: ["#####", "#....", "####.", "#....", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#####", "#...#", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["....#", "....#", "....#", "....#", "#...#", "#...#", ".###."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#...#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#...#", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "#...#", ".###."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

function text(bmp: Bitmap, s: string, x0: number, y0: number, c: Rgb, scale = 1) {
  let x = x0;
  for (const ch of s.toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS[" "];
    for (let r = 0; r < 7; r++) {
      for (let col = 0; col < 5; col++) {
        if (g[r][col] !== "#") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) bmp.px(x + col * scale + dx, y0 + r * scale + dy, c);
        }
      }
    }
    x += 6 * scale;
  }
}

// ── the PNG container ─────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const name = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  out.set(name, 4);
  out.set(body, 8);
  const payload = new Uint8Array(name.length + body.length);
  payload.set(name);
  payload.set(body, name.length);
  dv.setUint32(8 + body.length, crc32(payload));
  return out;
}

function encodePng(bmp: Bitmap): Uint8Array {
  // Every scanline carries a leading filter byte; 0 means "stored as is",
  // which costs a little size and saves a filter implementation.
  const raw = new Uint8Array(bmp.h * (1 + bmp.w * 3));
  for (let y = 0; y < bmp.h; y++) {
    const at = y * (1 + bmp.w * 3);
    raw[at] = 0;
    raw.set(bmp.data.subarray(y * bmp.w * 3, (y + 1) * bmp.w * 3), at + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, bmp.w);
  dv.setUint32(4, bmp.h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ── the chart ─────────────────────────────────────────────────────────────

/** One shared vertical scale for every cue, so the pictures can be compared.
 *  Just above the loudest of them, which is `joined` at 0.0532. */
const FULL_SCALE = 0.06;
/** soundCallRing's measured peak: the level the app already asks a room to hear. */
const RING_PEAK = 0.0458;
/** The longest cue, so the time axis is shared too and a short cue looks short. */
const FULL_SECONDS = 0.32;

const CUES: Array<{ name: string; spec: CueSpec; side: "send" | "receive"; says: string }> = [
  { name: "joined", spec: WALKIE_JOINED, side: "send", says: "THEY STEPPED IN - A CALL NOW" },
  { name: "keyup", spec: WALKIE_KEY_UP, side: "send", says: "YOUR MIC IS OPEN - SPEAK" },
  { name: "roger", spec: WALKIE_ROGER, side: "send", says: "CLOSED AND SENT" },
  { name: "open", spec: WALKIE_OPEN, side: "receive", says: "A BURST IS ARRIVING" },
  { name: "away", spec: WALKIE_AWAY, side: "send", says: "NOBODY LIVE - GOES AS A MESSAGE" },
  { name: "squelch", spec: WALKIE_SQUELCH, side: "receive", says: "THAT BURST ENDED" },
];

function drawLane(bmp: Bitmap, spec: CueSpec, colour: Rgb, x0: number, y0: number, w: number, h: number) {
  const mid = y0 + Math.floor(h / 2);
  const samples = renderCue(spec);
  const perColumn = (FULL_SECONDS * 48_000) / w;

  bmp.hline(mid, x0, x0 + w, GRID);
  for (const level of [RING_PEAK, -RING_PEAK]) {
    bmp.hline(mid - Math.round((level / FULL_SCALE) * (h / 2)), x0, x0 + w, DIM, 4);
  }

  for (let x = 0; x < w; x++) {
    let lo = 0, hi = 0;
    for (let i = Math.floor(x * perColumn); i < Math.floor((x + 1) * perColumn); i++) {
      const v = samples[i] ?? 0;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const y = (v: number) => mid - Math.round((v / FULL_SCALE) * (h / 2));
    bmp.vline(x0 + x, y(lo), y(hi), colour);
  }
}

const label = (name: string, spec: CueSpec) =>
  `${name}  PEAK ${cuePeak(spec).toFixed(4)}  ${Math.round(cueDuration(spec) * 1000)} MS`;

function single(cue: (typeof CUES)[number]): Bitmap {
  const bmp = new Bitmap(760, 230, BG);
  const colour = cue.side === "send" ? WARM : COOL;
  text(bmp, label(cue.name, cue.spec), 20, 18, colour, 2);
  text(bmp, cue.says, 20, 44, TEXT, 1);
  drawLane(bmp, cue.spec, colour, 20, 66, 720, 130);
  text(bmp, `DASHED - SOUNDCALLRING PEAK ${RING_PEAK.toFixed(4)}   FULL HEIGHT ${FULL_SCALE.toFixed(2)}   0 TO ${Math.round(FULL_SECONDS * 1000)} MS`, 20, 208, DIM, 1);
  return bmp;
}

function combined(): Bitmap {
  const laneH = 74;
  const bmp = new Bitmap(760, 44 + CUES.length * laneH + 26, BG);
  text(bmp, "THE SIX WALKIE CUES AT ONE SCALE", 20, 16, TEXT, 2);
  CUES.forEach((cue, i) => {
    const y = 44 + i * laneH;
    const colour = cue.side === "send" ? WARM : COOL;
    text(bmp, label(cue.name, cue.spec), 20, y + 2, colour, 1);
    drawLane(bmp, cue.spec, colour, 20, y + 12, 720, 56);
  });
  text(bmp, `WARM - YOUR OWN BURST   COOL - A TEAMMATES   DASHED - SOUNDCALLRING PEAK ${RING_PEAK.toFixed(4)}`, 20, 44 + CUES.length * laneH + 8, DIM, 1);
  return bmp;
}

const outDir = process.argv[2] ?? "/tmp/walkie-cues";
mkdirSync(outDir, { recursive: true });
for (const cue of CUES) {
  const path = join(outDir, `walkie-${cue.name}.png`);
  writeFileSync(path, encodePng(single(cue)));
  console.log(path);
}
const allPath = join(outDir, "walkie-all-six.png");
writeFileSync(allPath, encodePng(combined()));
console.log(allPath);
