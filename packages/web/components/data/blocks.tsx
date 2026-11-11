// What each dashboard block draws from its evaluated rows: a KPI's number,
// a chart, a table, text with live numbers, a section header, and the check
// mark that opens the source behind any of them. The dashboard grid, the
// Scrollyteller and the Visual short all draw blocks through these, so a
// number looks and verifies the same in every format.
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { BadgeAlert, BadgeCheck, BadgeX, Bell, CircleDashed, Database, Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { OpsChart } from "../ops/chart/OpsChart";
import type { ECharts } from "../ops/chart/echarts";
import { registerChart } from "./exportBlock";
import { chartOption } from "./chartOption";
import { blockCheck } from "./blockCheck";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { resultFor, type DataResult } from "../../hooks/useDashboardData";

export type BlockEnv = {
  results: Map<string, DataResult>;
  blocks: Map<string, ArtifactElement>;
  now: number;
  /** Open the check behind a block (its query, source and rows). */
  onCheck?: (key: string) => void;
  /** Open the editor on a block with no source yet; absent where nobody can edit. */
  onBind?: (key: string) => void;
  /** The dashboard's own filter (date range, person...): narrows every block whose source has the column. */
  scope?: dashboard.Where;
  /** Open the rows behind one chart point. */
  onPoint?: (key: string, x: string, series?: string) => void;
  /** The dashboard's color slot per series name, so a person keeps one color across charts. */
  slotOf?: (name: string) => number | undefined;
};

// ── the check mark ──

const CHECK_LOOK: Record<dashboard.CheckState, { icon: typeof BadgeCheck; cls: string }> = {
  verified: { icon: BadgeCheck, cls: "text-sol-green" },
  refreshing: { icon: Loader2, cls: "text-sol-text-dim animate-spin" },
  loading: { icon: Loader2, cls: "text-sol-text-dim animate-spin" },
  stale: { icon: BadgeAlert, cls: "text-sol-yellow" },
  partial: { icon: BadgeAlert, cls: "text-sol-yellow" },
  broken: { icon: BadgeX, cls: "text-sol-red" },
  typed: { icon: CircleDashed, cls: "text-sol-text-dim" },
};

export function CheckMark({ check, onClick, size = 16 }: { check: dashboard.Check; onClick?: () => void; size?: number }) {
  const look = CHECK_LOOK[check.state];
  const Icon = look.icon;
  return (
    <button
      type="button"
      data-check={check.state}
      data-export-skip={check.state === "loading" || check.state === "refreshing" ? "" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      title={check.detail ? `${check.label}: ${check.detail}` : check.label}
      aria-label={`${check.label}. Open the source behind this number`}
      className="inline-flex items-center justify-center w-7 h-7 -m-1.5 rounded-md hover:bg-sol-bg-alt focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-blue shrink-0"
    >
      <Icon className={look.cls} style={{ width: size, height: size }} strokeWidth={2} />
    </button>
  );
}

// ── KPI ──

/** A number that counts up to its value the first time it shows (stories only). */
function useCountUp(target: number | null, run: boolean, ms = 900): number | null {
  const [v, setV] = useState<number | null>(run ? 0 : target);
  const done = useRef(!run);
  useWatchEffect(() => {
    if (target === null || done.current || !run) {
      setV(target);
      return;
    }
    done.current = true;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(p >= 1 ? target : target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run, ms]);
  return v;
}

export function KpiBody({ b, env, size = "md", countUp = false }: { b: ArtifactElement; env: BlockEnv; size?: "md" | "lg" | "xl" | "stage"; countUp?: boolean }) {
  const ev = dashboard.evaluateKpi(b as dashboard.KpiBlock, resultFor(env.results, b), env.scope);
  const numeric = ev.state === "ok" && typeof ev.value === "number" ? ev.value : null;
  const counted = useCountUp(numeric, countUp && numeric !== null);
  // A long value (a name from "top", a big exact count) steps down a size instead of being cut off.
  const long = ev.state === "ok" ? ev.display.length : 0;
  const tileSize = long > 14 ? "text-[20px] leading-[38px]" : long > 9 ? "text-[24px] leading-[38px]" : "text-[30px] leading-[38px]";
  const big = size === "stage" ? "text-[length:clamp(24px,min(5cqw,9cqh),52px)] leading-[1.1]" : size === "xl" ? "text-[length:clamp(40px,min(15cqw,30cqh),140px)] leading-[1.05] tracking-[-0.04em]" : size === "lg" ? (long > 12 ? "text-[30px] leading-[52px]" : "text-[44px] leading-[52px]") : tileSize;
  let value: ReactNode;
  if (ev.state === "ok") {
    const fmt = (b.agg === "top" ? "text" : (b.format as dashboard.NumberFormat)) ?? "number";
    value = counted !== null && numeric !== null && counted !== numeric ? dashboard.formatValue(Number.isInteger(numeric) ? Math.round(counted) : counted, fmt) : ev.display;
  } else if (ev.state === "unbound") value = env.onBind && (b.value === undefined || b.value === null) ? (
    <button type="button" onClick={(e) => (e.stopPropagation(), env.onBind!(b.key))} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-normal tracking-normal text-sol-text-secondary border border-dashed border-sol-border/60 hover:text-sol-text">
      <Database className="w-3.5 h-3.5" /> Bind a source
    </button>
  ) : ev.display;
  else if (ev.state === "loading") value = <span className="inline-block w-24 h-8 rounded-md bg-sol-bg-alt animate-pulse align-middle" />;
  else value = <span className="text-sol-text-dim">–</span>;
  const delta = ev.state === "ok" ? ev.delta : undefined;
  return (
    <>
      <div className={`${big} font-semibold tracking-tight tabular-nums text-sol-text truncate`} title={ev.state === "ok" ? ev.display : undefined} data-kpi-value>
        {value}
      </div>
      <div className={`mt-1.5 flex items-center gap-2 min-w-0 min-h-5 ${size === "xl" ? "justify-center text-sm" : "text-meta"}`}>
        {delta ? <DeltaChip d={delta} /> : null}
        {ev.state === "problem" ? (
          <span className="text-sol-red truncate">{ev.problem}</span>
        ) : (
          <span className="text-sol-text-muted truncate flex-1 min-w-0">{[delta?.caption, b.caption].filter(Boolean).join(" · ")}</span>
        )}
        <AlertMark b={b} env={env} />
      </div>
    </>
  );
}

/** A KPI's alert at a glance: a bell, red while the value sits past its line. */
function AlertMark({ b, env }: { b: ArtifactElement; env: BlockEnv }) {
  const alert = dashboard.readAlert(b);
  if (!alert) return null;
  const s = dashboard.alertState(b, resultFor(env.results, b));
  const fmt = (b.format as dashboard.NumberFormat | undefined) ?? "number";
  const lines = [alert.above !== undefined ? `above ${dashboard.formatValue(alert.above, fmt)}` : null, alert.below !== undefined ? `below ${dashboard.formatValue(alert.below, fmt)}` : null].filter(Boolean).join(" or ");
  const on = s && s.state !== "ok";
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 ${on ? "text-sol-red" : "text-sol-text-dim"}`} title={on ? `Alerting: ${s!.state} its line (alerts when ${lines})` : `Alerts when ${lines}`} data-kpi-alert={on ? s!.state : "armed"}>
      <Bell className="w-3 h-3" />
      {on ? <span className="font-medium">{s!.state}</span> : null}
    </span>
  );
}

export function DeltaChip({ d }: { d: dashboard.Delta }) {
  const tone = d.good === null ? "text-sol-text-secondary bg-sol-bg-alt" : d.good ? "text-sol-green bg-sol-green/10" : "text-sol-red bg-sol-red/10";
  const Icon = d.dir === "down" ? TrendingDown : TrendingUp;
  return (
    <span className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-md font-medium tabular-nums shrink-0 ${tone}`}>
      {d.dir !== "flat" ? <Icon className="w-3 h-3" /> : null}
      {d.display}
    </span>
  );
}

// ── chart ──

export const ChartBody = memo(function ChartBody({ b, env, height = 220, compact = true, revealMs = 0, annotate = false }: { b: ArtifactElement; env: BlockEnv; height?: number | string; compact?: boolean; revealMs?: number; annotate?: boolean }) {
  const result = resultFor(env.results, b);
  const ev = useMemo(() => dashboard.evaluateChart(b as dashboard.ChartBlock, result, env.scope), [b, result, env.scope]);
  if (ev.state === "loading") return <div className="rounded-lg bg-sol-bg-alt/60 animate-pulse" style={{ height }} />;
  if (ev.state === "unbound") return <BindSource height={height} onBind={env.onBind && (() => env.onBind!(b.key))} />;
  if (ev.state === "problem") return <BlockEmpty height={height} text={ev.problem} tone="red" />;
  if (!ev.x.length) return <BlockEmpty height={height} text="No rows in this window" />;
  return <SizedChart ev={ev} b={b} height={height} compact={compact} revealMs={revealMs} annotate={annotate} slotOf={b.series ? env.slotOf : undefined} onPoint={env.onPoint && ((x, series) => env.onPoint!(b.key, x, series))} />;
});

/** The chart with its width bucketed (narrow or not), so a resize redraws only when the layout it picks changes. */
function SizedChart({ ev, b, height, compact, revealMs, annotate, slotOf, onPoint }: { ev: Extract<dashboard.ChartEval, { state: "ok" }>; b: ArtifactElement; height: number | string; compact: boolean; revealMs: number; annotate: boolean; slotOf?: (name: string) => number | undefined; onPoint?: (x: string, series?: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useMountEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setNarrow((e[0]?.contentRect.width ?? 999) < 420));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const pointRef = useRef({ onPoint, ev, split: !!b.series });
  pointRef.current = { onPoint, ev, split: !!b.series };
  // Clicking a mark opens its rows; clicking the plot between marks opens the rows at that x.
  const unregister = useRef<(() => void) | null>(null);
  useMountEffect(() => () => unregister.current?.());
  const ready = (chart: ECharts) => {
    unregister.current = registerChart(b.key, chart);
    chart.on("click", (p: { name?: string; seriesName?: string }) => {
      const { onPoint: open, split } = pointRef.current;
      if (open && p.name !== undefined) open(String(p.name), split ? p.seriesName : undefined);
    });
    chart.getZr().on("click", (e: { target?: unknown; offsetX: number; offsetY: number }) => {
      const { onPoint: open, ev: cur } = pointRef.current;
      if (!open || e.target || !chart.containPixel("grid", [e.offsetX, e.offsetY])) return;
      const ranked = cur.type === "hbar";
      const at = chart.convertFromPixel(ranked ? { yAxisIndex: 0 } : { xAxisIndex: 0 }, ranked ? e.offsetY : e.offsetX) as unknown as number;
      const x = cur.x[Math.round(Number(at))];
      if (x !== undefined) open(x);
    });
  };
  return (
    <div ref={box} style={{ height }} className={onPoint ? "cursor-pointer" : undefined}>
      <OpsChart
      onReady={ready}
      option={(t) => chartOption(ev, t, { compact, revealMs, narrow, slotOf, annotate, measures: !b.series })}
      deps={[ev, compact, revealMs, narrow, slotOf, annotate]}
      height="100%"
      ariaLabel={`${b.title ?? "Chart"}: ${ev.how}`}
      />
    </div>
  );
}

/** A block with nothing bound yet: in the editor, the way to bind it. Viewers never see one (the grid leaves them out). */
function BindSource({ height, onBind }: { height: number | string; onBind?: () => void }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-sol-border/60" style={{ height }}>
      {onBind ? (
        <button type="button" onClick={(e) => (e.stopPropagation(), onBind())} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-sol-text-secondary hover:text-sol-text hover:bg-sol-bg-alt">
          <Database className="w-3.5 h-3.5" /> Bind a source
        </button>
      ) : null}
    </div>
  );
}

function BlockEmpty({ height, text, tone }: { height: number | string; text: string; tone?: "red" }) {
  return (
    <div className={`flex items-center justify-center rounded-lg border border-dashed px-4 text-center text-meta ${tone === "red" ? "border-sol-red/40 text-sol-red" : "border-sol-border/60 text-sol-text-dim"}`} style={{ height }}>
      {text}
    </div>
  );
}

// ── table ──

export function TableBody({ b, env, maxHeight = 320 }: { b: ArtifactElement; env: BlockEnv; maxHeight?: number }) {
  const result = resultFor(env.results, b);
  const ev = useMemo(() => dashboard.evaluateTable(b as dashboard.TableBlock, result, env.scope), [b, result, env.scope]);
  if (ev.state === "loading") return <div className="h-32 rounded-lg bg-sol-bg-alt/60 animate-pulse" />;
  if (ev.state === "unbound") return <BindSource height={96} onBind={env.onBind && (() => env.onBind!(b.key))} />;
  if (ev.state === "problem") return <BlockEmpty height={96} text={ev.problem} tone="red" />;
  return <RowsTable columns={ev.columns} rows={ev.rows} maxHeight={maxHeight} format={b.format as dashboard.NumberFormat | undefined} footer={ev.total > ev.rows.length ? `${ev.rows.length} of ${ev.total} rows` : undefined} />;
}

/** A plain rows table: numbers right-aligned and grouped, the header pinned while it scrolls. */
export function RowsTable({ columns, rows, maxHeight, format, highlight, footer, exact }: { columns: string[]; rows: unknown[][]; maxHeight?: number; format?: dashboard.NumberFormat; highlight?: Set<number>; footer?: string; exact?: boolean }) {
  const numeric = columns.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === null || r[i] === undefined || typeof r[i] === "number"));
  return (
    <div className="min-w-0">
      <div className="overflow-auto rounded-lg border border-sol-border/40" style={{ maxHeight }}>
        <table className="w-full text-[12.5px] tabular-nums border-collapse">
          <thead className="sticky top-0 bg-sol-card z-[1]">
            <tr>
              {columns.map((c, i) => (
                <th key={c} className={`px-3 h-8 font-medium text-sol-text-muted border-b border-sol-border/40 whitespace-nowrap ${numeric[i] ? "text-right" : "text-left"}`}>
                  {c.replace(/_/g, " ")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className={highlight?.has(ri) ? "bg-sol-blue/10" : "hover:bg-sol-bg-alt/50"} data-row={ri}>
                {columns.map((c, i) => (
                  <td key={c} className={`px-3 h-8 border-b border-sol-border/20 whitespace-nowrap ${exact ? "" : "max-w-[280px] truncate"} ${numeric[i] ? "text-right text-sol-text" : "text-sol-text-secondary"}`}>
                    {numeric[i] ? (exact ? exactNumber(r[i]) : dashboard.formatValue(r[i], c === "spend" ? "usd" : format === "text" ? "number" : format ?? "number")) : r[i] === null || r[i] === undefined ? "" : String(r[i])}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={columns.length || 1} className="px-3 h-16 text-center text-sol-text-dim">
                  No rows
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {footer ? <div className="mt-1.5 text-meta text-sol-text-dim">{footer}</div> : null}
    </div>
  );
}

/** A number exactly as the source sent it, grouped for reading but never rounded. */
function exactNumber(v: unknown): string {
  return typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 20 }) : v === null || v === undefined ? "" : String(v);
}

// ── text with live numbers ──

/** A KPI's live value inside prose: the number from its source, with its own check. */
function LiveNumber({ refKey, part, env }: { refKey: string; part: dashboard.TokenPart; env: BlockEnv }) {
  const target = env.blocks.get(refKey);
  if (!target || target.kind !== "kpi") return <span className="text-sol-red" title={`No KPI ${refKey}`}>{`{${refKey}}`}</span>;
  const ev = dashboard.evaluateKpi(target as dashboard.KpiBlock, resultFor(env.results, target), env.scope);
  const check = blockCheck(target, env);
  const text = dashboard.kpiPartText(ev, part);
  const tone = check?.state === "broken" ? "decoration-sol-red" : check?.state === "verified" ? "decoration-sol-green/60" : "decoration-sol-text-dim";
  return (
    <button
      type="button"
      onClick={() => env.onCheck?.(refKey)}
      title={`${target.title ?? refKey}: ${check?.label ?? ""}`}
      className={`font-semibold text-sol-text tabular-nums underline decoration-dotted decoration-2 underline-offset-4 ${tone} hover:decoration-solid`}
      data-live-number={refKey}
    >
      {text}
    </button>
  );
}

export function LiveText({ text, env }: { text: string; env: BlockEnv }) {
  const parts = useMemo(() => dashboard.parseText(text), [text]);
  return (
    <>
      {parts.map((p, i) => ("text" in p ? <span key={i}>{p.text}</span> : <LiveNumber key={i} refKey={p.ref} part={p.part} env={env} />))}
    </>
  );
}

export function TextBody({ b, env }: { b: ArtifactElement; env: BlockEnv }) {
  const text = String(b.text ?? "");
  if (!text.trim()) return <p className="text-sol-text-dim text-sm">Empty text</p>;
  return (
    <div className="text-[15px] leading-7 text-sol-text-secondary whitespace-pre-wrap max-w-[72ch]">
      <LiveText text={text} env={env} />
    </div>
  );
}
