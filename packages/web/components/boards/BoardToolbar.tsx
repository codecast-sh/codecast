// The bottom toolbar: the frame's tool set (select, hand, text, frame,
// sticky, pen, shape, stamp, comment), a codecast object tool, and Ask
// agent. Each tool shows its single-key shortcut as a KeyCap on hover.
import { memo, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Diamond,
  Hand,
  Hash,
  Layers,
  MoreHorizontal,
  Lock,
  LockOpen,
  MessageCircle,
  MousePointer2,
  Pencil,
  Smile,
  Square,
  StickyNote,
  Type,
} from "lucide-react";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { colorToken, STAMPS } from "./boardColors";
import type { BoardTool } from "./boardTypes";

const SHAPES = [
  { id: "rect", icon: Square, label: "Rectangle" },
  { id: "ellipse", icon: Circle, label: "Ellipse" },
  { id: "diamond", icon: Diamond, label: "Diamond" },
] as const;

const PEN_COLORS = ["gray", "blue", "red", "green", "orange", "violet"] as const;

type Props = {
  tool: BoardTool;
  setTool(t: BoardTool): void;
  shapeKind: string;
  setShapeKind(s: string): void;
  stamp: string;
  setStamp(s: string): void;
  penColor: string;
  setPenColor(c: string): void;
  askSlot?: React.ReactNode;
  /** A narrow pane: the less used tools fold into a More menu so the bar fits. */
  compact: boolean;
  /** The tool stays on after each placement instead of returning to Select. */
  locked: boolean;
  setLocked(on: boolean): void;
  readOnly: boolean;
};

function ToolButton({ active, label, accel, onClick, children }: { active: boolean; label: string; accel?: string; onClick(): void; children: React.ReactNode }) {
  return (
    <ShortcutTooltip label={label} accel={accel} side="top">
      <button type="button" className={`board-tool${active ? " is-active" : ""}`} aria-label={label} aria-pressed={active} onClick={onClick}>
        {children}
      </button>
    </ShortcutTooltip>
  );
}

