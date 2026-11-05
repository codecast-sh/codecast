// The app's theme as a canvas reads it. ECharts paints on a canvas, which
// cannot resolve CSS variables, so every color comes from the live
// `--sol-*` tokens resolved through a probe element (the browser does the
// var() and color-mix() work and hands back rgb), and is read again
// whenever the theme changes (`useChartTheme`).
import { useEffect, useState } from "react";

export type ChartTheme = {
  dark: boolean;
  bg: string; card: string; text: string; text2: string; muted: string; dim: string;
  line: string; grid: string; hover: string;
  blue: string; cyan: string; green: string; yellow: string; orange: string; red: string; magenta: string; violet: string;
  mono: string; ui: string;
};

type Rgb = [number, number, number];
const cache = new Map<string, Rgb>();

function probe(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById("ops-chart-color-probe");
  if (!el) {
    el = document.createElement("span");
    el.id = "ops-chart-color-probe";
    el.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden";
    document.body.appendChild(el);
  }
  return el;
}

function rgbOf(css: string): Rgb {
  const el = probe();
  if (!el) return [128, 128, 128];
  el.style.color = "";
  el.style.color = css;
  const got = getComputedStyle(el).color;
  const n = got.match(/[\d.]+/g)?.map(Number) ?? [];
  // `color(srgb r g b)` reports 0..1 channels; `rgb()` reports 0..255.
  const unit = got.startsWith("color(") ? 255 : 1;
  return [Math.round((n[0] ?? 128) * unit), Math.round((n[1] ?? 128) * unit), Math.round((n[2] ?? 128) * unit)];
}

/** A theme color at an opacity, as canvas-safe rgba. */
export function alpha(color: string, a: number): string {
  let rgb = cache.get(color);
  if (!rgb) { rgb = rgbOf(color); cache.set(color, rgb); }
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

/** Any CSS color (a `var(--sol-*)`, a color-mix) as canvas-safe rgb. */
export function resolveColor(css: string): string {
  let rgb = cache.get(css);
  if (!rgb) { rgb = rgbOf(css); cache.set(css, rgb); }
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function solid(token: string): string {
  const rgb = rgbOf(`var(${token})`);
  const css = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  cache.set(css, rgb);
  return css;
}

export function readChartTheme(): ChartTheme {
  const root = typeof document === "undefined" ? null : document.documentElement;
  const cs = root ? getComputedStyle(root) : null;
  const font = (v: string, fb: string) => (cs?.getPropertyValue(v).trim() || fb);
  const text = solid("--sol-text");
  const border = solid("--sol-border");
  return {
    dark: !!root?.classList.contains("dark"),
    bg: solid("--sol-bg"), card: solid("--sol-card"), text, text2: solid("--sol-text-secondary"),
    muted: solid("--sol-text-muted"), dim: solid("--sol-text-dim"),
    line: alpha(border, 0.45), grid: alpha(border, 0.18), hover: alpha(text, 0.05),
    blue: solid("--sol-blue"), cyan: solid("--sol-cyan"), green: solid("--sol-green"), yellow: solid("--sol-yellow"),
    orange: solid("--sol-orange"), red: solid("--sol-red"), magenta: solid("--sol-magenta"), violet: solid("--sol-violet"),
    mono: font("--font-mono", "ui-monospace, monospace"), ui: font("--font-ui", "ui-sans-serif, sans-serif"),
  };
}

let current: ChartTheme | null = null;
let version = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function ensureObserver() {
  if (observer || typeof document === "undefined") return;
  observer = new MutationObserver(() => {
    cache.clear();
    current = null;
    version++;
    listeners.forEach(l => l());
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme-vars"] });
}

export function chartTheme(): ChartTheme {
  ensureObserver();
  return (current ??= readChartTheme());
}

/** The chart theme, re-read when the app's theme changes. */
export function useChartTheme(): ChartTheme {
  const [, setV] = useState(version);
  useEffect(() => {
    ensureObserver();
    const l = () => setV(version);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return chartTheme();
}

// Shared pieces every Ops chart starts from, so axes, tooltips and labels
// read the same everywhere.
export function axisBase(t: ChartTheme) {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: t.dim, fontFamily: t.mono, fontSize: 10.5 },
    splitLine: { lineStyle: { color: t.grid } },
  };
}

export function tooltipBase(t: ChartTheme) {
  return {
    backgroundColor: t.card,
    borderWidth: 0,
    padding: [9, 11] as [number, number],
    textStyle: { color: t.text, fontFamily: t.ui, fontSize: 12 },
    extraCssText: `border-radius:10px;box-shadow:0 6px 24px ${t.dark ? "rgba(0,0,0,.45)" : "rgba(0,43,54,.14)"};`,
    confine: true,
  };
}

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** One tooltip row: a swatch, a label, a value right-aligned. */
export function tipRow(t: ChartTheme, swatch: string, label: string, value: string): string {
  return `<div style="display:flex;gap:14px;justify-content:space-between;margin-top:3px"><span style="display:flex;gap:6px;align-items:center;color:${t.muted}">${swatch}${esc(label)}</span><b style="font-family:${t.mono};font-weight:500">${esc(value)}</b></div>`;
}

export function swatch(color: string, dashed = false): string {
  const bg = dashed ? `repeating-linear-gradient(90deg,${color} 0 3px,transparent 3px 5px)` : color;
  return `<i style="display:inline-block;width:10px;height:2px;border-radius:2px;background:${bg}"></i>`;
}
