// The pieces around the grid: the cell ref box and formula bar, the in-cell
// editor (which is also the grid's keyboard focus), function autocomplete,
// the tab strip, and the selection summary.
import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { List, Plus, Radio } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import type { ArtifactPresence } from "@codecast/shared/artifacts";
import { formatValue, splitError, type CellNumberFormat, type TabMeta } from "@codecast/shared/artifacts/sheets";
import { useEditState, type EditStore } from "./editStore";
import { AssistPopup, FunctionList } from "./FormulaAssist";
import { useFormulaAssist } from "./useFormulaAssist";
import { ErrorCard } from "./ErrorCard";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useWatchEffect } from "../../hooks/useWatchEffect";

// ── Formula bar ─────────────────────────────────────────────────────────────

export function FormulaBar({
  edit,
  refLabel,
  activeInput,
  spilledFrom,
  readOnly,
  onJump,
  onBeginBarEdit,
  onKey,
  error,
}: {
  edit: EditStore;
  refLabel: string;
  activeInput: string;
  /** The array formula a spilled cell shows a value of: the bar shows it, muted, as Sheets does. */
  spilledFrom?: string;
  /** The active cell's error and why, shown beside the formula. */
  error?: string;
  readOnly: boolean;
  onJump: (ref: string) => boolean;
  onBeginBarEdit: () => void;
  onKey: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, surface: "bar" | "cell") => void;
}) {
  const state = useEditState(edit);
  const [refDraft, setRefDraft] = useState<string | null>(null);
  // A new selection replaces whatever was half-typed in the name box (a grid click doesn't blur it).
  useWatchEffect(() => setRefDraft(null), [refLabel]);
  const barRef = useRef<HTMLInputElement>(null);
  const value = state ? state.text : spilledFrom ?? activeInput;
  const barEditing = state?.surface === "bar";
  const assist = useFormulaAssist(edit, barEditing ? state.text : null, barRef);
  const [fnOpen, setFnOpen] = useState(false);
  useWatchEffect(() => {
    if (state?.surface === "bar" && document.activeElement !== barRef.current) barRef.current?.focus();
  }, [state?.surface]);
  /** Open the formula bar on a proposed formula; Enter writes it, Escape drops it. */
  const startWith = (text: string) => {
    if (!edit.get()) onBeginBarEdit();
    edit.patch({ text, surface: "bar" });
    requestAnimationFrame(() => barRef.current?.focus());
  };
  /** A function picked from the list: inserted at the caret of a formula being typed, else it starts one. */
  const insertFunction = (name: string) => {
    setFnOpen(false);
    if (readOnly) return;
    if (!edit.get()) onBeginBarEdit();
    const cur = edit.get();
    if (!cur) return;
    const el = barRef.current;
    const formula = cur.text.startsWith("=");
    const at = formula ? (el && cur.surface === "bar" ? el.selectionStart ?? cur.text.length : cur.text.length) : 1;
    const base = formula ? cur.text : "=";
    const text = base.slice(0, at) + name + "(" + base.slice(at);
    edit.patch({ text, surface: "bar" });
    requestAnimationFrame(() => {
      const bar = barRef.current;
      if (!bar || bar.value !== text) return;
      bar.focus();
      bar.selectionStart = bar.selectionEnd = at + name.length + 1;
      assist.track(bar);
    });
  };
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
      <Popover open={fnOpen} onOpenChange={setFnOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="sheet-fx-button" aria-label="Functions" title="Functions" data-sheet-fx>
            fx
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
          <FunctionList onPick={insertFunction} />
        </PopoverContent>
      </Popover>
      <span className="sheet-formula-field">
      <input
        ref={barRef}
        className={`sheet-formula-input${!state && spilledFrom ? " is-spilled" : ""}`}
        data-sheet-formula-input
        aria-label="Formula"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onFocus={() => {
          if (!readOnly && !edit.get()) onBeginBarEdit();
          else if (edit.get()) edit.patch({ surface: "bar" });
        }}
        onChange={(e) => {
          edit.patch({ text: e.target.value, surface: "bar", error: undefined });
          assist.track(e.target);
        }}
        onSelect={(e) => assist.track(e.currentTarget)}
        onKeyDown={(e) => {
          if (barEditing && assist.onKeyDown(e)) return;
          onKey(e, "bar");
        }}
      />
      {barEditing && state?.error ? (
        <div className="sheet-formula-error" style={{ left: 0, top: "calc(100% + 4px)" }} role="alert" data-sheet-formula-error>
          {state.error}
        </div>
      ) : (
        barEditing && <AssistPopup assist={assist} style={{ left: 0, top: "calc(100% + 4px)" }} />
      )}
      </span>
      {error && !state && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="sheet-error-chip" data-sheet-error>
              {splitError(error).code}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-3">
            <ErrorCard {...splitError(error)} input={activeInput} onFix={readOnly ? undefined : startWith} />
          </PopoverContent>
        </Popover>
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
  useWatchEffect(() => {
    // Keep keyboard focus on the grid unless another field holds it.
    if (state?.surface === "bar") return;
    const el = sinkRef.current;
    const ae = document.activeElement as HTMLElement | null;
    if (el && ae !== el && (!ae || ae === document.body || ae.closest("[data-sheet-root]"))) {
      if (!ae?.closest("input, textarea, [contenteditable=true]") || ae === el) el.focus({ preventScroll: true });
    }
  });
  const assist = useFormulaAssist(edit, editing && state ? state.text : null, sinkRef, onCaret);

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
          else edit.patch({ text: e.target.value, error: undefined });
          assist.track(e.target);
          onCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => {
          assist.track(e.currentTarget);
          onCaret(e.currentTarget.selectionStart ?? 0);
        }}
        onKeyDown={(e) => {
          if (editing && assist.onKeyDown(e)) return;
          onKey(e, "cell");
        }}
        onCopy={editing ? undefined : onCopy}
        onCut={editing ? undefined : onCut}
        onPaste={editing ? undefined : onPaste}
      />
      {editing && state?.error ? (
        <div className="sheet-formula-error" style={{ left: placement.x, top: placement.y + placement.h + 2 }} role="alert" data-sheet-formula-error>
          {state.error}
        </div>
      ) : (
        editing && <AssistPopup assist={assist} style={{ left: placement.x, top: placement.y + placement.h + 2 }} />
      )}
    </>
  );
});

