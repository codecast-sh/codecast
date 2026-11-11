// The foundation's proof sheet: one tab of raw cell inputs (no evaluation).
// The Sheets product (ct-91885) replaces this view in components/live/registry.ts.
import { useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { sheet, type ArtifactElement } from "@codecast/shared/artifacts";
import { useLiveElements } from "../useLiveArtifact";
import type { LiveViewProps } from "../registry";

const ROWS = 40;
const COLS = 12;
const CW = 112;
const RH = 26;
const HW = 44; // row header width
const HH = 24; // column header height
const TAB = sheet.DEFAULT_TAB;

export default function MinimalSheetView({ doc, live, selection, setSelection, mode, snapshot, toScreen }: LiveViewProps) {
  const liveEls = useLiveElements(doc._id, { kinds: ["cell"] });
  const elements = snapshot ?? liveEls;
  const cells = useMemo(() => new Map(elements.map((e) => [e.key, e])), [elements]);
  const [editing, setEditing] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const editable = mode === "edit";
  const active = selection[0] && sheet.parseCellKey(selection[0]) ? selection[0] : null;

  useWatchEffect(() => {
    const rect = (col: number, row: number) => ({ x: HW + (col - 1) * CW - scroll.x, y: HH + (row - 1) * RH - scroll.y });
    toScreen((pos) => {
      const ref = pos.range ?? pos.cell ?? (pos.key?.startsWith("c:") ? pos.key.slice(2) : undefined);
      if (!ref) return null;
      const [, span] = ref.split("!");
      const [a, b = a] = (span ?? "").split(":");
      const p = sheet.parseA1(a), q = sheet.parseA1(b);
      if (!p || !q) return null;
      const tl = rect(Math.min(p.col, q.col), Math.min(p.row, q.row));
      return { ...tl, w: (Math.abs(q.col - p.col) + 1) * CW, h: (Math.abs(q.row - p.row) + 1) * RH };
    });
  }, [toScreen, scroll]);

  const select = (key: string) => {
    setSelection([key]);
    live.setPresence({ position: { cell: key.slice(2) }, selection: [key] });
  };

  const write = (key: string, input: string) => {
    const cur = cells.get(key);
    if (input === String(cur?.input ?? "")) return;
    live.apply([input === "" ? { k: key, del: true } : { k: key, put: { kind: "cell", input } }]);
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 h-8 px-2 border-b border-sol-border/40 text-xs font-mono shrink-0">
        <span className="w-16 text-sol-text-muted">{active ? sheet.parseCellKey(active)!.a1 : ""}</span>
        <span className="text-sol-text-dim">=</span>
        <span className="text-sol-text truncate" data-live-formula>{active ? String(cells.get(active)?.input ?? "") : ""}</span>
      </div>
      <div ref={box} data-live-sheet className="relative flex-1 overflow-auto font-mono text-xs" onScroll={(e) => setScroll({ x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop })}>
        <div className="relative" style={{ width: HW + COLS * CW, height: HH + ROWS * RH }}>
          {Array.from({ length: COLS }, (_, c) => (
            <div key={`h${c}`} className="absolute top-0 flex items-center justify-center border-r border-b border-sol-border/30 bg-sol-bg-alt text-sol-text-dim" style={{ left: HW + c * CW, width: CW, height: HH }}>{sheet.colLetters(c + 1)}</div>
          ))}
          {Array.from({ length: ROWS }, (_, r) => (
            <div key={`r${r}`} className="absolute left-0 flex items-center justify-center border-r border-b border-sol-border/30 bg-sol-bg-alt text-sol-text-dim" style={{ top: HH + r * RH, width: HW, height: RH }}>{r + 1}</div>
          ))}
          {Array.from({ length: ROWS * COLS }, (_, i) => {
            const r = Math.floor(i / COLS) + 1, c = (i % COLS) + 1;
            const key = sheet.cellKey(TAB, `${sheet.colLetters(c)}${r}`);
            const el = cells.get(key);
            return (
              <Cell key={key} k={key} el={el} left={HW + (c - 1) * CW} top={HH + (r - 1) * RH} active={active === key} editing={editing === key}
                onSelect={() => select(key)} onEdit={() => editable && setEditing(key)}
                onDone={(v) => { if (v !== null) write(key, v); setEditing(null); }} />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Cell({ k, el, left, top, active, editing, onSelect, onEdit, onDone }: { k: string; el?: ArtifactElement; left: number; top: number; active: boolean; editing: boolean; onSelect: () => void; onEdit: () => void; onDone: (v: string | null) => void }) {
  const text = String(el?.input ?? "");
  const numeric = text !== "" && !Number.isNaN(Number(text));
  return (
    <div
      data-live-cell={k}
      className={`absolute border-r border-b border-sol-border/20 px-1.5 flex items-center overflow-hidden whitespace-nowrap ${active ? "outline outline-2 -outline-offset-1 outline-sol-blue z-10" : ""} ${numeric ? "justify-end" : ""}`}
      style={{ left, top, width: CW, height: RH }}
      onMouseDown={onSelect}
      onDoubleClick={onEdit}
    >
      {editing ? (
        <input
          autoFocus
          data-live-cell-input
          defaultValue={text}
          className="absolute inset-0 px-1.5 bg-sol-bg text-sol-text outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter") onDone((e.target as HTMLInputElement).value);
            if (e.key === "Escape") onDone(null);
          }}
          onBlur={(e) => onDone(e.target.value)}
        />
      ) : (
        <span className="text-sol-text truncate">{text}</span>
      )}
    </div>
  );
}
