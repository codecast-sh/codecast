// The bottom toolbar: the frame's tool set (select, hand, text, frame,
// sticky, pen, shape, stamp, comment), a codecast object tool, and Ask
// agent. Each tool shows its single-key shortcut as a KeyCap on hover.
import { memo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Hand,
  Hash,
  Image as ImageIcon,
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
import { colorToken } from "./boardColors";
import { BoardArtPicker } from "./BoardArtPicker";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { SHAPE_CHOICES } from "./boardShapeChoices";
import { BOARD_ART_URLS } from "./boardArtUrls";
import { boardArtFor } from "@codecast/shared/artifacts/board";
import type { BoardTool } from "./boardTypes";

const SHAPES = SHAPE_CHOICES;

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
  /** Images chosen from the Image button, to place at the middle of the view. */
  onImages(files: File[]): void;
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

/** The armed sticker on its tool button: a painted illustration or an emoji. */
function StampFace({ stamp }: { stamp: string }) {
  const art = boardArtFor(stamp);
  if (art) return <img src={BOARD_ART_URLS[art]} alt="" draggable={false} style={{ width: 20, height: 20, objectFit: "contain" }} />;
  return <span className="board-tool-emoji">{stamp}</span>;
}

export const BoardToolbar = memo(function BoardToolbar(p: Props) {
  const [open, setOpen] = useState<"shape" | "stamp" | "pen" | "more" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Arming the sticker tool from the keyboard (E) opens its picker too: a sticker is chosen, then placed.
  useWatchEffect(() => { if (p.tool === "stamp") setOpen("stamp"); }, [p.tool]);
  const pick = (t: BoardTool, menu?: "shape" | "stamp" | "pen") => {
    p.setTool(t);
    setOpen(menu && p.tool === t ? (open === menu ? null : menu) : null);
  };
  const ShapeIcon = SHAPES.find((s) => s.id === p.shapeKind)?.icon ?? Square;
  if (p.readOnly) return null;
  return (
    <div className="board-toolbar" data-board-ui role="toolbar" aria-label="Board tools">
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const files = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ""; if (files.length) p.onImages(files); }} />
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
      <ToolButton active={p.tool === "stamp"} label="Sticker" accel="E" onClick={() => { p.setTool("stamp"); setOpen("stamp"); }}>
        {p.tool === "stamp" ? <StampFace stamp={p.stamp} /> : <Smile size={17} strokeWidth={1.75} />}
      </ToolButton>
      <ToolButton active={p.tool === "comment"} label="Comment" accel="C" onClick={() => pick("comment")}><MessageCircle size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "card"} label="Codecast object" accel="O" onClick={() => pick("card")}><Layers size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={false} label="Image" onClick={() => { setOpen(null); fileRef.current?.click(); }}><ImageIcon size={17} strokeWidth={1.75} /></ToolButton>
      <ShortcutTooltip label={p.locked ? "Unlock tool" : "Keep tool on after each use"} accel="Q" side="top">
        <button type="button" className={`board-tool${p.locked ? " is-active" : ""}`} aria-label="Lock tool" aria-pressed={p.locked} onClick={() => p.setLocked(!p.locked)}>
          {p.locked ? <Lock size={15} strokeWidth={1.75} /> : <LockOpen size={15} strokeWidth={1.75} />}
        </button>
      </ShortcutTooltip>
        </div>
      )}
      {open === "stamp" && (
        <div className="board-tool-menu board-stamp-menu">
          <BoardArtPicker value={p.stamp} onPick={(s) => { p.setStamp(s); p.setTool("stamp"); setOpen(null); }} onClose={() => { setOpen(null); p.setTool("select"); }} />
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
      <ToolButton active={p.tool === "stamp"} label="Sticker" accel="E" onClick={() => { p.setTool("stamp"); setOpen(open === "stamp" ? null : "stamp"); }}>
        {p.tool === "stamp" ? <StampFace stamp={p.stamp} /> : <Smile size={17} strokeWidth={1.75} />}
      </ToolButton>
      <ToolButton active={p.tool === "comment"} label="Comment" accel="C" onClick={() => pick("comment")}><MessageCircle size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={p.tool === "card"} label="Codecast object" accel="O" onClick={() => pick("card")}><Layers size={17} strokeWidth={1.75} /></ToolButton>
      <ToolButton active={false} label="Image" onClick={() => { setOpen(null); fileRef.current?.click(); }}><ImageIcon size={17} strokeWidth={1.75} /></ToolButton>
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
