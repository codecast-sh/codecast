// The dashboard format: blocks in reading order on a 12-column grid that
// folds to two columns and then one as the window narrows. In edit mode a
// block shows its handle (drag to reorder), width, edit and remove controls;
// a block an agent or another person just wrote flashes in place.
import { memo, useMemo, useRef, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Download, GripVertical, Pencil, Trash2 } from "lucide-react";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import type { ReactNode } from "react";
import { ScrollyStory, VisualShort } from "./stories";
import { ChartBody, CheckMark, KpiBody, TableBody, TextBody, LiveText, type BlockEnv } from "./blocks";
import { blockCheck } from "./blockCheck";
import { resultFor } from "../../hooks/useDashboardData";
import { blockRows, downloadChartPng, downloadCsv, fileName, hasChart } from "./exportBlock";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const SPAN_LABEL: Record<number, string> = { 3: "¼", 4: "⅓", 6: "½", 8: "⅔", 12: "1" };

export type GridProps = {
  blocks: ArtifactElement[];
  env: BlockEnv;
  edit: boolean;
  selected: string | null;
  me: string | null;
  onSelect: (key: string | null) => void;
  onEdit: (key: string) => void;
  onRemove: (key: string) => void;
  onSpan: (key: string, span: number) => void;
  onMove: (key: string, toIndex: number) => void;
};

/** A data block with nothing to show (no source, no typed value): editors bind it, viewers never see it. */
function isEmptyBlock(b: ArtifactElement): boolean {
  if (b.kind === "text") return !String(b.text ?? "").trim();
  if (b.kind !== "kpi" && b.kind !== "chart" && b.kind !== "table") return false;
  return !dashboard.blockQuery(b) && (b.kind !== "kpi" || b.value === undefined || b.value === null);
}

export function DashboardGrid({ blocks: all, env, edit, selected, me, onSelect, onEdit, onRemove, onSpan, onMove }: GridProps) {
  const blocks = edit ? all : all.filter((b) => !isEmptyBlock(b));
  // The grid's own width picks the layout (a side panel open, a pane, a phone), not the window's.
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<dashboard.GridWidth>("wide");
  useMountEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => {
      const w = e[0]?.contentRect.width ?? 1200;
      setWidth(w > 860 ? "wide" : w > 480 ? "medium" : "narrow");
    });
    ro.observe(el);
    return () => ro.disconnect();
  });
  const spanSig = blocks.map((b) => dashboard.blockSpan(b)).join(",");
  const kpiSig = blocks.map((b) => (b.kind === "kpi" ? 1 : 0)).join("");
  const drawn = useMemo(() => dashboard.packSpans(spanSig.split(",").filter(Boolean).map(Number), width, [...kpiSig].map((c) => c === "1")), [spanSig, kpiSig, width]);
  const [drag, setDrag] = useState<{ key: string; over?: string; after?: boolean } | null>(null);
  const indexOf = (k: string) => blocks.findIndex((b) => b.key === k);
  const drop = () => {
    if (!drag?.over || drag.over === drag.key) return setDrag(null);
    const without = blocks.filter((b) => b.key !== drag.key);
    const at = without.findIndex((b) => b.key === drag.over) + (drag.after ? 1 : 0);
    onMove(drag.key, at);
    setDrag(null);
  };
  return (
    <div ref={gridRef} className="data-grid" role="list" onDragEnd={() => setDrag(null)}>
      {blocks.map((b, i) => (
        <Cell
          key={b.key}
          b={b}
          drawn={drawn[i] ?? 12}
          env={env}
          edit={edit}
          selected={selected === b.key}
          fresh={!!b.by && b.by !== me && !!b.at && env.now - Number(b.at) < 4000}
          dropSide={drag && drag.over === b.key && drag.key !== b.key ? (drag.after ? "after" : "before") : null}
          dragging={drag?.key === b.key}
          onSelect={onSelect}
          onEdit={onEdit}
          onRemove={onRemove}
          onSpan={onSpan}
          onDragStart={() => setDrag({ key: b.key })}
          onDragOver={(after) => drag && (drag.over !== b.key || drag.after !== after) && setDrag({ ...drag, over: b.key, after })}
          onDrop={drop}
          index={indexOf(b.key)}
        />
      ))}
    </div>
  );
}

