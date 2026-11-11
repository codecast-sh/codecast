// The pieces around the grid: the cell ref box and formula bar, the in-cell
// editor (which is also the grid's keyboard focus), function autocomplete,
// the tab strip, and the selection summary.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Plus, Radio } from "lucide-react";
import { FUNCTION_NAMES, formatValue, type CellNumberFormat, type TabMeta } from "@codecast/shared/artifacts/sheets";
import { fnPrefixAt, useEditState, type EditStore } from "./editStore";

// ── Formula bar ─────────────────────────────────────────────────────────────

export function FormulaBar({
  edit,
  refLabel,
  activeInput,
  readOnly,
  onJump,
  onBeginBarEdit,
  onKey,
  error,
}: {
  edit: EditStore;
  refLabel: string;
  activeInput: string;
  /** The active cell's error and why, shown beside the formula. */
  error?: string;
  readOnly: boolean;
  onJump: (ref: string) => boolean;
  onBeginBarEdit: () => void;
  onKey: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, surface: "bar" | "cell") => void;
}) {
  const state = useEditState(edit);
  const [refDraft, setRefDraft] = useState<string | null>(null);
  const barRef = useRef<HTMLInputElement>(null);
  const value = state ? state.text : activeInput;
  useEffect(() => {
    if (state?.surface === "bar" && document.activeElement !== barRef.current) barRef.current?.focus();
  }, [state?.surface]);
  return (
    <div className="sheet-formula-bar" data-sheet-formula-bar>
      <input
        className="sheet-ref-box"
        data-sheet-ref-box
        aria-label="Cell reference"
        value={refDraft ?? refLabel}
        spellCheck={false}
        onFocus={(e) => {
          setRefDraft(refLabel);
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setRefDraft(e.target.value)}
        onBlur={() => setRefDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const ok = onJump(refDraft ?? "");
            if (ok) setRefDraft(null);
            else e.currentTarget.select();
          } else if (e.key === "Escape") {
            setRefDraft(null);
            onJump("");
          }
        }}
      />
      <span className="sheet-fx" aria-hidden>
        fx
      </span>
      <input
        ref={barRef}
        className="sheet-formula-input"
        data-sheet-formula-input
        aria-label="Formula"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onFocus={() => {
          if (!readOnly && !edit.get()) onBeginBarEdit();
          else if (edit.get()) edit.patch({ surface: "bar" });
        }}
        onChange={(e) => edit.patch({ text: e.target.value, surface: "bar" })}
        onKeyDown={(e) => onKey(e, "bar")}
      />
      {error && !state && (
        <span className="sheet-error-chip" data-sheet-error title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

// ── In-cell editor (and the grid's keyboard focus) ──────────────────────────

export type EditorPlacement = { x: number; y: number; w: number; h: number; visible: boolean; align: "left" | "right" | "center" };

export const CellEditor = memo(function CellEditor({
  edit,
  sinkRef,
  placement,
  readOnly,
  onKey,
  onBegin,
  onCopy,
  onCut,
  onPaste,
  onCaret,
}: {
  edit: EditStore;
  sinkRef: React.RefObject<HTMLTextAreaElement | null>;
  placement: EditorPlacement;
  readOnly: boolean;
  onKey: (e: ReactKeyboardEvent<HTMLTextAreaElement>, surface: "cell") => void;
  onBegin: (text: string) => void;
  onCopy: (e: React.ClipboardEvent) => void;
  onCut: (e: React.ClipboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onCaret: (caret: number) => void;
}) {
  const state = useEditState(edit);
  const editing = !!state && state.surface === "cell";
  const [width, setWidth] = useState(placement.w);
  const measureRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!editing) return;
    const m = measureRef.current;
    if (m) setWidth(Math.max(placement.w, Math.min(560, m.offsetWidth + 24)));
  }, [editing, state?.text, placement.w]);
  useEffect(() => {
    // Keep keyboard focus on the grid unless another field holds it.
    if (state?.surface === "bar") return;
    const el = sinkRef.current;
    const ae = document.activeElement as HTMLElement | null;
    if (el && ae !== el && (!ae || ae === document.body || ae.closest("[data-sheet-root]"))) {
      if (!ae?.closest("input, textarea, [contenteditable=true]") || ae === el) el.focus({ preventScroll: true });
    }
  });
  const prefix = editing && state ? fnPrefixAt(state.text, sinkRef.current?.selectionStart ?? state.text.length) : null;
  const matches = useMemo(() => (prefix && prefix.length >= 1 ? FUNCTION_NAMES.filter((n) => n.startsWith(prefix)).slice(0, 8) : []), [prefix]);
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [prefix]);

  const accept = (name: string) => {
    const el = sinkRef.current;
    if (!el || !state || !prefix) return;
    const caret = el.selectionStart ?? state.text.length;
    const start = caret - prefix.length;
    const next = state.text.slice(0, start) + name + "(" + state.text.slice(caret);
    edit.patch({ text: next });
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + name.length + 1;
      onCaret(start + name.length + 1);
    });
  };

  return (
    <>
      <span ref={measureRef} className="sheet-editor-measure" aria-hidden>
        {state?.text ?? ""}
      </span>
      <textarea
        ref={sinkRef}
        data-sheet-editor
        data-editing={editing ? "" : undefined}
        className="sheet-editor"
        readOnly={readOnly}
        spellCheck={false}
        autoComplete="off"
        aria-label="Cell editor"
        style={{
          left: placement.x,
          top: placement.y,
          width: editing ? width : 1,
          minHeight: editing ? placement.h : 1,
          height: editing ? placement.h : 1,
          opacity: editing ? 1 : 0,
          textAlign: editing && !state?.text.startsWith("=") ? placement.align : "left",
          pointerEvents: editing ? "auto" : "none",
        }}
        value={editing ? state!.text : ""}
        onChange={(e) => {
          if (readOnly) return;
          if (!edit.get()) onBegin(e.target.value);
          else edit.patch({ text: e.target.value });
          onCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => onCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (matches.length && editing) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setPick((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey && matches[pick] !== prefix)) {
              e.preventDefault();
              accept(matches[pick]);
              return;
            }
          }
          onKey(e, "cell");
        }}
        onCopy={editing ? undefined : onCopy}
        onCut={editing ? undefined : onCut}
        onPaste={editing ? undefined : onPaste}
      />
      {editing && matches.length > 0 && (
        <div className="sheet-autocomplete" style={{ left: placement.x, top: placement.y + placement.h + 2 }} role="listbox">
          {matches.map((name, i) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={i === pick}
              className={i === pick ? "is-picked" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(name);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </>
  );
});

// ── Tab strip ───────────────────────────────────────────────────────────────

export function TabStrip({
  tabs,
  activeId,
  readOnly,
  onSelect,
  onRename,
  onContext,
  onAdd,
  summary,
  renameRequest,
  onRenameDone,
}: {
  tabs: TabMeta[];
  activeId: string;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onContext: (id: string, e: React.MouseEvent) => void;
  onAdd: (e: React.MouseEvent) => void;
  summary: ReactNode;
  /** A tab the context menu asked to rename inline. */
  renameRequest?: string | null;
  onRenameDone?: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (!renameRequest) return;
    const t = tabs.find((x) => x.id === renameRequest);
    if (t && !t.query) {
      setDraft(t.name);
      setRenaming(t.id);
    }
    onRenameDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest]);
  return (
    <div className="sheet-tabs" data-sheet-tabs>
      {!readOnly && (
        <button type="button" className="sheet-tab-add" title="Add tab" aria-label="Add tab" onClick={onAdd}>
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
      <div className="sheet-tab-list">
        {tabs.map((t) =>
          renaming === t.id ? (
            <input
              key={t.id}
              autoFocus
              className="sheet-tab sheet-tab-rename"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => {
                if (draft.trim() && draft.trim() !== t.name) onRename(t.id, draft.trim());
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              style={{ width: `${Math.max(6, draft.length + 2)}ch` }}
            />
          ) : (
            <button
              key={t.id}
              type="button"
              data-sheet-tab={t.name}
              className={`sheet-tab ${t.id === activeId ? "is-active" : ""}`}
              onClick={() => onSelect(t.id)}
              onDoubleClick={() => {
                if (readOnly || t.query) return;
                setDraft(t.name);
                setRenaming(t.id);
              }}
              onContextMenu={(e) => onContext(t.id, e)}
              title={t.query ? `Live query: ${t.query.source}` : undefined}
            >
              {t.query && <Radio className="w-3 h-3 text-sol-green" />}
              {t.name}
            </button>
          ),
        )}
      </div>
      <span className="flex-1" />
      {summary}
    </div>
  );
}

/** Sum / average / count of the selection's numbers, the way Sheets shows it bottom-right. */
export function SelectionSummary({ values, style }: { values: Array<unknown>; style?: CellNumberFormat }) {
  let sum = 0, n = 0, count = 0;
  for (const v of values) {
    if (v === null || v === "") continue;
    count++;
    if (typeof v === "number") {
      sum += v;
      n++;
    }
  }
  if (count < 2) return null;
  const tidy = (x: number) => Number(x.toPrecision(12));
  // Totals read in the format of the cells summed (a growth column averages to a percent).
  const fmt = style?.nf && style.nf !== "text" ? style : undefined;
  const shown = (x: number) => formatValue(tidy(x), fmt ? { ...fmt, sign: false } : { nf: "number", dp: Number.isInteger(tidy(x)) ? 0 : 2 });
  return (
    <div className="sheet-summary" data-sheet-summary>
      {n > 0 && (
        <>
          <span>
            Sum <b>{shown(sum)}</b>
          </span>
          <span>
            Avg <b>{shown(sum / n)}</b>
          </span>
        </>
      )}
      <span>
        Count <b>{count}</b>
      </span>
    </div>
  );
}
