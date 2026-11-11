// The pickers a validated cell opens: a dropdown of its list (type to
// filter, arrows and Enter to pick) and a month calendar for a date cell.
// Each hands back the input to write, the way a person would type it.
import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { PALETTE, dateToSerial, serialToDate, todaySerial, type PaletteColor, type ValidationOption } from "@codecast/shared/artifacts/sheets";
import { chipStyle } from "./cellPaint";
import "./formulaAssist.css";

export function ListPicker({ options, value, onPick }: { options: ValidationOption[]; value: string; onPick: (input: string) => void }) {
  const [q, setQ] = useState("");
  const want = q.trim().toLowerCase();
  const shown = want ? options.filter((o) => o.v.toLowerCase().includes(want)) : options;
  const current = shown.findIndex((o) => o.v.toLowerCase() === value.toLowerCase());
  const [pick, setPick] = useState(Math.max(0, current));
  const at = Math.min(pick, Math.max(0, shown.length - 1));
  return (
    <div className="sheet-picker" data-sheet-list-picker>
      <input
        autoFocus
        className="sheet-fn-search"
        placeholder="Filter"
        aria-label="Filter values"
        value={q}
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          setPick(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (shown.length) setPick((at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[at]) onPick(shown[at].v);
          }
        }}
      />
      <div className="sheet-picker-rows" role="listbox">
        {shown.map((o, i) => (
          <button
            key={o.v}
            type="button"
            role="option"
            aria-selected={i === at}
            className={`sheet-picker-row${i === at ? " is-picked" : ""}`}
            onMouseEnter={() => setPick(i)}
            onClick={() => onPick(o.v)}
          >
            <Chip text={o.v} color={o.color} />
          </button>
        ))}
        {shown.length === 0 && <span className="sheet-fn-empty">No match</span>}
      </div>
      {value && (
        <button type="button" className="sheet-picker-clear" onClick={() => onPick("")}>
          Clear
        </button>
      )}
    </div>
  );
}

export function Chip({ text, color }: { text: string; color?: PaletteColor }) {
  const c = chipStyle(color);
  return (
    <span className="sheet-chip" style={{ background: c.fill, color: c.color }}>
      {text}
    </span>
  );
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** A month calendar. `value` is the cell's date serial, if it holds one. */
export function DatePicker({ value, onPick }: { value: number | null; onPick: (input: string) => void }) {
  const today = serialToDate(todaySerial());
  const sel = value !== null ? serialToDate(value) : null;
  const [view, setView] = useState({ y: sel?.y ?? today.y, m: sel?.m ?? today.m });
  const first = dateToSerial(view.y, view.m, 1);
  const lead = (serialToDate(first).dow + 6) % 7; // Monday first
  const days = serialToDate(dateToSerial(view.y, view.m + 1, 1) - 1).d;
  const shift = (dm: number) => setView(({ y, m }) => ({ y: m + dm < 1 ? y - 1 : m + dm > 12 ? y + 1 : y, m: ((m + dm + 11) % 12) + 1 }));
  const same = (a: { y: number; m: number; d: number } | null, d: number) => !!a && a.y === view.y && a.m === view.m && a.d === d;
  return (
    <div className="sheet-picker sheet-date" data-sheet-date-picker>
      <div className="sheet-date-head">
        <button type="button" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span>
          {MONTHS[view.m - 1]} {view.y}
        </span>
        <button type="button" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="sheet-date-grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="sheet-date-dow">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`l${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
          <button
            key={d}
            type="button"
            className={`sheet-date-day${same(sel, d) ? " is-sel" : ""}${same(today, d) ? " is-today" : ""}`}
            onClick={() => onPick(iso(view.y, view.m, d))}
          >
            {d}
          </button>
        ))}
      </div>
      <div className="sheet-date-foot">
        <button type="button" onClick={() => onPick(iso(today.y, today.m, today.d))}>
          Today
        </button>
        {value !== null && (
          <button type="button" onClick={() => onPick("")}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Define a dropdown for a range: its values, each with a chip color, and
 * whether anything else is refused. Opens prefilled from the range's current
 * validation, or from the values already in it.
 */
export function ValidationEditor({
  rangeLabel,
  initial,
  strict: strictInitial,
  onApply,
  onRemove,
}: {
  rangeLabel: string;
  initial: ValidationOption[];
  strict: boolean;
  onApply: (options: ValidationOption[], strict: boolean) => void;
  onRemove?: () => void;
}) {
  const [opts, setOpts] = useState<ValidationOption[]>(() => (initial.length ? initial : [{ v: "", color: PALETTE[5] }]));
  const [strict, setStrict] = useState(strictInitial);
  const set = (i: number, patch: Partial<ValidationOption>) => setOpts((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const nextColor = (c?: PaletteColor) => PALETTE[(PALETTE.indexOf(c ?? "gray") + 1) % PALETTE.length];
  const valid = opts.some((o) => o.v.trim());
  return (
    <form
      className="sheet-dv"
      data-sheet-validation-editor
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onApply(opts.filter((o) => o.v.trim()), strict);
      }}
    >
      <div className="sheet-dv-head">
        <span>Dropdown</span>
        <code>{rangeLabel}</code>
      </div>
      <div className="sheet-dv-rows">
        {opts.map((o, i) => (
          <div key={i} className="sheet-dv-row">
            <button
              type="button"
              className="sheet-dv-swatch"
              style={{ background: chipStyle(o.color).fill, boxShadow: `inset 0 0 0 1.5px ${chipStyle(o.color).color}` }}
              aria-label={`Color: ${o.color ?? "gray"}`}
              title={o.color ?? "gray"}
              onClick={() => set(i, { color: nextColor(o.color) })}
            />
            <input
              autoFocus={i === opts.length - 1 && !o.v}
              value={o.v}
              placeholder="Value"
              aria-label="Value"
              spellCheck={false}
              onChange={(e) => set(i, { v: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  setOpts((x) => [...x, { v: "", color: nextColor(x[x.length - 1]?.color) }]);
                }
              }}
            />
            <button type="button" className="sheet-dv-x" aria-label="Remove value" onClick={() => setOpts((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [{ v: "" }]))}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="sheet-dv-add" onClick={() => setOpts((x) => [...x, { v: "", color: nextColor(x[x.length - 1]?.color) }])}>
        <Plus className="w-3.5 h-3.5" /> Add value
      </button>
      <label className="sheet-dv-strict">
        <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
        Only allow these values
      </label>
      <div className="sheet-dv-foot">
        {onRemove && (
          <button type="button" className="sheet-dv-remove" onClick={onRemove}>
            Remove dropdown
          </button>
        )}
        <span className="flex-1" />
        <button type="submit" className="sheet-dv-apply" disabled={!valid}>
          Done
        </button>
      </div>
    </form>
  );
}
