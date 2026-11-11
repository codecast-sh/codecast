// The pickers a validated cell opens: a dropdown of its list (type to
// filter, arrows and Enter to pick) and a month calendar for a date cell.
// Each hands back the input to write, the way a person would type it.
import { useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { PALETTE, dateToSerial, serialToDate, todaySerial, type PaletteColor, type ValidationOption } from "@codecast/shared/artifacts/sheets";
import { chipStyle } from "./cellPaint";
import "./formulaAssist.css";

export function ListPicker({
  options,
  value,
  onPick,
  query,
  onAdd,
  onEdit,
}: {
  options: ValidationOption[];
  value: string;
  onPick: (input: string) => void;
  query?: string;
  /** Add what was typed as a new value of the dropdown, and pick it. */
  onAdd?: (value: string) => void;
  /** Open the dropdown's editor. */
  onEdit?: () => void;
}) {
  const [q, setQ] = useState(query ?? "");
  const typed = q.trim();
  const want = typed.toLowerCase();
  const matched = want ? options.filter((o) => o.v.toLowerCase().includes(want)) : options;
  const noMatch = !!want && matched.length === 0;
  // Nothing matches what was typed: say so on the field, offer it as a new value, and keep every value one pick away.
  const shown = noMatch ? options : matched;
  const canAdd = !!onAdd && !!typed && !options.some((o) => o.v.toLowerCase() === want);
  const rows: Array<{ add: true } | { add?: false; o: ValidationOption }> = [...(canAdd ? [{ add: true as const }] : []), ...shown.map((o) => ({ o }))];
  const current = rows.findIndex((r) => !r.add && r.o.v.toLowerCase() === value.toLowerCase());
  const [pick, setPick] = useState(canAdd ? 0 : Math.max(0, current));
  const at = Math.min(pick, Math.max(0, rows.length - 1));
  const choose = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.add) onAdd?.(typed);
    else onPick(r.o.v);
  };
  return (
    <div className="sheet-picker" data-sheet-list-picker data-owns-keys>
      <input
        autoFocus
        className={`sheet-fn-search${noMatch ? " is-invalid" : ""}`}
        placeholder="Filter"
        aria-label="Filter values"
        aria-invalid={noMatch || undefined}
        value={q}
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          setPick(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (rows.length) setPick((at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(at);
          }
        }}
      />
      <div className="sheet-picker-rows" role="listbox">
        {rows.map((r, i) =>
          r.add ? (
            <button key="+add" type="button" role="option" aria-selected={i === at} data-sheet-picker-add className={`sheet-picker-row sheet-picker-add${i === at ? " is-picked" : ""}`} onMouseEnter={() => setPick(i)} onClick={() => choose(i)}>
              <Plus className="w-3.5 h-3.5" /> Add <Chip text={typed} />
            </button>
          ) : (
            <button
              key={r.o.v}
              type="button"
              role="option"
              aria-selected={i === at}
              aria-current={i === current || undefined}
              className={`sheet-picker-row${i === at ? " is-picked" : ""}`}
              onMouseEnter={() => setPick(i)}
              onClick={() => choose(i)}
            >
              <Chip text={r.o.v} color={r.o.color} />
              {i === current && <Check className="sheet-picker-current w-3.5 h-3.5" aria-label="Current value" />}
            </button>
          ),
        )}
      </div>
      {(value || onEdit) && (
        <div className="sheet-picker-foot">
          {value && (
            <button type="button" className="sheet-picker-clear" onClick={() => onPick("")}>
              Clear
            </button>
          )}
          {onEdit && (
            <button type="button" className="sheet-picker-clear" onClick={onEdit}>
              Edit dropdown
            </button>
          )}
        </div>
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

/** A month calendar. `value` is the cell's date serial, if it holds one. Arrows move the day, PageUp/PageDown the month, Enter picks. */
export function DatePicker({ value, onPick }: { value: number | null; onPick: (input: string) => void }) {
  const todayN = todaySerial();
  const today = serialToDate(todayN);
  const sel = value !== null ? serialToDate(value) : null;
  const [focus, setFocus] = useState(() => Math.floor(value ?? todayN));
  const f = serialToDate(focus);
  const view = { y: f.y, m: f.m };
  const first = dateToSerial(view.y, view.m, 1);
  const lead = (serialToDate(first).dow + 6) % 7; // Monday first
  const days = serialToDate(dateToSerial(view.y, view.m + 1, 1) - 1).d;
  /** The same day in a month some months away, clamped to that month's length. */
  const byMonths = (dm: number) => {
    const m0 = view.m - 1 + dm;
    const y = view.y + Math.floor(m0 / 12), m = (((m0 % 12) + 12) % 12) + 1;
    const last = serialToDate(dateToSerial(y, m + 1, 1) - 1).d;
    return dateToSerial(y, m, Math.min(f.d, last));
  };
  const same = (a: { y: number; m: number; d: number } | null, d: number) => !!a && a.y === view.y && a.m === view.m && a.d === d;
  const gridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const day = () => gridRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
    day();
    // The popover focuses its first button once it mounts; the day takes focus back on the next frame.
    const raf = requestAnimationFrame(day);
    return () => cancelAnimationFrame(raf);
  }, [focus]);
  const pickSerial = (n: number) => {
    const d = serialToDate(n);
    onPick(iso(d.y, d.m, d.d));
  };
  return (
    <div className="sheet-picker sheet-date" data-sheet-date-picker data-owns-keys>
      <div className="sheet-date-head">
        <button type="button" aria-label="Previous month" onClick={() => setFocus(byMonths(-1))}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span>
          {MONTHS[view.m - 1]} {view.y}
        </span>
        <button type="button" aria-label="Next month" onClick={() => setFocus(byMonths(1))}>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div
        ref={gridRef}
        className="sheet-date-grid"
        role="grid"
        aria-label={`${MONTHS[view.m - 1]} ${view.y}`}
        onKeyDown={(e) => {
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
          if (step !== undefined) setFocus((n) => n + step);
          else if (e.key === "PageUp") setFocus(byMonths(-1));
          else if (e.key === "PageDown") setFocus(byMonths(1));
          else if (e.key === "Home") setFocus(first);
          else if (e.key === "End") setFocus(first + days - 1);
          else if (e.key === "Enter" || e.key === " ") pickSerial(focus);
          else return;
          e.preventDefault();
        }}
      >
        {WEEKDAYS.map((w) => (
          <span key={w} className="sheet-date-dow" role="columnheader">
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
            role="gridcell"
            tabIndex={first + d - 1 === focus ? 0 : -1}
            aria-selected={same(sel, d)}
            className={`sheet-date-day${same(sel, d) ? " is-sel" : ""}${same(today, d) ? " is-today" : ""}${first + d - 1 === focus ? " is-focus" : ""}`}
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
      data-owns-keys
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
