// The bar that floats above a selection: what you can do to exactly what is
// selected. Color, shape, type size, connector style, align and distribute,
// group, z-order, stickies into tasks or a plan, Describe a change, delete.
import { memo, useLayoutEffect, useRef, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Circle,
  Diamond,
  ExternalLink,
  Group,
  ListChecks,
  Map as MapIcon,
  MoveRight,
  Spline,
  Square,
  Trash2,
  Ungroup,
  Wand2,
  Minus,
  MoveHorizontal,
  RectangleHorizontal,
} from "lucide-react";
import { BOARD_COLORS, type AlignMode } from "@codecast/shared/artifacts/board";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { colorToken } from "./boardColors";
import type { BoardEl } from "./boardTypes";

export type BarAction =
  | { type: "set"; fields: Record<string, any>; kinds?: string[] }
  | { type: "align"; mode: AlignMode }
  | { type: "distribute"; axis: "h" | "v" }
  | { type: "group" }
  | { type: "ungroup" }
  | { type: "order"; where: "front" | "back" }
  | { type: "tasks" }
  | { type: "plan" }
  | { type: "describe" }
  | { type: "open" }
  | { type: "delete" };

const TEXT_SIZES = [14, 20, 28, 40, 56];

function Btn({ label, accel, active, onClick, children }: { label: string; accel?: string; active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <ShortcutTooltip label={label} accel={accel} side="top">
      <button type="button" className={`board-bar-btn${active ? " is-active" : ""}`} aria-label={label} aria-pressed={active} onClick={onClick}>
        {children}
      </button>
    </ShortcutTooltip>
  );
}

const I = { size: 15, strokeWidth: 1.75 } as const;

