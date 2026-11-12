// Taking a block's data out of the dashboard: its rows as CSV (exactly the
// rows it shows, under the dashboard's filter) and a chart as a PNG drawn at
// twice the screen's density on the page's own background.
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { echarts, type ECharts } from "../ops/chart/echarts";
import type { DataResult } from "../../hooks/useDashboardData";

/** Live chart instances by block key, so a block's menu can export the chart it draws. */
const charts = new Map<string, ECharts>();

export function registerChart(key: string, chart: ECharts): () => void {
  charts.set(key, chart);
  return () => {
    if (charts.get(key) === chart) charts.delete(key);
  };
}

export function hasChart(key: string): boolean {
  return charts.has(key);
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as RFC 4180 CSV with a header line. */
export function toCsv(columns: readonly string[], rows: readonly unknown[][]): string {
  return [columns.map(cell).join(","), ...rows.map((r) => columns.map((_, i) => cell(r[i])).join(","))].join("\r\n");
}

/** The rows a block shows: a table's shaped rows, otherwise the rows its number or chart was computed from. */
export function blockRows(b: ArtifactElement, result: DataResult | undefined, scope?: dashboard.Where): { columns: string[]; rows: unknown[][] } | null {
  if (!result || !dashboard.blockQuery(b)) return null;
  if (b.kind === "table") {
    const ev = dashboard.evaluateTable(b as dashboard.TableBlock, result, scope);
    return ev.state === "ok" ? { columns: ev.columns, rows: ev.rows } : null;
  }
  const ev = dashboard.evaluateBlock(b.kind, b, result, scope);
  if (ev.state !== "ok") return null;
  const used = "used" in ev ? ev.used : [];
  return { columns: result.columns, rows: used.map((i) => result.rows[i]) };
}

export function fileName(title: unknown, ext: string): string {
  const base = String(title || "block").trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").toLowerCase() || "block";
  return `${base}.${ext}`;
}

function download(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadCsv(name: string, columns: readonly string[], rows: readonly unknown[][]) {
  // A byte-order mark so Excel reads the file as UTF-8.
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff), toCsv(columns, rows)], { type: "text/csv;charset=utf-8" }));
  download(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A chart as a picture someone can paste anywhere: its title and caption
 * above it, and every legend entry (a tile pages its legend; a picture cannot),
 * redrawn offscreen at twice the density.
 */
export function downloadChartPng(key: string, name: string, head: { title?: string; caption?: string }): boolean {
  const chart = charts.get(key);
  if (!chart) return false;
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue("--sol-card").trim() || "#fff";
  const width = chart.getWidth();
  const LEGEND_ROOM = 24;
  const height = chart.getHeight() + LEGEND_ROOM;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px`;
  document.body.appendChild(host);
  try {
    const copy = echarts.init(host, undefined, { renderer: "canvas", width, height });
    const opt = chart.getOption() as Record<string, any>;
    const legends = (opt.legend ?? []) as Array<Record<string, unknown>>;
    const grids = (opt.grid ?? []) as Array<Record<string, unknown>>;
    copy.setOption({
      ...opt,
      animation: false,
      legend: legends.map((l) => ({ ...l, type: "plain", width: width - 16 })),
      grid: grids.map((g) => ({ ...g, bottom: (Number(g.bottom) || 0) + (legends.some((l) => l.show !== false) ? LEGEND_ROOM : 0) })),
    });
    const img = new Image();
    img.onload = () => {
      const pad = 20;
      const band = head.title ? (head.caption ? 58 : 40) : 0;
      const canvas = document.createElement("canvas");
      canvas.width = (width + pad * 2) * 2;
      canvas.height = (height + band + pad * 2) * 2;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(2, 2);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width + pad * 2, height + band + pad * 2);
      const font = getComputedStyle(document.body).fontFamily;
      if (head.title) {
        ctx.fillStyle = css.getPropertyValue("--sol-text").trim() || "#111";
        ctx.font = `600 15px ${font}`;
        ctx.fillText(head.title, pad, pad + 16);
        if (head.caption) {
          ctx.fillStyle = css.getPropertyValue("--sol-text-muted").trim() || "#666";
          ctx.font = `400 12px ${font}`;
          ctx.fillText(head.caption, pad, pad + 36);
        }
      }
      ctx.drawImage(img, pad, pad + band, width, height);
      download(canvas.toDataURL("image/png"), name);
    };
    img.src = copy.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: bg });
    copy.dispose();
  } finally {
    host.remove();
  }
  return true;
}

/** Clear every chart's hover state (tooltip, highlight) so a picture never freezes one. */
export function clearChartHover(): void {
  for (const chart of charts.values()) {
    chart.dispatchAction({ type: "hideTip" });
    chart.dispatchAction({ type: "downplay" });
  }
}
