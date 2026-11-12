// How each board element draws. Every element is one absolutely placed node
// in world coordinates, in z order, memoized on its own row so a drag
// re-renders only what moved (and the connectors attached to it).
import { memo, useLayoutEffect, useRef, useState } from "react";
import {
  boardArtFor,
  connectorGeometry,
  elementBox,
  shapeFontSize,
  shapeOutline,
  smoothPath,
  stickyLayout,
  unflatten,
  type Box,
} from "@codecast/shared/artifacts/board";
import { BOARD_ART_URLS } from "./boardArtUrls";
import { formatKey } from "./boardMarks";
import { RichText } from "./BoardRichText";
import { RichEditor } from "./BoardRichEditor";
import { EntityObjectCard } from "../EntityObjectCard";
import { colorToken, stickyFill, tint } from "./boardColors";
import type { BoardEl } from "./boardTypes";

export type EditProps = {
  /** This element's text is being edited in place. */
  editing: boolean;
  onEditInput(text: string): void;
  onEditDone(): void;
  /** Tab while typing in a sticky: a new sticky beside it (1) or below it (-1, with Shift). */
  onEditNext?(dir: 1 | -1): void;
};

type ViewProps = { el: BoardEl } & EditProps;

/**
 * An uncontrolled textarea for in-place editing: React never rewrites its
 * text node, so a keystroke costs one preview write and nothing else.
 */
function InlineEditor({ value, className, style, onInput, onDone, onNext, selectAll, singleLine }: {
  value: string;
  className: string;
  style?: React.CSSProperties;
  onInput(text: string): void;
  onDone(): void;
  onNext?(dir: 1 | -1): void;
  selectAll?: boolean;
  /** A title or label: Enter commits it rather than starting a new line. */
  singleLine?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus({ preventScroll: true });
    if (selectAll) t.select();
    else t.setSelectionRange(t.value.length, t.value.length);
    // Mount-only: focus once when editing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <textarea
      ref={ref}
      defaultValue={value}
      className={`board-edit ${className}`}
      style={style}
      spellCheck={false}
      onInput={(e) => onInput(e.currentTarget.value)}
      onBlur={onDone}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        const t = e.currentTarget;
        const f = formatKey(e, t.value, t.selectionStart, t.selectionEnd);
        if (f) {
          e.preventDefault();
          t.value = f.value;
          t.setSelectionRange(f.start, f.end);
          onInput(f.value);
          return;
        }
        if (e.key === "Tab" && onNext) {
          e.preventDefault();
          onNext(e.shiftKey ? -1 : 1);
          return;
        }
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey || (singleLine && !e.shiftKey)))) {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}

function boxStyle(el: BoardEl, extra?: React.CSSProperties): React.CSSProperties {
  const b = elementBox(el);
  const rot = typeof el.rot === "number" && el.rot ? `rotate(${el.rot}deg)` : undefined;
  return { left: b.x, top: b.y, width: b.w, height: b.h, transform: rot, ...extra };
}

const StickyView = memo(function StickyView({ el, editing, onEditInput, onEditDone, onEditNext }: ViewProps) {
  const b = elementBox(el);
  const icon = typeof el.icon === "string" ? el.icon : "";
  const art = boardArtFor(icon);
  const text = typeof el.text === "string" ? el.text : "";
  const [draft, setDraft] = useState(text);
  const shown = editing ? draft : text;
  const { iconH, size } = stickyLayout(shown, b.w, b.h, icon, !!art);
  return (
    <div data-key={el.key} className="board-el board-sticky" style={boxStyle(el, { background: stickyFill(el.color) })}>
      {art ? (
        <img className="board-sticky-icon" src={BOARD_ART_URLS[art]} alt="" draggable={false} style={{ height: iconH, width: iconH, objectFit: "contain" }} />
      ) : icon ? (
        <div className="board-sticky-icon" style={{ fontSize: iconH * 0.82, height: iconH }} aria-hidden>{icon}</div>
      ) : null}
      {editing ? (
        <RichEditor
          value={text}
          className="board-sticky-text"
          style={{ fontSize: size }}
          onInput={(t) => { setDraft(t); onEditInput(t); }}
          onDone={onEditDone}
          onNext={onEditNext}
        />
      ) : (
        <div className="board-sticky-text" style={{ fontSize: size, ["--fs" as any]: `${size}px` }}>
          <RichText text={shown} titleFirst />
        </div>
      )}
    </div>
  );
});