type CellProps = {
  b: ArtifactElement;
  /** Columns the block is drawn across: its span as the width allows, stretched to close its row. */
  drawn: number;
  env: BlockEnv;
  edit: boolean;
  selected: boolean;
  fresh: boolean;
  dropSide: "before" | "after" | null;
  dragging: boolean;
  index: number;
  onSelect: (key: string | null) => void;
  onEdit: (key: string) => void;
  onRemove: (key: string) => void;
  onSpan: (key: string, span: number) => void;
  onDragStart: () => void;
  onDragOver: (after: boolean) => void;
  onDrop: () => void;
};

const Cell = memo(function Cell({ b, drawn, env, edit, selected, fresh, dropSide, dragging, onSelect, onEdit, onRemove, onSpan, onDragStart, onDragOver, onDrop }: CellProps) {
  const span = dashboard.blockSpan(b);
  const check = blockCheck(b, env);
  const plain = b.kind === "section" || b.kind === "text";
  const nextSpan = dashboard.SPANS[(dashboard.SPANS.indexOf(span as (typeof dashboard.SPANS)[number]) + 1) % dashboard.SPANS.length];
  return (
    <div
      role="listitem"
      data-block={b.key}
      data-kind={b.kind}
      data-span={span}
      style={{ gridColumn: `span ${drawn}` }}
      tabIndex={edit ? 0 : -1}
      draggable={edit}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", b.key);
        onDragStart();
      }}
      onDragOver={(e) => {
        if (!edit) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        // Full-width blocks stack, so above/below decides; narrower ones sit side by side, so left/right does.
        onDragOver(drawn === 12 ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onClick={() => edit && onSelect(b.key)}
      onDoubleClick={() => edit && onEdit(b.key)}
      className={[
        "data-cell group relative min-w-0 outline-none",
        plain ? "px-1" : "rounded-xl border bg-sol-card",
        plain ? "" : selected ? "border-sol-blue/70" : "border-sol-border/50",
        b.kind === "kpi" ? "px-4 pt-3.5 pb-3.5" : b.kind === "chart" || b.kind === "table" ? "p-4" : "",
        edit ? "cursor-default" : "",
        selected && plain ? "ring-1 ring-sol-blue/60 rounded-lg" : "",
        dragging ? "opacity-40" : "",
      ].join(" ")}
    >
      {fresh ? <span key={String(b.rev)} className="data-flash" aria-hidden /> : null}
      {dropSide ? <span className={`data-drop data-drop-${drawn === 12 ? (dropSide === "after" ? "below" : "above") : dropSide}`} /> : null}

      {b.kind === "section" ? (
        <div className="pt-4 pb-1">
          <h2 className="text-[17px] font-semibold text-sol-text">{String(b.title ?? "Section")}</h2>
          {b.caption ? <p className="text-meta text-sol-text-muted mt-0.5">{String(b.caption)}</p> : null}
        </div>
      ) : b.kind === "text" ? (
        <div className="py-1 pr-8">
          <TextBody b={b} env={env} />
          {check ? (
            <span className="absolute top-1.5 right-1.5">
              <CheckMark check={check} onClick={() => env.onCheck?.(b.key)} />
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2 mb-1.5 min-h-[22px]">
            <div className="min-w-0 flex-1">
              <div className={`truncate ${b.kind === "kpi" ? "text-[13px] text-sol-text-muted" : "text-sm font-semibold text-sol-text"}`}>{String(b.title || (edit ? "Untitled" : ""))}</div>
              {b.kind !== "kpi" && b.caption ? <div className="text-meta text-sol-text-muted truncate">{String(b.caption)}</div> : null}
            </div>
            <UnfilteredTag b={b} env={env} />
            {dashboard.blockQuery(b) ? <BlockExport b={b} env={env} /> : null}
            {check ? <CheckMark check={check} onClick={() => env.onCheck?.(b.key)} /> : null}
          </div>
          {b.kind === "kpi" ? <KpiBody b={b} env={env} /> : null}
          {b.kind === "chart" ? <div className="mt-2"><ChartBody b={b} env={env} height={Number(b.height) || (drawn >= 8 ? 260 : 220)} /></div> : null}
          {b.kind === "table" ? <div className="mt-2"><TableBody b={b} env={env} /></div> : null}
        </>
      )}

      {edit ? (
        <div data-export-skip className={`data-chrome absolute -top-3 right-3 z-10 flex items-center gap-px rounded-md border border-sol-border/60 bg-sol-bg shadow-sm ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
          <span className="p-1 text-sol-text-dim cursor-grab active:cursor-grabbing" title="Drag to move" aria-hidden>
            <GripVertical className="w-3.5 h-3.5" />
          </span>
          <button type="button" onClick={(e) => (e.stopPropagation(), onSpan(b.key, nextSpan))} title={`Width: ${SPAN_LABEL[span]} (click for ${SPAN_LABEL[nextSpan]})`} className="h-6 min-w-6 px-1 text-mark font-mono text-sol-text-muted hover:text-sol-text">
            {SPAN_LABEL[span]}
          </button>
          <button type="button" onClick={(e) => (e.stopPropagation(), onEdit(b.key))} title="Edit" aria-label="Edit block" className="p-1 text-sol-text-muted hover:text-sol-text">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={(e) => (e.stopPropagation(), onRemove(b.key))} title="Remove" aria-label="Remove block" className="p-1 text-sol-text-muted hover:text-sol-red">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
});

/** The dashboard filters this block's source cannot apply, named: "All dates", "All people". */
function UnfilteredTag({ b, env }: { b: ArtifactElement; env: BlockEnv }) {
  if (!env.scope || !dashboard.blockQuery(b)) return null;
  const missing = dashboard.scopeMissing(resultFor(env.results, b), env.scope);
  if (!missing.length) return null;
  const word = (c: string) => (c === "day" || c === "date" ? "dates" : c === "person" ? "people" : `${c}s`);
  return (
    <span className="shrink-0 h-5 px-1.5 rounded bg-sol-bg-alt text-meta leading-5 text-sol-text-dim whitespace-nowrap" title={`This source has no ${missing.join(" or ")} column, so the filter on it doesn't apply here`} data-unfiltered={missing.join(",")}>
      All {missing.map(word).join(", ")}
    </span>
  );
}

/** Take a block's data out: its rows as CSV, a chart as a PNG. Shown on hover, like the rest of a block's chrome. */
function BlockExport({ b, env }: { b: ArtifactElement; env: BlockEnv }) {
  const [open, setOpen] = useState(false);
  const csv = () => {
    const data = blockRows(b, resultFor(env.results, b), env.scope);
    if (data) downloadCsv(fileName(b.title, "csv"), data.columns, data.rows);
    setOpen(false);
  };
  const png = () => {
    const when = new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    downloadChartPng(b.key, fileName(b.title, "png"), { title: String(b.title || "Chart"), caption: [b.caption ? String(b.caption) : null, `As of ${when}`].filter(Boolean).join(" · ") });
    setOpen(false);
  };
  const item = "w-full flex items-center h-7 px-2 rounded text-left text-xs text-sol-text hover:bg-sol-bg-alt";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} aria-label="Download" title="Download" className={`inline-flex items-center justify-center w-7 h-7 -m-1.5 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt shrink-0 ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`} data-block-export>
          <Download className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={csv} className={item}>
          Rows as CSV
        </button>
        {b.kind === "chart" && hasChart(b.key) ? (
          <button type="button" onClick={png} className={item}>
            Chart as PNG
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The dashboard's own heading: its title and a live one-line summary. */
export function DashboardHeading({ title, summary, env, byline }: { title?: string; summary?: string; env: BlockEnv; byline?: ReactNode }) {
  if (!title && !summary && !byline) return null;
  return (
    <div className="mb-6" data-block="layout">
      {byline ? <div className="mb-2 flex items-center gap-2 text-meta text-sol-text-dim">{byline}</div> : null}
      {title ? <h1 className="text-[26px] leading-tight font-bold tracking-[-0.02em] text-sol-text"><LiveText text={title} env={env} /></h1> : null}
      {summary ? (
        <p className={`${title ? "mt-1.5" : ""} text-[15px] text-sol-text-secondary`}>
          <LiveText text={summary} env={env} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * The doc in its format: a story draws the blocks itself; the dashboard
 * format draws its heading and then `children` (the grid, editable or not).
 */
export function FormatBody({ title, layout, elements, env, children, onBackground, byline }: { title: string; layout: dashboard.DashboardLayout; elements: ArtifactElement[]; env: BlockEnv; children: ReactNode; onBackground?: () => void; byline?: ReactNode }) {
  if (layout.format === "scrolly") return <ScrollyStory title={title} layout={layout} elements={elements} env={env} />;
  if (layout.format === "short") return <VisualShort title={title} layout={layout} elements={elements} env={env} />;
  return (
    <div className="max-w-[1240px] mx-auto px-4 sm:px-8 pt-7 pb-24" onClick={(e) => e.target === e.currentTarget && onBackground?.()}>
      {/* The shell already shows the doc title; a heading here is only for a headline of its own (or a shared page, which has no shell title). */}
      <DashboardHeading title={layout.headline && layout.headline !== title ? layout.headline : byline ? title : undefined} summary={layout.summary} env={env} byline={byline} />
      {children}
    </div>
  );
}
