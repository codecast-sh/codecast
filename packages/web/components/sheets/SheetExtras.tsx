// What dropdown and date cells, error cells and file drops draw over the
// grid: the active cell's picker button, the pickers, the dropdown editor,
// the error card and the drop target. State lives in useSheetExtras.
import type { MutableRefObject } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import type { ArtifactOp } from "@codecast/shared/artifacts";
import { rectA1, validationAt, validationOps } from "./sheetCore";
import { CursorPopover } from "../ui/context-menu";
import { DatePicker, ListPicker, ValidationEditor } from "./CellPickers";
import { ErrorCard } from "./ErrorCard";
import type { EditStore } from "./editStore";
import type { EditorPlacement } from "./SheetChrome";
import type { Sel } from "./sheetActions";
import type { SheetExtras } from "./useSheetExtras";

export function SheetExtrasView({
  x,
  placement,
  editing,
  readOnly,
  edit,
  select,
  apply,
  sinkRef,
  tabRows,
}: {
  x: SheetExtras;
  placement: EditorPlacement;
  editing: boolean;
  readOnly: boolean;
  edit: EditStore;
  select: (next: Sel, opts?: { reveal?: boolean }) => void;
  apply: (ops: ArtifactOp[]) => void;
  sinkRef: MutableRefObject<HTMLTextAreaElement | null>;
  tabRows: number;
}) {
  const { activeValidation, openPicker, errHover, errValue, errInfo, setErrHover, hoverRef, dropping, pickerPop, pickValue, dvPop, dropdownSeed, model, wb, activeTabId, S } = x;
  const editState = editing;
  const tab = { rows: tabRows };
  return (
    <>
        {activeValidation && !readOnly && !editState && placement.visible && (
          <button
            type="button"
            className="sheet-picker-btn"
            data-sheet-picker-btn
            aria-label={activeValidation.rule === "date" ? "Pick a date" : "Pick a value"}
            style={{ left: placement.x + placement.w - 22, top: placement.y + Math.max(0, (placement.h - 20) / 2), height: Math.min(20, placement.h) }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openPicker();
            }}
          >
            {activeValidation.rule === "date" ? <CalendarDays className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        )}
        {errHover && errValue && (
          <div
            className="sheet-error-pop"
            data-sheet-error-pop
            style={{ left: errHover.x, top: errHover.y }}
            onPointerLeave={() => {
              hoverRef.current.key = "";
              setErrHover(null);
            }}
          >
            <ErrorCard
              code={errValue.error}
              message={errValue.message}
              input={errInfo?.input ?? ""}
              onFix={
                readOnly
                  ? undefined
                  : (text) => {
                      const at = { col: errHover.col, row: errHover.row };
                      setErrHover(null);
                      select({ anchor: at, focus: at }, { reveal: false });
                      edit.set({ tab: activeTabId, ...at, text, mode: "edit", surface: "bar" });
                    }
              }
            />
          </div>
        )}
        {dropping && <div className="sheet-drop" data-sheet-drop>Drop to import as a new tab</div>}
      <CursorPopover state={pickerPop}>
        {(p) => {
          const v = validationAt(model, p.tab, p.col, p.row);
          const info = wb.cell(p.tab, p.col, p.row);
          if (!v) return null;
          return v.rule === "list" ? (
            <ListPicker options={v.options} value={typeof info?.value === "string" ? info.value : String(info?.value ?? "")} onPick={(input) => pickValue(p, input)} />
          ) : (
            <DatePicker value={typeof info?.value === "number" ? info.value : null} onPick={(input) => pickValue(p, input)} />
          );
        }}
      </CursorPopover>

      <CursorPopover state={dvPop}>
        {(p) => {
          const seed = dropdownSeed(p);
          return (
            <ValidationEditor
              rangeLabel={rectA1({ ...p.rect, r1: Math.min(p.rect.r1, Math.max(p.rect.r0, tab.rows)) })}
              initial={seed.options}
              strict={seed.strict}
              onApply={(options, strict) => {
                apply(validationOps(S.current.model, p.tab, p.rect, "list", options, strict));
                dvPop.close();
                sinkRef.current?.focus({ preventScroll: true });
              }}
              onRemove={seed.has ? () => {
                apply(validationOps(S.current.model, p.tab, p.rect, null));
                dvPop.close();
              } : undefined}
            />
          );
        }}
      </CursorPopover>

    </>
  );
}