const TextView = memo(function TextView({ el, editing, onEditInput, onEditDone }: ViewProps) {
  const size = typeof el.size === "number" ? el.size : 20;
  const style: React.CSSProperties = {
    fontSize: size,
    fontWeight: el.weight === "bold" ? 650 : 400,
    color: el.color ? colorToken(el.color) : "var(--sol-text)",
    textAlign: el.align === "center" ? "center" : el.align === "right" ? "right" : "left",
    lineHeight: 1.3,
  };
  const text = typeof el.text === "string" ? el.text : "";
  // Text with no width set is as wide as its longest line in whatever face the theme uses; the box estimate is only a floor.
  const auto = typeof el.w !== "number" ? { width: "max-content", minWidth: elementBox(el).w, whiteSpace: "pre" as const } : {};
  return (
    <div data-key={el.key} className="board-el board-text" style={boxStyle(el, { ...style, ...auto })}>
      {editing ? <RichEditor value={text} className="board-text-edit" style={style} onInput={onEditInput} onDone={onEditDone} /> : text ? <RichText text={text} /> : <span className="board-placeholder">Text</span>}
    </div>
  );
});

/** A shape's illustration (or emoji) before its words. */
function ShapeIcon({ icon, size }: { icon: unknown; size: number }) {
  if (typeof icon !== "string" || !icon) return null;
  const art = boardArtFor(icon);
  if (art) return <img src={BOARD_ART_URLS[art]} alt="" draggable={false} style={{ height: size, width: size, objectFit: "contain", flex: "none" }} />;
  return <span aria-hidden>{icon} </span>;
}

const ShapeView = memo(function ShapeView({ el, editing, onEditInput, onEditDone }: ViewProps) {
  const b = elementBox(el);
  const shape = typeof el.shape === "string" ? el.shape : "rect";
  const outline = shapeOutline(shape, b.w, b.h);
  const color = colorToken(el.color, "blue");
  const solid = el.solid === true;
  const fill = solid ? color : tint(el.color, 16);
  const stroke = solid ? "transparent" : color;
  const text = typeof el.text === "string" ? el.text : "";
  const fontSize = shapeFontSize(shape, b.h);
  const textStyle: React.CSSProperties = { fontSize, color: solid ? "var(--board-on-solid)" : "var(--sol-text)", fontWeight: shape === "pill" ? 650 : 500 };
  return (
    <div data-key={el.key} className="board-el board-shape" style={boxStyle(el)}>
      {outline ? (
        <svg className="board-shape-svg" width={b.w} height={b.h} viewBox={`0 0 ${b.w} ${b.h}`} aria-hidden>
          <path d={outline} fill={fill} stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
        </svg>
      ) : (
        <div className="board-shape-box" style={{ background: fill, border: `1.5px solid ${stroke}`, borderRadius: shape === "pill" ? b.h / 2 : 6 }} />
      )}
      {editing ? (
        <RichEditor value={text} className="board-shape-text" style={textStyle} onInput={onEditInput} onDone={onEditDone} />
      ) : (
        text && <div className="board-shape-text" style={{ ...textStyle, gap: "0.4em" }}><ShapeIcon icon={el.icon} size={fontSize * 1.6} /><div><RichText text={text} /></div></div>
      )}
    </div>
  );
});

const FrameView = memo(function FrameView({ el, editing, onEditInput, onEditDone }: ViewProps) {
  const title = typeof el.title === "string" ? el.title : "";
  return (
    <div data-key={el.key} data-frame className="board-el board-frame" style={boxStyle(el, { background: tint(el.color ?? "gray", 7), borderColor: tint(el.color ?? "gray", 34) })}>
      <div className="board-frame-title" data-part="frame-title" style={{ color: el.color ? colorToken(el.color) : "var(--sol-text-muted)" }}>
        {editing ? <InlineEditor value={title} className="board-frame-title-edit" onInput={onEditInput} onDone={onEditDone} selectAll singleLine /> : title || "Frame"}
      </div>
    </div>
  );
});

