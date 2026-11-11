// Boards (ct-91884): an infinite canvas people and their agent sessions think
// a plan through on together. The live-artifact shell (LiveArtifactPage)
// draws the title, facepile, share, history and every cursor; this view owns
// the canvas: camera, elements, gestures, keyboard, toolbar, the selection
// bar, comment pins and the Ask agent bubble.
import { AskButton, useAskDraft } from "../live/AskAgentControl";
import "./board.css";
import { useCallback, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { Minus, Plus, Scan } from "lucide-react";
import type { ArtifactPosition } from "@codecast/shared/artifacts";
import {
  alignBoxes,
  bottomZ,
  cloneOps,
  connectorGeometry,
  distributeBoxes,
  elementBounds,
  elementBox,
  intersects,
  nextZ,
  unionBox,
  type Box,
  type Pt,
} from "@codecast/shared/artifacts/board";
import { newElementKey } from "@codecast/shared/artifacts";
import { useLiveComments, useLiveElements, useLivePresence } from "../live/useLiveArtifact";
import type { LiveViewProps } from "../live/registry";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { KeyCap } from "../KeyCap";
import { BoardElementView, ConnectorView, editField } from "./BoardElements";
import { BoardOverlay, type RemoteSelection } from "./BoardOverlay";
import { BoardToolbar } from "./BoardToolbar";
import { BoardSelectionBar, type BarAction } from "./BoardSelectionBar";
import { BOARD_ASK_SLOT, BoardPrompt, type PromptMode } from "./BoardPrompt";
import { CommentPins, CommentThreadPopover, initialsOf, pinPoint, useThreads } from "./BoardComments";
import { useBoardCamera } from "./useBoardCamera";
import { useBoardGestures, withFrameContents } from "./useBoardGestures";
import { useBoardKeys } from "./useBoardKeys";
import { pasteOps, placeImage, serializeSelection, stickiesToTasks } from "./boardActions";
import type { BoardEl, BoardTool } from "./boardTypes";
import { drawOrder, fitBox } from "./boardFrame";

const NOOP = () => {};
const NOOP_EDIT = { editing: false, onEditInput: NOOP, onEditDone: NOOP };

type PromptState = { mode: PromptMode; at: Pt; world?: Pt; anchor?: string | null };

export default function BoardView({ doc, live, selection, setSelection, mode, snapshot, toScreen }: LiveViewProps) {
  const readOnly = mode === "view";
  const liveEls = useLiveElements(doc._id);
  const elements = (snapshot ?? liveEls) as BoardEl[];
  const comments = useLiveComments(doc._id);
  const threads = useThreads(comments);
  const others = useLivePresence(doc._id);
  const me = useInboxStore((s: any) => s.currentUser);
  const convex = useConvex();
  const cam = useBoardCamera(doc._id);

  const byKey = useMemo(() => new Map(elements.map((e) => [e.key, e])), [elements]);
  // Gestures add the elements they create here until the next render brings them from the store.
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;
  const ordered = useMemo(() => drawOrder(elements), [elements]);

  const [tool, setToolState] = useState<BoardTool>("select");
  const [shapeKind, setShapeKind] = useState("rect");
  const [stamp, setStamp] = useState("👍");
  const [penColor, setPenColor] = useState("gray");
  const [editing, setEditing] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const [pressing, setPressing] = useState(false);
  const spaceHeld = useRef(false);
  const lastPointer = useRef<Pt | null>(null);
  const copiedFrom = useRef<Pt | null>(null);

  const setTool = useCallback((t: BoardTool) => {
    setToolState(t);
    if (t !== "select") setEditing(null);
  }, []);

  // ── Camera: first paint fits the content; cursors follow every frame ──────
  // Until the person moves the camera, the opening frame (a fit, or the camera
  // this tab left the board at) follows the pane: a resize (a side panel
  // opening, the window narrowing) frames the content again.
  const fitted = useRef(cam.hadSaved.current);
  const autoCam = useRef<{ x: number; y: number; z: number } | null>(null);
  useWatchEffect(() => {
    if (!cam.viewport.w) return;
    if (!live.ready && elements.length === 0) return;
    // A camera saved in a pane of another size (a narrow split, a smaller window) would open off frame.
    const was = cam.savedFor.current;
    if (was) {
      cam.savedFor.current = null;
      if (Math.abs(was.w - cam.viewport.w) > was.w * 0.1 || Math.abs(was.h - cam.viewport.h) > was.h * 0.1) fitted.current = false;
      else {
        // Kept as the opening frame: it stays, and follows the pane until the person moves it.
        autoCam.current = { ...cam.cam.current };
        return;
      }
    }
    const c = cam.cam.current;
    const untouched = autoCam.current && c.x === autoCam.current.x && c.y === autoCam.current.y && c.z === autoCam.current.z;
    if (fitted.current && !untouched) return;
    fitted.current = true;
    cam.fit(fitBox(elements, byKey), { instant: true });
    autoCam.current = { ...cam.cam.current };
  }, [cam.viewport.w, cam.viewport.h, live.ready, elements.length]);

  const screenOf = useCallback((pos: ArtifactPosition & { key?: string }) => {
    const root = cam.rootRef.current;
    if (!root) return null;
    const W = root.clientWidth, H = root.clientHeight;
    const inView = (p: Pt) => p.x >= -40 && p.y >= -40 && p.x <= W + 40 && p.y <= H + 40;
    if (pos.point) {
      const p = cam.toScreen(pos.point);
      return inView(p) ? p : null;
    }
    const key = pos.key ?? pos.block;
    const el = key ? byKeyRef.current.get(key) : undefined;
    if (!el) return null;
    const b = el.kind === "connector" ? connectorGeometry(el, (k) => byKeyRef.current.get(k))?.box : elementBox(el);
    if (!b) return null;
    const p = cam.toScreen({ x: b.x + b.w, y: b.y + b.h });
    return inView(p) ? p : null;
  }, [cam]);
  useMountEffect(() => {
    toScreen(screenOf as any);
    return cam.onCamera(() => toScreen(screenOf as any));
  });

  // ── Presence: my pointer and selection, everyone else's selection ─────────
  useWatchEffect(() => {
    live.setPresence({ position: lastPointer.current ? { point: lastPointer.current } : undefined, selection });
  }, [selection.join(",")]);
  const remote = useMemo<RemoteSelection[]>(() => others
    .filter((p) => p.selection?.length)
    .map((p) => ({ actor: p.actor, name: p.kind === "agent" ? `✳ ${p.name}` : p.name, color: p.color, keys: p.selection!, agent: p.kind === "agent" })), [others]);

  // ── Edit in place ──────────────────────────────────────────────────────────
  const startEdit = useCallback((key: string) => {
    const el = byKeyRef.current.get(key);
    if (readOnly || !el || !editField(el)) return;
    setEditing(key);
  }, [readOnly]);
  const editHandlers = useMemo(() => {
    if (!editing) return NOOP_EDIT;
    return {
      editing: true,
      onEditInput: (text: string) => {
        const el = byKeyRef.current.get(editing);
        const field = el && editField(el);
        if (field) live.preview([{ k: editing, set: { [field]: text, ...(el!.kind === "text" ? { h: null } : {}) } }]);
      },
      onEditDone: () => {
        live.commit();
        const el = byKeyRef.current.get(editing);
        // An empty text box is nothing: it goes away instead of leaving an invisible element.
        if (el?.kind === "text" && !String(el.text ?? "").trim()) live.apply([{ k: editing, del: true }], { undoable: false });
        setEditing(null);
      },
    };
  }, [editing, live]);

  // ── Prompts ────────────────────────────────────────────────────────────────
  const openAsk = useCallback((m: PromptMode) => {
    const root = cam.rootRef.current;
    if (!root) return;
    const box = unionBox(selection.map((k) => byKeyRef.current.get(k)).filter(Boolean).map((e) => elementBox(e!)));
    if (m === "describe" && box) {
      const p = cam.toScreen({ x: box.x + box.w / 2, y: box.y + box.h });
      setPrompt({ mode: m, at: { x: Math.min(Math.max(p.x, 200), root.clientWidth - 200), y: Math.min(p.y + 16, root.clientHeight - 140) } });
    } else setPrompt({ mode: "ask", at: { x: root.clientWidth / 2, y: root.clientHeight - 84 } });
  }, [cam, selection]);
  // A cancelled agent start opens the prompt again with the words in it.
  useAskDraft(doc._id, BOARD_ASK_SLOT, () => openAsk(selection.length ? "describe" : "ask"));
  const onComment = useCallback((world: Pt, anchor: string | null) => {
    const p = cam.toScreen(world);
    const root = cam.rootRef.current;
    // The composer is ~430px wide: keep it inside the canvas however narrow the pane.
    const at = root ? { x: Math.max(12, Math.min(p.x, root.clientWidth - 440)), y: Math.max(48, Math.min(p.y, root.clientHeight - 200)) } : p;
    setPrompt({ mode: "comment", at, world, anchor });
    setTool("select");
  }, [cam, setTool]);
  const onCardTool = useCallback((world: Pt) => {
    setTool("select");
    (useInboxStore.getState() as any).openPalette({
      pick: {
        title: "Put on the board",
        kinds: ["task", "plan", "session", "doc"],
        onPick: (t: any) => {
          const s = useInboxStore.getState() as any;
          const ref = t.kind === "task" ? s.tasks?.[t.id]?.short_id ?? t.id
            : t.kind === "plan" ? s.plans?.[t.id]?.short_id ?? t.id
            : t.kind === "doc" ? `doc:${t.id}` : t.id;
          const k = newElementKey("el");
          live.apply([{ k, put: { kind: "card", ref, x: Math.round(world.x - 160), y: Math.round(world.y - 84), w: 320, h: 168, z: nextZ({ elements: [...byKeyRef.current.values()] }) } }]);
          setSelection([k]);
        },
      },
    });
  }, [live, setSelection, setTool]);

  const gestures = useBoardGestures({
    cam, live, byKey: byKeyRef, selection, setSelection, tool, setTool, shapeKind, stamp, penColor, spaceHeld, startEdit, onComment, onCardTool, readOnly,
  });

  // ── Commands (keyboard and the selection bar share them) ───────────────────
  const selectedEls = useMemo(() => selection.map((k) => byKey.get(k)).filter(Boolean) as BoardEl[], [selection, byKey]);
  const allEls = () => [...byKeyRef.current.values()];
  const withAttached = (keys: string[]) => {
    // Deleting an element takes the connectors attached to it.
    const set = new Set(keys);
    for (const e of byKeyRef.current.values()) if (e.kind === "connector" && (set.has(String(e.from)) || set.has(String(e.to)))) set.add(e.key);
    return [...set];
  };
  const deleteSelection = () => {
    if (!selection.length) return;
    live.apply(withAttached(selection).map((k) => ({ k, del: true as const })));
    setSelection([]);
  };
  const copy = (cut: boolean) => {
    if (!selectedEls.length) return;
    // A frame copies (and cuts) with what is inside it, and arrows between copied things come along.
    const keys = withFrameContents(selection, byKeyRef.current);
    const text = serializeSelection(keys.map((k) => byKeyRef.current.get(k)!).filter(Boolean));
    copiedFrom.current = lastPointer.current;
    // A cut deletes only once the copy is safely on the clipboard.
    navigator.clipboard?.writeText(text).then(
      () => { if (cut) { live.apply(withAttached(keys).map((k) => ({ k, del: true as const }))); setSelection([]); } },
      () => toast.error(cut ? "Could not cut: clipboard access was refused" : "Could not copy: clipboard access was refused"),
    );
  };
  const duplicate = () => {
    if (!selectedEls.length) return;
    const els = withFrameContents(selection, byKeyRef.current).map((k) => byKeyRef.current.get(k)!).filter(Boolean);
    const { ops, map } = cloneOps(els, 24, 24, nextZ({ elements: allEls() }), (k) => byKeyRef.current.has(k));
    live.apply(ops);
    setSelection(selection.map((k) => map.get(k)).filter((k): k is string => !!k));
  };
  const viewCenter = (): Pt => {
    const r = cam.rootRef.current;
    return cam.toWorld({ x: (r?.clientWidth ?? 0) / 2, y: (r?.clientHeight ?? 0) / 2 });
  };
  const runBar = (a: BarAction) => {
    const boxes = new Map(selectedEls.filter((e) => e.kind !== "connector").map((e) => [e.key, elementBox(e)]));
    switch (a.type) {
      case "set":
        live.apply(selectedEls.filter((e) => !a.kinds || a.kinds.includes(e.kind)).filter((e) => {
          if ("color" in a.fields) return ["sticky", "shape", "frame", "text", "connector", "pen"].includes(e.kind);
          return true;
        }).map((e) => ({ k: e.key, set: a.fields })));
        return;
      case "align":
        live.apply([...alignBoxes(boxes, a.mode)].map(([k, p]) => ({ k, set: { x: p.x, y: p.y } })));
        return;
      case "distribute":
        live.apply([...distributeBoxes(boxes, a.axis)].map(([k, p]) => ({ k, set: { x: p.x, y: p.y } })));
        return;
      case "group": {
        const g = newElementKey("g");
        live.apply(selection.map((k) => ({ k, set: { group: g } })));
        return;
      }
      case "ungroup":
        live.apply(selection.map((k) => ({ k, set: { group: null } })));
        return;
      case "order": {
        let z = a.where === "front" ? nextZ({ elements: allEls() }) : bottomZ({ elements: allEls() }) - selection.length;
        const sorted = [...selectedEls].sort((x, y) => (Number(x.z) || 0) - (Number(y.z) || 0));
        live.apply(sorted.map((e) => ({ k: e.key, set: { z: z++ } })));
        return;
      }
      case "tasks":
      case "plan": {
        const stickies = selectedEls.filter((e) => e.kind === "sticky");
        const frame = selectedEls.find((e) => e.kind === "frame");
        const title = a.type === "plan" ? String(frame?.title || stickies[0]?.text?.toString().split("\n")[0] || doc.title) : undefined;
        void stickiesToTasks(live, stickies, allEls(), title, (k) => byKeyRef.current.get(k));
        return;
      }
      case "describe":
        openAsk("describe");
        return;
      case "open": {
        const node = cam.rootRef.current?.querySelector(`[data-key="${CSS.escape(selection[0])}"] a[href]`) as HTMLAnchorElement | null;
        node?.click();
        return;
      }
      case "delete":
        deleteSelection();
    }
  };
  const fitTo = (selectionOnly: boolean) => {
    const els = selectionOnly && selectedEls.length ? selectedEls : elements;
    cam.fit(fitBox(els, byKey), { maxZ: selectionOnly ? 2 : 1 });
  };

  const keysActive = useBoardKeys({
    setTool,
    deleteSelection,
    undo: () => live.undo(),
    redo: () => live.redo(),
    copy,
    duplicate,
    selectAll: () => setSelection(elements.map((e) => e.key)),
    clearSelection: () => {
      if (prompt) { setPrompt(null); return true; }
      if (thread) { setThread(null); return true; }
      if (!selection.length) return false;
      setSelection([]);
      return true;
    },
    group: (off) => runBar({ type: off ? "ungroup" : "group" }),
    order: (where) => runBar({ type: "order", where }),
    nudge: (dx, dy) => live.apply(withFrameContents(selection, byKeyRef.current).map((k) => byKeyRef.current.get(k)!).filter(Boolean).flatMap((e) => {
      if (e.kind !== "connector") return [{ k: e.key, set: { x: (Number(e.x) || 0) + dx, y: (Number(e.y) || 0) + dy } }];
      const set: Record<string, number> = {};
      if (typeof e.from !== "string" && typeof e.x1 === "number") { set.x1 = e.x1 + dx; set.y1 = (Number(e.y1) || 0) + dy; }
      if (typeof e.to !== "string" && typeof e.x2 === "number") { set.x2 = e.x2 + dx; set.y2 = (Number(e.y2) || 0) + dy; }
      return Object.keys(set).length ? [{ k: e.key, set }] : [];
    })),
    zoomBy: (f) => cam.zoomBy(f),
    zoomTo: (z) => cam.zoomBy(z / cam.cam.current.z),
    fit: fitTo,
    editSelection: () => { if (selection.length === 1) startEdit(selection[0]); },
    ask: () => openAsk(selection.length ? "describe" : "ask"),
    readOnly,
  }, spaceHeld, cam.rootRef);

  // ── Paste and drop ─────────────────────────────────────────────────────────
  useMountEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!cam.rootRef.current?.isConnected || readOnlyRef.current || !keysActive.current) return;
      const at = lastPointer.current ?? viewCenterRef.current();
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        void placeImage(liveRef.current, convex as any, file, at, [...byKeyRef.current.values()]);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      e.preventDefault();
      const { ops, keys } = pasteOps(text, at, [...byKeyRef.current.values()], (k) => byKeyRef.current.has(k), copiedFrom.current && lastPointer.current && copiedFrom.current === lastPointer.current ? copiedFrom.current : null);
      if (ops.length) { liveRef.current.apply(ops); setSelectionRef.current(keys); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });
  const liveRef = useRef(live); liveRef.current = live;
  const readOnlyRef = useRef(readOnly); readOnlyRef.current = readOnly;
  const setSelectionRef = useRef(setSelection); setSelectionRef.current = setSelection;
  const viewCenterRef = useRef(viewCenter); viewCenterRef.current = viewCenter;

  const onDrop = (e: React.DragEvent) => {
    if (readOnly) return;
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    const at = cam.clientToWorld(e.clientX, e.clientY);
    files.forEach((f, i) => void placeImage(live, convex as any, f, { x: at.x + i * 40, y: at.y + i * 40 }, allEls()));
  };

  // ── Culling ────────────────────────────────────────────────────────────────
  const { world, cam: vcam } = cam.viewport;
  const visible = useMemo(() => {
    if (!world.w) return ordered;
    const pad: Box = { x: world.x - world.w * 0.5, y: world.y - world.h * 0.5, w: world.w * 2, h: world.h * 2 };
    const keep = new Set(selection);
    return ordered.filter((el) => {
      if (keep.has(el.key) || el.key === editing) return true;
      if (el.kind === "connector") {
        const g = connectorGeometry(el, (k) => byKey.get(k));
        return !!g && intersects(g.box, pad);
      }
      return intersects(elementBounds(el), pad);
    });
  }, [ordered, world.x, world.y, world.w, world.h, byKey, selection, editing]);

  // ── Selection bar placement (screen space, above the selection) ───────────
  const selBox = useMemo(() => {
    // A connector's bar clears the elements it joins, so it never sits on them.
    const boxes = selectedEls.flatMap((e) => {
      if (e.kind !== "connector") return [elementBounds(e)];
      const ends = [e.from, e.to].map((k) => (typeof k === "string" ? byKey.get(k) : undefined)).filter(Boolean).map((x) => elementBounds(x!));
      const g = connectorGeometry(e, (k) => byKey.get(k));
      return [...ends, ...(g ? [g.box] : [])];
    });
    return unionBox(boxes);
  }, [selectedEls, byKey]);
  const barAt = useMemo(() => {
    if (!selBox || !cam.viewport.w) return null;
    const top = selBox.y * vcam.z + vcam.y, bottom = (selBox.y + selBox.h) * vcam.z + vcam.y;
    const x = (selBox.x + selBox.w / 2) * vcam.z + vcam.x;
    const below = top < 90;
    // 34px clears the rotate handle that sits above the selection's top-right corner.
    return { x, y: below ? Math.min(bottom + 34, cam.viewport.h - 120) : top - 34, below };
  }, [selBox, vcam, cam.viewport.w, cam.viewport.h]);

  const openThread = threads.find((t) => t.root.key === thread);
  const threadAt = openThread ? (() => { const p = pinPoint(openThread.root, byKey); return p ? cam.toScreen(p) : null; })() : null;
  const zoomPct = Math.round(vcam.z * 100);
  const empty = live.ready && elements.length === 0 && !snapshot && !prompt;
  const docRef = useMemo(() => ({ _id: doc._id, title: doc.title, doc_type: doc.doc_type, project_path: doc.project_path, git_root: doc.git_root }), [doc._id, doc.title, doc.doc_type, doc.project_path, doc.git_root]);

  return (
    <div
      ref={cam.rootRef}
      className={`board-root board-tool-${tool}${readOnly ? " is-readonly" : ""}`}
      data-board
      tabIndex={-1}
      onPointerDown={(e) => {
        if (!(e.target as HTMLElement).closest("[data-board-ui]")) {
          setPressing(true);
          if (prompt && prompt.mode !== "comment") setPrompt(null);
          if (thread) setThread(null);
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
        gestures.onPointerDown(e);
      }}
      onPointerMove={(e) => {
        const p = cam.clientToWorld(e.clientX, e.clientY);
        lastPointer.current = p;
        live.setPresence({ position: { point: { x: Math.round(p.x), y: Math.round(p.y) } }, selection });
        gestures.onPointerMove(e);
      }}
      onPointerUp={(e) => { setPressing(false); gestures.onPointerUp(e); }}
      onPointerCancel={(e) => { setPressing(false); gestures.onPointerUp(e); }}
      onLostPointerCapture={() => setPressing(false)}
      onPointerLeave={() => { lastPointer.current = null; }}
      onDoubleClick={gestures.onDoubleClick}
      onDragOver={(e) => { if (!readOnly && [...e.dataTransfer.items].some((i) => i.kind === "file")) e.preventDefault(); }}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="board-grid" aria-hidden />
      <div ref={cam.worldRef} className="board-world">
        {visible.map((el) =>
          el.kind === "connector" ? (
            <ConnectorView
              key={el.key}
              el={el}
              from={typeof el.from === "string" ? byKey.get(el.from) : undefined}
              to={typeof el.to === "string" ? byKey.get(el.to) : undefined}
              {...(editing === el.key ? editHandlers : NOOP_EDIT)}
            />
          ) : (
            <BoardElementView key={el.key} el={el} interactive={el.kind === "card" && selection.length === 1 && selection[0] === el.key} {...(editing === el.key ? editHandlers : NOOP_EDIT)} />
          ),
        )}
        <BoardOverlay
          selection={selection}
          byKey={byKey}
          gesture={gestures.overlay}
          remote={remote}
          editing={editing}
          readOnly={readOnly}
          showHandles={!pressing}
        />
        <CommentPins threads={threads} byKey={byKey} open={thread} onOpen={(k) => setThread(thread === k ? null : k)} />
      </div>

      {empty && (
        <div className="board-empty" data-board-ui>
          <button type="button" className="board-empty-btn" title="Or paste a list: a sticky per line" onClick={() => setTool("sticky")}>
            <span>Sticky</span><KeyCap>S</KeyCap>
          </button>
        </div>
      )}

      <div className="board-zoom" data-board-ui>
        <ShortcutTooltip label="Zoom out" accel="CmdOrCtrl+-" side="bottom">
          <button type="button" className="board-bar-btn" aria-label="Zoom out" onClick={() => cam.zoomBy(0.8)}><Minus size={14} strokeWidth={1.75} /></button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Zoom to 100%" accel="CmdOrCtrl+0" side="bottom">
          <button type="button" className="board-zoom-pct" onClick={() => cam.zoomBy(1 / cam.cam.current.z)}>{zoomPct}%</button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Zoom in" accel="CmdOrCtrl+=" side="bottom">
          <button type="button" className="board-bar-btn" aria-label="Zoom in" onClick={() => cam.zoomBy(1.25)}><Plus size={14} strokeWidth={1.75} /></button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Fit everything" accel="Shift+1" side="bottom">
          <button type="button" className="board-bar-btn" aria-label="Fit everything" onClick={() => fitTo(false)}><Scan size={14} strokeWidth={1.75} /></button>
        </ShortcutTooltip>
      </div>

      {!readOnly && barAt && !pressing && !editing && !prompt && selectedEls.length > 0 && (
        <BoardSelectionBar selected={selectedEls} at={barAt} paneWidth={cam.viewport.w} canMakeTasks={!live.draft.active} onAction={runBar} />
      )}

      {prompt && (
        <BoardPrompt
          key={`${prompt.mode}:${prompt.at.x}:${prompt.at.y}`}
          mode={prompt.mode}
          at={prompt.at}
          doc={docRef}
          selected={prompt.mode === "describe" ? selectedEls : prompt.anchor ? [byKey.get(prompt.anchor)!].filter(Boolean) : selectedEls}
          initials={initialsOf(String(me?.name ?? "You"))}
          onComment={(text) => live.comment({ text, ...(prompt.anchor ? { anchor: prompt.anchor } : prompt.world ? { point: { x: Math.round(prompt.world.x), y: Math.round(prompt.world.y) } } : {}) })}
          onClose={() => setPrompt(null)}
          onSent={(sessionId, commentKey) => {
            if (sessionId && commentKey) live.apply([{ k: commentKey, set: { sent_to: sessionId } }], { layer: "comments", undoable: false });
          }}
        />
      )}

      {openThread && threadAt && (
        <CommentThreadPopover
          thread={openThread}
          at={{ x: Math.max(8, Math.min(threadAt.x + 22, cam.viewport.w - 310)), y: Math.max(8, Math.min(threadAt.y - 8, cam.viewport.h - 340)) }}
          onReply={(text) => live.comment({ text, parent: openThread.root.key })}
          onResolve={() => { live.apply([{ k: openThread.root.key, set: { resolved: true } }], { layer: "comments", undoable: false }); setThread(null); }}
          onClose={() => setThread(null)}
        />
      )}

      <BoardToolbar
        tool={tool}
        setTool={setTool}
        shapeKind={shapeKind}
        setShapeKind={setShapeKind}
        stamp={stamp}
        setStamp={setStamp}
        penColor={penColor}
        setPenColor={setPenColor}
        readOnly={readOnly}
        askSlot={
          <ShortcutTooltip label="Ask agent" accel="A" side="top">
            <AskButton className="board-ask" onClick={() => openAsk(selection.length ? "describe" : "ask")} />
          </ShortcutTooltip>
        }
      />
    </div>
  );
}
