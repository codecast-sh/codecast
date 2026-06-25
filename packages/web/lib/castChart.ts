// Declarative charts for cast-canvas. The agent emits
//   <div class="cast-chart" data-spec='{ "marks": [...], "x": {...}, ... }'></div>
// and codecast renders it with Observable Plot — never agent JS. We bake in a
// solarized + JetBrains-Mono default theme so a bare spec "just works" and follows
// light/dark automatically (colors are passed as var(--sol-*) strings, which the
// shadow DOM resolves live).

import type * as PlotNS from "@observablehq/plot";

// Categorical default palette — solarized accents, as live CSS vars.
const SOL_RANGE = [
  "var(--sol-blue)", "var(--sol-green)", "var(--sol-yellow)", "var(--sol-magenta)",
  "var(--sol-cyan)", "var(--sol-orange)", "var(--sol-violet)", "var(--sol-red)",
];

// Friendly color words → tokens, so a spec can say "stroke":"blue".
const COLOR_WORDS: Record<string, string> = {
  blue: "var(--sol-blue)", green: "var(--sol-green)", yellow: "var(--sol-yellow)",
  orange: "var(--sol-orange)", red: "var(--sol-red)", magenta: "var(--sol-magenta)",
  violet: "var(--sol-violet)", cyan: "var(--sol-cyan)",
  text: "var(--sol-text)", muted: "var(--sol-text-muted)", border: "var(--sol-border)",
};

function resolveColor(v: unknown): unknown {
  return typeof v === "string" && COLOR_WORDS[v] ? COLOR_WORDS[v] : v;
}

// Plot's power features — histograms (binX), density (hexbin), per-category
// aggregates (groupX), beeswarms (dodgeX), moving averages (windowY) — are
// TRANSFORMS: functions that wrap a mark's options. JSON can't carry a function,
// so a mark may instead NAME one declaratively:
//   { "type":"rectY", "x":"v", "transform": { "kind":"binX", "out": {"y":"count"} } }
// codecast (never agent code) calls Plot[kind] from this allowlist and folds the
// mark's own channels into the transform's options. The allowlist keeps a spec
// from invoking arbitrary Plot exports.
const TRANSFORM_KINDS = new Set([
  "bin", "binX", "binY",
  "group", "groupX", "groupY", "groupZ",
  "stackX", "stackY",
  "hexbin", "dodgeX", "dodgeY",
  "normalizeX", "normalizeY", "windowX", "windowY", "shiftX",
]);

interface TransformSpec {
  kind: string;
  /** Outputs / first positional arg, e.g. {y:"count"} for binX, {r:"count"} for hexbin. */
  out?: Record<string, unknown>;
  /** Leading positional arg for transforms that take one (dodge anchor, normalize basis). */
  param?: unknown;
  /** Extra transform options (thresholds, binWidth, k, reduce, …). */
  options?: Record<string, unknown>;
}

function applyTransform(
  Plot: typeof PlotNS,
  t: TransformSpec,
  channelOpts: Record<string, unknown>,
): unknown {
  const fn = TRANSFORM_KINDS.has(t.kind)
    ? (Plot as unknown as Record<string, unknown>)[t.kind]
    : undefined;
  if (typeof fn !== "function") throw new Error(`unknown transform "${t.kind}"`);
  // The mark's channels (x, fill, …) are the transform's options; `out` supplies
  // the reduced outputs. Anything in `t.options` is merged in underneath.
  const options = { ...(t.options ?? {}), ...channelOpts };
  const lead = t.param !== undefined ? t.param : t.out;
  return lead !== undefined
    ? (fn as (a: unknown, o: unknown) => unknown)(lead, options)
    : (fn as (o: unknown) => unknown)(options);
}

