#!/usr/bin/env bun
// Renders a fake board (the elements scribe-dry-run.ts grade saved as
// board.json) to PNGs with the web's own export, boardSvg, headless: jsdom
// stands in for the page, this script resolves the theme's colors (the light
// theme's --sol-* tokens and board.css, color-mix included) in the SVG the
// export writes, and AppKit rasterizes it (svg2png.swift, macOS only). jsdom has no canvas, so
// the export wraps text by its fallback width (0.6em a character), not by the
// font's own measure: line breaks can differ a little from the live board.
//
//   bun packages/evals/scripts/scribe-board-render.ts --board <board.json> --out <dir> [--view name=<frame key> ...]
//
// The whole board is board.png; each --view renders that frame and what lies
// inside it as <name>.png.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { ArtifactElement } from '@codecast/shared/artifacts';
import { elementBox } from '@codecast/shared/artifacts/board';

const argOf = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const WEB = resolve(import.meta.dir, '../../web');

// ── The theme, as the light page resolves it ──────────────────────────────

const css = readFileSync(join(WEB, 'app/globals.css'), 'utf8');
const block = (src: string, start: string) => {
  const i = src.indexOf(start);
  if (i < 0) return '';
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return '';
};
const TOKENS = new Map<string, string>();
for (const b of [block(css, ':root, .hero-sandbox {'), block(readFileSync(join(WEB, 'components/boards/board.css'), 'utf8'), '.board-root {')]) {
  for (const m of b.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) if (!TOKENS.has(m[1]!)) TOKENS.set(m[1]!, m[2]!.trim());
}

type RGBA = [number, number, number, number];
function parse(c: string): RGBA | null {
  const s = c.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  if (s === 'white') return [255, 255, 255, 1];
  if (s === 'black') return [0, 0, 0, 1];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  return null;
}
/** var() and color-mix(in srgb, …) resolved to one rgba(); anything else as it came. */
export function resolveColor(input: string, depth = 0): string {
  let s = input;
  for (let i = 0; i < 20 && /var\(--/.test(s); i++) s = s.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*([^()]*))?\)/gi, (_, k: string, fb?: string) => TOKENS.get(k) ?? fb ?? 'transparent');
  // Innermost first: a color-mix whose arguments hold no other color-mix.
  for (let i = 0; i < 20; i++) {
    const m = /color-mix\(in srgb,((?:[^()]|\([^()]*\))*)\)/i.exec(s);
    if (!m) break;
    const [a, b] = m[1]!.split(/,(?![^(]*\))/).map((x) => x.trim());
    const part = (x = '') => {
      const pm = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(x);
      return pm ? { c: parse(pm[1]!), p: Number(pm[2]) / 100 } : { c: parse(x), p: undefined };
    };
    const A = part(a), B = part(b);
    if (!A.c || !B.c) break;
    const p = A.p ?? (B.p !== undefined ? 1 - B.p : 0.5);
    const alpha = A.c[3] * p + B.c[3] * (1 - p);
    const ch = (k: number) => (alpha ? Math.round((A.c![k]! * A.c![3] * p + B.c![k]! * B.c![3] * (1 - p)) / alpha) : 0);
    // An opaque color as hex: AppKit's SVG reader drops rgba() with an alpha of 1.
    const hex = (k: number) => ch(k).toString(16).padStart(2, '0');
    const color = alpha >= 0.999 ? `#${hex(0)}${hex(1)}${hex(2)}` : `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${+alpha.toFixed(3)})`;
    s = s.slice(0, m.index) + color + s.slice(m.index + m[0].length);
  }
  return depth < 3 && /var\(|color-mix\(/.test(s) && s !== input ? resolveColor(s, depth + 1) : s;
}

// ── A page for the export to run in ───────────────────────────────────────

// jsdom is the web package's test dependency, so it resolves from there.
const { JSDOM } = (await import(Bun.resolveSync('jsdom', WEB))) as typeof import('jsdom');
const dom = new JSDOM('<!doctype html><div id="root" class="board-root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
const g = globalThis as any;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'FileReader', 'localStorage', 'sessionStorage']) if (g[k] === undefined) g[k] = (dom.window as any)[k];
g.getComputedStyle = () => ({ color: '', fontFamily: 'Helvetica, Arial, sans-serif' });
dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as any;

const { boardSvg } = await import('../../web/components/boards/boardExport');

const els = JSON.parse(readFileSync(resolve(argOf('board')!), 'utf8')) as ArtifactElement[];
const out = resolve(argOf('out')!);
mkdirSync(out, { recursive: true });

/** A frame and every element whose box lies inside it. */
function within(key: string): string[] {
  const f = els.find((e) => e.key === key);
  if (!f) throw new Error(`no element ${key}`);
  const b = elementBox(f);
  return els.filter((e) => {
    if (e.kind === 'connector') return true;
    const x = elementBox(e);
    return x.x >= b.x - 1 && x.y >= b.y - 1 && x.x + x.w <= b.x + b.w + 1 && x.y + x.h <= b.y + b.h + 1;
  }).map((e) => e.key);
}
const views = [{ name: 'board', only: undefined as string[] | undefined }, ...process.argv.flatMap((a, i) => (a === '--view' ? [process.argv[i + 1]!] : [])).map((v) => {
  const [name, key] = v.split('=');
  return { name: name!.replace(/[^a-z0-9_-]/gi, ''), only: within(key!) };
})];

const byKey = new Map(els.map((e) => [e.key, e as any]));
const root = document.getElementById('root')!;
for (const v of views) {
  const raw = await boardSvg({ elements: els as any, byKey, root, only: v.only });
  // Every color the export could not resolve without a stylesheet, resolved; a white page behind it.
  const svg = raw
    .replace(/(fill|stroke|stop-color|color)="([^"]*(?:var\(|color-mix\()[^"]*)"/g, (_, attr: string, val: string) => `${attr}="${resolveColor(val.replaceAll('&quot;', '"'))}"`)
    .replace(/(fill|stroke|color):\s*([^;"]*(?:var\(|color-mix\()[^;"]*)/g, (_, attr: string, val: string) => `${attr}:${resolveColor(val)}`)
    // AppKit's SVG reader draws nothing for an element under the drop shadow filter.
    .replace(/ filter="url\(#sh\)"/g, '')
    .replace(/<svg([^>]*)>/, (m) => `${m}<rect x="-100000" y="-100000" width="200000" height="200000" fill="${resolveColor('var(--sol-bg)')}"/>`);
  const file = join(out, `${v.name}.svg`);
  writeFileSync(file, svg);
  const r = spawnSync('swift', [join(import.meta.dir, 'svg2png.swift'), file, join(out, `${v.name}.png`)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`svg2png: ${r.stderr}`);
  console.log(join(out, `${v.name}.png`));
}
process.exit(0);