const PenView = memo(function PenView({ el }: { el: BoardEl }) {
  const pts = unflatten(el.points);
  const width = typeof el.width === "number" ? el.width : 4;
  const d = smoothPath(pts);
  const x = typeof el.x === "number" ? el.x : 0, y = typeof el.y === "number" ? el.y : 0;
  return (
    <svg data-key={el.key} className="board-el board-svg" style={{ left: x, top: y }} width={1} height={1} aria-hidden>
      <path d={d} className="board-hit" strokeWidth={Math.max(width, 14)} />
      <path d={d} fill="none" stroke={colorToken(el.color, "gray")} strokeOpacity={typeof el.opacity === "number" ? el.opacity : 1} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});

function arrowHead(tip: { x: number; y: number }, angle: number, size: number): string {
  const a1 = angle + Math.PI - 0.45, a2 = angle + Math.PI + 0.45;
  return `${tip.x},${tip.y} ${tip.x + Math.cos(a1) * size},${tip.y + Math.sin(a1) * size} ${tip.x + Math.cos(a2) * size},${tip.y + Math.sin(a2) * size}`;
}

export const ConnectorView = memo(function ConnectorView({ el, from, to, obstacles, editing, onEditInput, onEditDone }: ViewProps & { from?: BoardEl; to?: BoardEl; obstacles?: readonly Box[] }) {
  const g = connectorGeometry(el, (k) => (k === el.from ? from : k === el.to ? to : undefined), el.curve === "elbow" ? obstacles : undefined);
  if (!g) return null;
  const color = colorToken(el.color, "gray");
  const width = typeof el.width === "number" ? el.width : 2;
  const arrow = typeof el.arrow === "string" ? el.arrow : "end";
  const head = 9 + width * 1.5;
  const label = typeof el.label === "string" ? el.label : "";
  return (
    <div data-key={el.key} className="board-el board-connector" style={{ left: 0, top: 0 }}>
      <svg className="board-svg" width={1} height={1} aria-hidden>
        <path d={g.d} className="board-hit" strokeWidth={16} />
        <path d={g.d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={el.dash ? `${width * 3} ${width * 3}` : undefined} />
        {(arrow === "end" || arrow === "both") && <polygon points={arrowHead(g.b, g.angleEnd, head)} fill={color} />}
        {arrow === "both" && <polygon points={arrowHead(g.a, g.angleStart, head)} fill={color} />}
      </svg>
      {(label || editing) && (
        <div className="board-connector-label" style={{ left: g.mid.x, top: g.mid.y }}>
          {editing ? <InlineEditor value={label} className="board-connector-label-edit" onInput={onEditInput} onDone={onEditDone} singleLine /> : label}
        </div>
      )}
    </div>
  );
});

const ImageView = memo(function ImageView({ el }: { el: BoardEl }) {
  const src = typeof el.src === "string" ? el.src : "";
  return (
    <div data-key={el.key} className="board-el board-image" style={boxStyle(el)}>
      {src ? <img src={src} alt={typeof el.alt === "string" ? el.alt : ""} draggable={false} /> : <div className="board-image-pending" />}
    </div>
  );
});

const StampView = memo(function StampView({ el }: { el: BoardEl }) {
  const b = elementBox(el);
  const art = boardArtFor(el.emoji);
  return (
    <div data-key={el.key} className="board-el board-stamp" style={boxStyle(el, { fontSize: b.w * 0.78 })}>
      {art ? <img src={BOARD_ART_URLS[art]} alt={art} draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : typeof el.emoji === "string" ? el.emoji : "👍"}
    </div>
  );
});

/** A live codecast object: the same card a conversation draws for its reference, in its current state. */
const CardView = memo(function CardView({ el, interactive }: { el: BoardEl; interactive?: boolean }) {
  const ref = typeof el.ref === "string" ? el.ref : "";
  return (
    <div data-key={el.key} className={`board-el board-card${interactive ? " is-interactive" : ""}`} style={boxStyle(el)}>
      <div className="board-card-inner">{ref ? <EntityObjectCard refId={ref} count={1} /> : null}</div>
    </div>
  );
});

/** One element, dispatched by kind. Connectors are drawn by ConnectorView with their ends. */
export const BoardElementView = memo(function BoardElementView(props: ViewProps & { interactive?: boolean }) {
  switch (props.el.kind) {
    case "sticky": return <StickyView {...props} />;
    case "text": return <TextView {...props} />;
    case "shape": return <ShapeView {...props} />;
    case "frame": return <FrameView {...props} />;
    case "pen": return <PenView el={props.el} />;
    case "image": return <ImageView el={props.el} />;
    case "stamp": return <StampView el={props.el} />;
    case "card": return <CardView el={props.el} interactive={props.interactive} />;
    default: return null;
  }
});