export const BoardSelectionBar = memo(function BoardSelectionBar({ selected, at, paneWidth, canMakeTasks, onAction }: {
  selected: BoardEl[];
  /** Screen position: the bar's bottom-center (top-center when below). */
  at: { x: number; y: number; below: boolean };
  /** The canvas width, so the bar stays whole inside it. */
  paneWidth: number;
  /** Tasks are real objects a draft discard cannot take back, so they wait for a saved board. */
  canMakeTasks: boolean;
  onAction(a: BarAction): void;
}) {
  const [menu, setMenu] = useState<"color" | "align" | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    if (w !== width) setWidth(w);
  });
  const half = width / 2 + 8;
  const left = width ? Math.min(Math.max(at.x, half), Math.max(half, paneWidth - half)) : at.x;
  const kinds = new Set(selected.map((e) => e.kind));
  const only = (k: string) => kinds.size === 1 && kinds.has(k);
  const first = selected[0];
  const colorable = selected.some((e) => ["sticky", "shape", "frame", "text", "connector", "pen"].includes(e.kind));
  const stickies = selected.filter((e) => e.kind === "sticky");
  const grouped = selected.some((e) => typeof e.group === "string");
  const n = selected.length;
  const color = typeof first?.color === "string" ? first.color : first?.kind === "sticky" ? "yellow" : "gray";
  const act = (a: BarAction) => { setMenu(null); onAction(a); };
  return (
    <div
      ref={ref}
      className={`board-bar${at.below ? " is-below" : ""}`}
      data-board-ui
      style={{ left, top: at.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {menu === "color" && (
        <div className="board-bar-menu">
          {BOARD_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} className={`board-swatch${c === color ? " is-active" : ""}`} style={{ ["--sw" as any]: colorToken(c) }} onClick={() => act({ type: "set", fields: { color: c } })} />
          ))}
        </div>
      )}
      {menu === "align" && (
        <div className="board-bar-menu">
          <Btn label="Align left" onClick={() => act({ type: "align", mode: "left" })}><AlignStartVertical {...I} /></Btn>
          <Btn label="Align centers" onClick={() => act({ type: "align", mode: "hcenter" })}><AlignCenterVertical {...I} /></Btn>
          <Btn label="Align right" onClick={() => act({ type: "align", mode: "right" })}><AlignEndVertical {...I} /></Btn>
          <Btn label="Align top" onClick={() => act({ type: "align", mode: "top" })}><AlignStartHorizontal {...I} /></Btn>
          <Btn label="Align middles" onClick={() => act({ type: "align", mode: "vcenter" })}><AlignCenterHorizontal {...I} /></Btn>
          <Btn label="Align bottom" onClick={() => act({ type: "align", mode: "bottom" })}><AlignEndHorizontal {...I} /></Btn>
          {n >= 3 && <span className="board-bar-sep" />}
          {n >= 3 && <Btn label="Space evenly across" onClick={() => act({ type: "distribute", axis: "h" })}><AlignHorizontalSpaceAround {...I} /></Btn>}
          {n >= 3 && <Btn label="Space evenly down" onClick={() => act({ type: "distribute", axis: "v" })}><AlignVerticalSpaceAround {...I} /></Btn>}
        </div>
      )}

      {colorable && (
        <Btn label="Color" active={menu === "color"} onClick={() => setMenu(menu === "color" ? null : "color")}>
          <span className="board-bar-swatch" style={{ background: colorToken(color) }} />
        </Btn>
      )}
      {only("shape") && (
        <>
          <Btn label="Rectangle" active={first.shape === "rect" || !first.shape} onClick={() => act({ type: "set", fields: { shape: "rect" } })}><Square {...I} /></Btn>
          <Btn label="Ellipse" active={first.shape === "ellipse"} onClick={() => act({ type: "set", fields: { shape: "ellipse" } })}><Circle {...I} /></Btn>
          <Btn label="Diamond" active={first.shape === "diamond"} onClick={() => act({ type: "set", fields: { shape: "diamond" } })}><Diamond {...I} /></Btn>
          <Btn label="Pill" active={first.shape === "pill"} onClick={() => act({ type: "set", fields: { shape: "pill" } })}><RectangleHorizontal {...I} /></Btn>
          <Btn label="Filled" active={first.solid === true} onClick={() => act({ type: "set", fields: { solid: first.solid === true ? null : true } })}><span className="board-bar-fill" style={{ background: colorToken(color) }} /></Btn>
        </>
      )}
      {only("text") && (
        <>
          <Btn label="Text size" onClick={() => {
            const cur = typeof first.size === "number" ? first.size : 20;
            const next = TEXT_SIZES.find((s) => s > cur) ?? TEXT_SIZES[0];
            act({ type: "set", fields: { size: next, w: null, h: null } });
          }}>
            <span className="board-bar-num">{typeof first.size === "number" ? Math.round(first.size) : 20}</span>
          </Btn>
          <Btn label="Bold" active={first.weight === "bold"} onClick={() => act({ type: "set", fields: { weight: first.weight === "bold" ? null : "bold" } })}><Bold {...I} /></Btn>
        </>
      )}
      {only("connector") && (
        <>
          <Btn label="Straight" active={first.curve !== "curved"} onClick={() => act({ type: "set", fields: { curve: null } })}><Minus {...I} /></Btn>
          <Btn label="Curved" active={first.curve === "curved"} onClick={() => act({ type: "set", fields: { curve: "curved" } })}><Spline {...I} /></Btn>
          <Btn label="Arrow ends" onClick={() => {
            const order = ["end", "both", "none"];
            const cur = typeof first.arrow === "string" ? first.arrow : "end";
            act({ type: "set", fields: { arrow: order[(order.indexOf(cur) + 1) % order.length] } });
          }}>
            {first.arrow === "both" ? <MoveHorizontal {...I} /> : first.arrow === "none" ? <Minus {...I} /> : <MoveRight {...I} />}
          </Btn>
          <Btn label="Dashed" active={first.dash === true} onClick={() => act({ type: "set", fields: { dash: first.dash === true ? null : true } })}><span className="board-bar-dash" /></Btn>
        </>
      )}
      {only("card") && n === 1 && <Btn label="Open" onClick={() => act({ type: "open" })}><ExternalLink {...I} /></Btn>}

      {n >= 2 && (
        <>
          <span className="board-bar-sep" />
          <Btn label="Align" active={menu === "align"} onClick={() => setMenu(menu === "align" ? null : "align")}><AlignStartVertical {...I} /></Btn>
          {grouped
            ? <Btn label="Ungroup" accel="Shift+CmdOrCtrl+G" onClick={() => act({ type: "ungroup" })}><Ungroup {...I} /></Btn>
            : <Btn label="Group" accel="CmdOrCtrl+G" onClick={() => act({ type: "group" })}><Group {...I} /></Btn>}
        </>
      )}
      {n === 1 && grouped && <Btn label="Ungroup" accel="Shift+CmdOrCtrl+G" onClick={() => act({ type: "ungroup" })}><Ungroup {...I} /></Btn>}
      <span className="board-bar-sep" />
      <Btn label="Bring to front" accel="]" onClick={() => act({ type: "order", where: "front" })}><ArrowUpToLine {...I} /></Btn>
      <Btn label="Send to back" accel="[" onClick={() => act({ type: "order", where: "back" })}><ArrowDownToLine {...I} /></Btn>

      {stickies.length > 0 && canMakeTasks && (
        <>
          <span className="board-bar-sep" />
          <ShortcutTooltip label={`Make ${stickies.length} task${stickies.length === 1 ? "" : "s"}`} side="top">
            <button type="button" className="board-bar-btn board-bar-text" onClick={() => act({ type: "tasks" })}>
              <ListChecks {...I} />
              <span>{stickies.length === 1 ? "Task" : `${stickies.length} tasks`}</span>
            </button>
          </ShortcutTooltip>
          {stickies.length > 1 && (
            <ShortcutTooltip label="Make a plan of these" side="top">
              <button type="button" className="board-bar-btn board-bar-text" onClick={() => act({ type: "plan" })}>
                <MapIcon {...I} />
                <span>Plan</span>
              </button>
            </ShortcutTooltip>
          )}
        </>
      )}
      <span className="board-bar-sep" />
      <ShortcutTooltip label="Describe a change" accel="A" side="top">
        <button type="button" className="board-bar-btn board-bar-text board-bar-ask" onClick={() => act({ type: "describe" })}>
          <Wand2 {...I} />
          <span>Describe a change</span>
        </button>
      </ShortcutTooltip>
      <Btn label="Delete" accel="Backspace" onClick={() => act({ type: "delete" })}><Trash2 {...I} /></Btn>
    </div>
  );
});