interface MarkSpec { type: string; data?: unknown[]; transform?: TransformSpec; [k: string]: unknown; }
interface ChartSpec {
  data?: unknown[]; // default data; marks without their own `data` inherit this
  height?: number;
  marginTop?: number; marginRight?: number; marginBottom?: number; marginLeft?: number;
  x?: unknown; y?: unknown; fx?: unknown; fy?: unknown; color?: Record<string, unknown>; r?: unknown;
  marks?: MarkSpec[];
}

let plotPromise: Promise<typeof PlotNS> | null = null;
function loadPlot(): Promise<typeof PlotNS> {
  return (plotPromise ??= import("@observablehq/plot"));
}

function fail(el: HTMLElement, msg: string): void {
  el.textContent = `⚠ ${msg}`;
  el.style.cssText += ";color:var(--sol-red);font-size:12px;padding:8px;display:block";
}

async function renderChartInto(el: HTMLElement, fallbackWidth: number): Promise<void> {
  const raw = el.getAttribute("data-spec");
  if (!raw) return;
  // Size each chart to its OWN container, not the whole canvas — so a chart in a
  // grid cell or column (interleaved with HTML) fits its box. Fall back to the
  // canvas width when the element has no definite width yet.
  const width = el.clientWidth || fallbackWidth;
  let spec: ChartSpec;
  try {
    spec = JSON.parse(raw);
  } catch {
    return fail(el, "invalid chart spec (not JSON)");
  }
  let Plot: typeof PlotNS;
  try {
    Plot = await loadPlot();
  } catch {
    return fail(el, "chart engine failed to load");
  }
  try {
    const marks = (spec.marks ?? []).map((m) => {
      const { type, data, transform, ...opts } = m;
      const fn = (Plot as unknown as Record<string, unknown>)[type];
      if (typeof fn !== "function") throw new Error(`unknown mark "${type}"`);
      if ("stroke" in opts) opts.stroke = resolveColor(opts.stroke);
      if ("fill" in opts) opts.fill = resolveColor(opts.fill);
      // Default a bare mark to an accent instead of currentColor/black.
      if (opts.stroke === undefined && opts.fill === undefined && /line|dot|rule|tick/i.test(type)) {
        opts.stroke = "var(--sol-blue)";
      }
      if (opts.fill === undefined && /bar|area|rect|cell/i.test(type)) {
        opts.fill = "var(--sol-blue)";
      }
      // A transform (binX, hexbin, groupX, dodgeX, …) wraps the resolved channels.
      const finalOpts = transform ? applyTransform(Plot, transform, opts) : opts;
      return (fn as (d: unknown, o: unknown) => unknown)(data ?? spec.data ?? [], finalOpts);
    });

    const fig = Plot.plot({
      width: Math.max(200, width),
      height: spec.height ?? 210,
      marginTop: spec.marginTop ?? 26,
      marginRight: spec.marginRight ?? 20,
      marginBottom: spec.marginBottom ?? 38,
      marginLeft: spec.marginLeft ?? 54,
      style: {
        background: "transparent",
        color: "var(--sol-text-muted)",
        fontFamily: "var(--font-mono), ui-monospace, monospace",
        fontSize: "12px",
        overflow: "visible",
      },
      color: { range: SOL_RANGE, ...(spec.color ?? {}) },
      x: spec.x as never, y: spec.y as never, fx: spec.fx as never, fy: spec.fy as never, r: spec.r as never,
      marks: marks as never,
    });
    (fig as HTMLElement).style.maxWidth = "100%";
    el.replaceChildren(fig);
  } catch (e) {
    fail(el, e instanceof Error ? e.message : "chart render error");
  }
}

/** Render every .cast-chart element found under `root` (a shadow root). */
export async function hydrateCharts(root: ParentNode, width: number): Promise<void> {
  const els = Array.from(root.querySelectorAll<HTMLElement>(".cast-chart"));
  for (const el of els) await renderChartInto(el, width);
}

/** True if `root` contains any chart placeholders worth hydrating. */
export function hasCharts(root: ParentNode): boolean {
  return !!root.querySelector(".cast-chart");
}