export const BoardToolbar = memo(function BoardToolbar(p: Props) {
  const [open, setOpen] = useState<"shape" | "stamp" | "pen" | "more" | null>(null);
  const pick = (t: BoardTool, menu?: "shape" | "stamp" | "pen") => {
    p.setTool(t);
    setOpen(menu && p.tool === t ? (open === menu ? null : menu) : null);
  };
  const ShapeIcon = SHAPES.find((s) => s.id === p.shapeKind)?.icon ?? Square;
  if (p.readOnly) return null;
  return (
    <div className="board-toolbar" data-board-ui role="toolbar" aria-label="Board tools">
      {open === "shape" && (
        <div className="board-tool-menu">
          {SHAPES.map((s) => (
            <button key={s.id} type="button" className={`board-tool${p.tool === "shape" && p.shapeKind === s.id ? " is-active" : ""}`} aria-label={s.label} onClick={() => { p.setShapeKind(s.id); p.setTool("shape"); setOpen(null); }}>
              <s.icon size={17} strokeWidth={1.75} />
            </button>
          ))}
        </div>
      )}
      {open === "more" && (
        <div className="board-tool-menu">
      <ToolButton active={p.tool === "frame"} label="Frame" accel="F" onClick={() => pick("frame")}><Hash size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "pen"} label="Pen" accel="P" onClick={() => pick("pen", "pen")}>
        <Pencil size={17} strokeWidth={1.75} />
        <span className="board-tool-dot" style={{ background: colorToken(p.penColor) }} />
      </ToolButton>
      <ToolButton active={p.tool === "stamp"} label="Stamp" accel="E" onClick={() => { p.setTool("stamp"); setOpen("stamp"); }}>
        {p.tool === "stamp" ? <span className="board-tool-emoji">{p.stamp}</span> : <Smile size={17} strokeWidth={1.75} />}
      </ToolButton>
      <ToolButton active={p.tool === "comment"} label="Comment" accel="C" onClick={() => pick("comment")}><MessageCircle size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "card"} label="Codecast object" accel="O" onClick={() => pick("card")}><Layers size={17} strokeWidth={1.75} /></ToolButton>
      <ShortcutTooltip label={p.locked ? "Unlock tool" : "Keep tool on after each use"} accel="Q" side="top">
        <button type="button" className={`board-tool${p.locked ? " is-active" : ""}`} aria-label="Lock tool" aria-pressed={p.locked} onClick={() => p.setLocked(!p.locked)}>
          {p.locked ? <Lock size={15} strokeWidth={1.75} /> : <LockOpen size={15} strokeWidth={1.75} />}
        </button>
      </ShortcutTooltip>
        </div>
      )}
      {open === "stamp" && (
        <div className="board-tool-menu board-stamp-menu">
          {STAMPS.map((s) => (
            <button key={s} type="button" className={`board-stamp-pick${p.stamp === s ? " is-active" : ""}`} onClick={() => { p.setStamp(s); p.setTool("stamp"); setOpen(null); }}>{s}</button>
          ))}
        </div>
      )}
      {open === "pen" && (
        <div className="board-tool-menu">
          {PEN_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} className={`board-swatch${p.penColor === c ? " is-active" : ""}`} style={{ ["--sw" as any]: colorToken(c) }} onClick={() => { p.setPenColor(c); setOpen(null); }} />
          ))}
        </div>
      )}
            <ToolButton active={p.tool === "select"} label="Select" accel="V" onClick={() => pick("select")}><MousePointer2 size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "hand"} label="Hand" accel="H" onClick={() => pick("hand")}><Hand size={17} strokeWidth={1.75} /></ToolButton>
      <span className="board-toolbar-sep" />
      <ToolButton active={p.tool === "text"} label="Text" accel="T" onClick={() => pick("text")}><Type size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "sticky"} label="Sticky" accel="S" onClick={() => pick("sticky")}><StickyNote size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "shape"} label="Shape" accel="R" onClick={() => { p.setTool("shape"); setOpen(open === "shape" ? null : "shape"); }}>
        <ShapeIcon size={17} strokeWidth={1.75} />
      </ToolButton>
      <ToolButton active={p.tool === "connector"} label="Arrow" accel="L" onClick={() => pick("connector")}><ArrowUpRight size={17} strokeWidth={1.75} /></ToolButton>
      {p.compact ? (
        <ToolButton active={open === "more" || ["frame", "pen", "stamp", "comment", "card"].includes(p.tool)} label="More tools" onClick={() => setOpen(open === "more" ? null : "more")}>
          <MoreHorizontal size={17} strokeWidth={1.75} />
        </ToolButton>
      ) : (
        <>
      <ToolButton active={p.tool === "frame"} label="Frame" accel="F" onClick={() => pick("frame")}><Hash size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "pen"} label="Pen" accel="P" onClick={() => pick("pen", "pen")}>
        <Pencil size={17} strokeWidth={1.75} />
        <span className="board-tool-dot" style={{ background: colorToken(p.penColor) }} />
      </ToolButton>
      <ToolButton active={p.tool === "stamp"} label="Stamp" accel="E" onClick={() => { p.setTool("stamp"); setOpen(open === "stamp" ? null : "stamp"); }}>
        {p.tool === "stamp" ? <span className="board-tool-emoji">{p.stamp}</span> : <Smile size={17} strokeWidth={1.75} />}
      </ToolButton>
      <ToolButton active={p.tool === "comment"} label="Comment" accel="C" onClick={() => pick("comment")}><MessageCircle size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "card"} label="Codecast object" accel="O" onClick={() => pick("card")}><Layers size={17} strokeWidth={1.75} /></ToolButton>
          <span className="board-toolbar-sep" />
      <ShortcutTooltip label={p.locked ? "Unlock tool" : "Keep tool on after each use"} accel="Q" side="top">
        <button type="button" className={`board-tool${p.locked ? " is-active" : ""}`} aria-label="Lock tool" aria-pressed={p.locked} onClick={() => p.setLocked(!p.locked)}>
          {p.locked ? <Lock size={15} strokeWidth={1.75} /> : <LockOpen size={15} strokeWidth={1.75} />}
        </button>
      </ShortcutTooltip>
        </>
      )}
      {p.askSlot && <span className="board-toolbar-sep" />}
      {p.askSlot}
    </div>
  );
});
