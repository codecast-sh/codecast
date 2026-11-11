// Pick a sheet range the way you select one in the sheet: the tab's cells as
// a small grid, drag (or click a column letter, shift-click to extend) to
// select, and the range writes when the pointer lifts. The A1 text beside it
// follows the selection and still takes a typed range.
import { useMemo, useRef, useState } from "react";
import { useEventListener } from "../../hooks/useEventListener";
import { sheet } from "@codecast/shared/artifacts";
import { colLetters, parseQualifiedRange, quoteTabName, rectA1, type Rect } from "@codecast/shared/artifacts/sheets";
import { useSyncLiveArtifact } from "../../hooks/useSyncLiveArtifact";
import { useLiveElements } from "../live/useLiveArtifact";
import { useCommittedDraft } from "../../hooks/useCommittedDraft";

const MAX_ROWS = 120;
const MAX_COLS = 26;

const norm = (r: Rect): Rect => ({ c0: Math.min(r.c0, r.c1), c1: Math.max(r.c0, r.c1), r0: Math.min(r.r0, r.r1), r1: Math.max(r.r0, r.r1) });
const shownCell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(v));

export function SheetRangePicker({ sheetId, range, header, onRange }: { sheetId: string; range: string | undefined; header: boolean; onRange: (range: string) => void }) {
  const { ready } = useSyncLiveArtifact(sheetId);
  const elements = useLiveElements(sheetId);
  const model = useMemo(() => sheet.buildModel(elements), [elements]);
  const tabs = useMemo(() => [...model.tabs].sort((a, b) => a.order - b.order), [model]);
  const parsed = range ? parseQualifiedRange(range) : null;
  const named = parsed?.tab !== undefined ? tabs.find((t) => t.name === parsed.tab || t.id === parsed.tab) : undefined;
  const [tabPick, setTabPick] = useState<string | null>(null);
  const tab = (tabPick ? tabs.find((t) => t.id === tabPick) : undefined) ?? named ?? tabs[0];
  const data = useMemo(() => (tab ? sheet.readSheetTab(elements, tab.name) : null), [elements, tab]);
  const values = data && !("error" in data) ? data.values : [];
  const rows = Math.min(Math.max(values.length, 8), MAX_ROWS);
  const cols = Math.min(Math.max(...values.map((r) => r.length), 4), MAX_COLS);

  const stored = parsed && tab && (parsed.tab === undefined ? tab === tabs[0] : tab === named) ? norm(parsed.rect) : null;
  const [drag, setDrag] = useState<Rect | null>(null);
  const sel = drag ?? stored;
  const dragRef = useRef<Rect | null>(null);
  dragRef.current = drag;

  const write = (r: Rect) => tab && onRange(`${quoteTabName(tab.name)}!${rectA1(norm(r))}`);
  // The drag ends wherever the pointer lifts, inside the grid or not.
  useEventListener("pointerup", () => {
    if (!dragRef.current) return;
    write(dragRef.current);
    setDrag(null);
  });

  const used = values.length ? { c0: 1, r0: 1, c1: Math.max(...values.map((r) => r.length)), r1: values.length } : null;
  const startAt = (c: number, r: number, extend: boolean) => setDrag(extend && sel ? { c0: sel.c0, r0: sel.r0, c1: c, r1: r } : { c0: c, r0: r, c1: c, r1: r });
  const inSel = (c: number, r: number) => !!sel && c >= sel.c0 && c <= sel.c1 && r >= sel.r0 && r <= sel.r1;

  if (!tabs.length) return <div className="h-24 grid place-items-center text-meta text-sol-text-dim">{ready ? "Empty sheet" : "Loading sheet…"}</div>;

  return (
    <div className="space-y-1.5" data-range-picker>
      <div className="flex items-center gap-1.5">
        {tabs.length > 1 ? (
          <select
            aria-label="Tab"
            value={tab?.id}
            onChange={(e) => {
              const t = tabs.find((x) => x.id === e.target.value);
              setTabPick(e.target.value);
              const d = t ? sheet.readSheetTab(elements, t.name) : null;
              const v = d && !("error" in d) ? d.values : [];
              if (t && v.length) onRange(`${quoteTabName(t.name)}!${rectA1({ c0: 1, r0: 1, c1: Math.max(...v.map((r) => r.length)), r1: v.length })}`);
            }}
            className="h-7 max-w-[45%] rounded-md bg-sol-bg border border-sol-border/60 pl-1.5 pr-5 text-xs text-sol-text outline-none focus:border-sol-blue"
          >
            {tabs.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : null}
        <RangeText value={range ?? ""} onCommit={(v) => v.trim() && onRange(v.trim())} />
        {used && !(sel && rectA1(sel) === rectA1(used)) ? (
          <button type="button" onClick={() => write(used)} className="shrink-0 h-7 px-2 rounded-md text-xs text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt">
            All cells
          </button>
        ) : null}
      </div>
      <div className="max-h-56 overflow-auto rounded-md border border-sol-border/60 bg-sol-bg select-none touch-none">
        <table className="border-collapse text-meta tabular-nums">
          <thead className="sticky top-0 z-[1] bg-sol-bg-alt">
            <tr>
              <th className="w-7 min-w-7 border-b border-r border-sol-border/50" />
              {Array.from({ length: cols }, (_, i) => i + 1).map((c) => (
                <th
                  key={c}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const r1 = Math.max(values.length, 1);
                    if (e.shiftKey && sel) write({ c0: sel.c0, r0: 1, c1: c, r1 });
                    else write({ c0: c, r0: 1, c1: c, r1 });
                  }}
                  className={`h-5 min-w-14 px-1 border-b border-r border-sol-border/50 font-normal cursor-pointer ${sel && c >= sel.c0 && c <= sel.c1 ? "text-sol-blue bg-sol-blue/10" : "text-sol-text-dim hover:text-sol-text"}`}
                >
                  {colLetters(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => i + 1).map((r) => (
              <tr key={r}>
                <td className={`sticky left-0 bg-sol-bg-alt text-center border-r border-b border-sol-border/40 ${sel && r >= sel.r0 && r <= sel.r1 ? "text-sol-blue" : "text-sol-text-dim"}`}>{r}</td>
                {Array.from({ length: cols }, (_, j) => j + 1).map((c) => {
                  const on = inSel(c, r);
                  const head = header && on && sel && r === sel.r0;
                  return (
                    <td
                      key={c}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        startAt(c, r, e.shiftKey);
                      }}
                      onPointerEnter={() => drag && setDrag({ ...drag, c1: c, r1: r })}
                      className={`h-5 max-w-28 px-1 truncate border-r border-b border-sol-border/30 cursor-cell ${on ? "bg-sol-blue/15 text-sol-text" : "text-sol-text-secondary"} ${head ? "font-semibold" : ""}`}
                    >
                      {shownCell(values[r - 1]?.[c - 1])}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RangeText({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const { draft, setDraft, onFocus, onBlur } = useCommittedDraft(value);
  const bad = draft.trim() !== "" && !parseQualifiedRange(draft);
  return (
    <input
      aria-label="Range"
      value={draft}
      placeholder="Sheet1!A1:D20"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={onFocus}
      onBlur={() => {
        onBlur();
        if (!bad && draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-invalid={bad || undefined}
      className={`h-7 min-w-0 flex-1 rounded-md bg-sol-bg border px-1.5 font-mono text-xs text-sol-text outline-none focus:border-sol-blue ${bad ? "border-sol-red/70" : "border-sol-border/60"}`}
    />
  );
}
