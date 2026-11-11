// What dropdown and date cells, error cells and file drops draw over the
// grid: the active cell's picker button, the pickers, the dropdown editor,
// the error card and the drop target. State lives in useSheetExtras.
import type { MutableRefObject } from "react";
import { CalendarDays, Check, ChevronDown, Plus } from "lucide-react";
import { relativeTime } from "../../lib/entityDisplay";
import type { LiveHandle } from "../live/useLiveArtifact";
import type { ArtifactOp } from "@codecast/shared/artifacts";
import { colLetters, rectA1, validationAt, validationOps } from "./sheetCore";
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
  live,
}: {
  x: SheetExtras;
  placement: EditorPlacement;
  editing: boolean;
  readOnly: boolean;
  edit: EditStore;
  select: (next: Sel, opts?: { reveal?: boolean }) => void;
  apply: (ops: ArtifactOp[]) => void;
  sinkRef: MutableRefObject<HTMLTextAreaElement | null>;
  live: LiveHandle;
}) {
  const { activeValidation, openPicker, errHover, errValue, errInfo, setErrHover, hoverRef, dropping, pickerPop, pickValue, dvPop, dropdownSeed, model, wb, activeTabId, S, hoverThread, openCellComment, addOption } = x;
  const editState = editing;
  const invalidRule = errHover?.kind === "invalid" ? validationAt(model, activeTabId, errHover.col, errHover.row) : undefined;
  const invalidValue = invalidRule ? wb.value(activeTabId, errHover!.col, errHover!.row) : null;
  return (
    <>
        {/* A list cell always shows its picker; a date cell only while empty, so the button never covers its date (double-click or Alt+Down opens it). */}
        {activeValidation && !readOnly && !editState && placement.visible && (activeValidation.rule === "list" || wb.value(activeTabId, S.current.sel.anchor.col, S.current.sel.anchor.row) === null) && (
          <button
            type="button"
            className="sheet-picker-btn"
            data-sheet-picker-btn
            data-rule={activeValidation.rule}
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
        {errHover?.kind === "comment" && hoverThread && (
          <div
            className="sheet-error-pop sheet-comment-peek"
            data-sheet-error-pop
            data-sheet-comment-peek
            style={{ left: errHover.x, top: errHover.y, translate: errHover.above ? "0 -100%" : undefined }}
            onPointerLeave={() => {
              hoverRef.current.key = "";
              setErrHover(null);
            }}
          >
            <div className="sheet-comment-peek-head">
              <b>{String(hoverThread.root.author_name ?? "Someone")}</b>
              <span>{relativeTime(Number(hoverThread.root.created_at ?? hoverThread.root.at ?? 0)) ?? ""}</span>
              {hoverThread.replies.length > 0 && <span>+{hoverThread.replies.length}</span>}
            </div>
            <p>{String(hoverThread.root.text ?? "")}</p>
            <div className="sheet-comment-peek-actions">
              <button
                type="button"
                onClick={() => {
                  setErrHover(null);
                  openCellComment(errHover.col, errHover.row);
                }}
              >
                {hoverThread.replies.length ? "Open thread" : "Reply"}
              </button>
              {!readOnly && (
                <button
                  type="button"
                  aria-label="Resolve"
                  onClick={() => {
                    setErrHover(null);
                    live.apply([{ k: hoverThread.root.key, set: { resolved: true } }], { layer: "comments", undoable: false });
                  }}
                >
                  <Check className="w-3.5 h-3.5" /> Resolve
                </button>
              )}
            </div>
          </div>
        )}
        {errHover?.kind === "invalid" && invalidRule && (
          <div
            className="sheet-error-pop sheet-error-card"
            data-sheet-error-pop
            data-sheet-invalid-pop
            style={{ left: errHover.x, top: errHover.y, translate: errHover.above ? "0 -100%" : undefined }}
            onPointerLeave={() => {
              hoverRef.current.key = "";
              setErrHover(null);
            }}
          >
            <div className="sheet-error-card-head">
              <span className="sheet-error-title">{invalidRule.rule === "date" ? "Not a date" : "Not in the list"}</span>
            </div>
            <div className="sheet-error-message">{String(invalidValue)}</div>
            {!readOnly && (
              <div className="sheet-comment-peek-actions">
                <button type="button" onClick={() => { setErrHover(null); openPicker(errHover.col, errHover.row); }}>
                  {invalidRule.rule === "date" ? "Pick a date" : "Pick a value"}
                </button>
                {invalidRule.rule === "list" && (
                  <button type="button" onClick={() => { setErrHover(null); addOption({ tab: activeTabId, col: errHover.col, row: errHover.row }, String(invalidValue)); }}>
                    <Plus className="w-3.5 h-3.5" /> Add to list
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {errHover?.kind === "error" && errValue && (
          <div
            className="sheet-error-pop"
            data-sheet-error-pop
            style={{ left: errHover.x, top: errHover.y, translate: errHover.above ? "0 -100%" : undefined }}
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
      <CursorPopover state={pickerPop} className="p-2">
        {(p) => {
          const v = validationAt(model, p.tab, p.col, p.row);
          const info = wb.cell(p.tab, p.col, p.row);
          if (!v) return null;
          return v.rule === "list" ? (
            <ListPicker
              query={p.query}
              options={v.options}
              value={typeof info?.value === "string" ? info.value : String(info?.value ?? "")}
              onPick={(input) => pickValue(p, input)}
              onAdd={(value) => addOption(p, value)}
              onEdit={() => {
                const at = pickerPop.menu;
                pickerPop.close();
                if (at) dvPop.openAt(at.x, at.y, { tab: p.tab, rect: v.rect });
              }}
            />
          ) : (
            <DatePicker value={typeof info?.value === "number" ? info.value : null} onPick={(input) => pickValue(p, input)} />
          );
        }}
      </CursorPopover>

      <CursorPopover state={dvPop} className="p-2.5">
        {(p) => {
          const seed = dropdownSeed(p);
          return (
            <ValidationEditor
              rangeLabel={p.rect.r1 >= 1000 ? `${colLetters(p.rect.c0)}${p.rect.r0}:${colLetters(p.rect.c1)}` : rectA1(p.rect)}
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