// ── Tab strip ───────────────────────────────────────────────────────────────

const TAB_DRAG = "application/x-codecast-sheet-tab";

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
  others,
  unseen,
  onReorder,
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
  /** Everyone else on the page: a tab label shows who is working on it. */
  others?: ArtifactPresence[];
  /** Tabs an agent wrote to since this page last showed them. */
  unseen?: Set<string>;
  /** A tab dragged to a place in the strip. */
  onReorder?: (id: string, to: number) => void;
}) {
  const onTab = (id: string) => (others ?? []).filter((p) => presenceTab(p) === id);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useWatchEffect(() => {
    if (!renameRequest) return;
    const t = tabs.find((x) => x.id === renameRequest);
    if (t) {
      setDraft(t.name);
      setRenaming(t.id);
    }
    onRenameDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest]);
  // The open tab stays in view when the strip scrolls (a pick from All tabs, a link to a tab).
  const listRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".sheet-tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  return (
    <div className="sheet-tabs" data-sheet-tabs>
      {!readOnly && (
        <button type="button" className="sheet-tab-add" title="Add tab" aria-label="Add tab" onClick={onAdd}>
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
      <div className="sheet-tab-list" ref={listRef}>
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
              draggable={!readOnly && !!onReorder}
              onDragStart={(e) => e.dataTransfer.setData(TAB_DRAG, t.id)}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(TAB_DRAG)) e.preventDefault();
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(TAB_DRAG);
                if (!id || id === t.id) return;
                e.preventDefault();
                onReorder?.(id, tabs.findIndex((x) => x.id === t.id));
              }}
              onDoubleClick={() => {
                if (readOnly) return;
                setDraft(t.name);
                setRenaming(t.id);
              }}
              onContextMenu={(e) => onContext(t.id, e)}
              title={t.query ? `Live query: ${t.query.source}` : undefined}
            >
              {t.query && <Radio className="w-3 h-3 text-sol-green" />}
              {t.name}
              {t.id !== activeId && <TabActivity people={onTab(t.id)} unseen={!!unseen?.has(t.id)} />}
            </button>
          ),
        )}
      </div>
      {tabs.length > 1 && (
        // Every tab, by name: a narrow pane hides some of the strip.
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="sheet-tab-add" aria-label="All tabs" title="All tabs" data-sheet-all-tabs>
              <List className="w-3.5 h-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="min-w-[180px]">
            {tabs.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => onSelect(t.id)} className={t.id === activeId ? "font-semibold" : undefined}>
                {t.query && <Radio className="w-3 h-3 text-sol-green" />}
                {t.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <span className="flex-1" />
      {summary}
    </div>
  );
}

/** The tab id a participant's cursor or range sits on ("t1!B2" → "t1"). */
function presenceTab(p: ArtifactPresence): string | null {
  const at = p.position?.range ?? p.position?.cell;
  const bang = at ? at.lastIndexOf("!") : -1;
  return bang > 0 ? at!.slice(0, bang) : null;
}

/** On a tab label: a dot per person or agent working there, and a mark for agent writes not yet looked at. */
function TabActivity({ people, unseen }: { people: ArtifactPresence[]; unseen: boolean }) {
  if (!people.length && !unseen) return null;
  return (
    <span className="sheet-tab-activity" data-sheet-tab-activity>
      {people.slice(0, 3).map((p) => (
        <span key={p.actor} className={`sheet-tab-face${p.kind === "agent" ? " is-agent" : ""}`} style={{ background: p.color }} title={p.status ? `${p.name}: ${p.status}` : p.name} />
      ))}
      {unseen && !people.some((p) => p.kind === "agent") && <span className="sheet-tab-unseen" title="New agent edits" data-sheet-tab-unseen />}
    </span>
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
  // Dates are serial numbers underneath: their sum means nothing, so a date selection shows its count only.
  const dates = style?.nf === "date" || style?.nf === "datetime";
  if (dates) n = 0;
  // 15 significant digits: as many as a double holds exactly, so a large sum never shows invented zeros.
  const tidy = (x: number) => Number(x.toPrecision(15));
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
