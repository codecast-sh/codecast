// The dashboard format: blocks in reading order on a 12-column grid that
// folds to two columns and then one as the window narrows. In edit mode a
// block shows its handle (drag to reorder), width, edit and remove controls;
// a block an agent or another person just wrote flashes in place.
import { memo, useState } from "react";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import type { ReactNode } from "react";
import { ScrollyStory, VisualShort } from "./stories";
import { ChartBody, CheckMark, KpiBody, TableBody, TextBody, LiveText, type BlockEnv } from "./blocks";
import { blockCheck } from "./blockCheck";

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
    <div className="data-grid" role="list" onDragEnd={() => setDrag(null)}>
      {blocks.map((b) => (
        <Cell
          key={b.key}
          b={b}
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

const Cell = memo(function Cell({ b, env, edit, selected, fresh, dropSide, dragging, onSelect, onEdit, onRemove, onSpan, onDragStart, onDragOver, onDrop }: CellProps) {
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
        onDragOver(span === 12 ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2);
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
      {dropSide ? <span className={`data-drop data-drop-${span === 12 ? (dropSide === "after" ? "below" : "above") : dropSide}`} /> : null}

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
            {check ? <CheckMark check={check} onClick={() => env.onCheck?.(b.key)} /> : null}
          </div>
          {b.kind === "kpi" ? <KpiBody b={b} env={env} /> : null}
          {b.kind === "chart" ? <div className="mt-2"><ChartBody b={b} env={env} height={Number(b.height) || (span >= 8 ? 260 : 220)} /></div> : null}
          {b.kind === "table" ? <div className="mt-2"><TableBody b={b} env={env} /></div> : null}
        </>
      )}

      {edit ? (
        <div className={`data-chrome absolute -top-3 right-3 z-10 flex items-center gap-px rounded-md border border-sol-border/60 bg-sol-bg shadow-sm ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
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
