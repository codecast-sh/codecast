// Boards (ct-91884): an infinite canvas people and their agent sessions think
// a plan through on together. The live-artifact shell (LiveArtifactPage)
// draws the title, facepile, share, history and every cursor; this view owns
// the canvas: camera, elements, gestures, keyboard, toolbar, the selection
// bar, comment pins and the Ask agent bubble.
import { AskButton } from "../live/AskAgentControl";
import { useAskDraft } from "../live/askAgent";
import "./board.css";
import { useCallback, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { Map as MapIcon, Minus, Plus, Scan, ScanSearch } from "lucide-react";
import type { ArtifactPosition } from "@codecast/shared/artifacts";
import {
  alignBoxes,
  boardArtFor,
  BOARD_TEMPLATES,
  BOARD_TEMPLATE_ART,
  BOARD_TEMPLATE_LABELS,
  bottomZ,
  stickyFitHeight,
  stickyIconHeight,
  templateOps,
  type BoardTemplate,
  cloneOps,
  connectorGeometry,
  elbowObstacles,
  frameAround,
  distributeBoxes,
  elementBounds,
  elementBox,
  intersects,
  nextZ,
  readingOrder,
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
import { BoardElementView, ConnectorView } from "./BoardElements";
import { BOARD_ASK_SLOT, editField } from "./boardModel";
import { BoardOverlay, type RemoteSelection } from "./BoardOverlay";
import { BoardToolbar } from "./BoardToolbar";
import { BoardSelectionBar, type BarAction } from "./BoardSelectionBar";
import { BoardPrompt, type PromptMode } from "./BoardPrompt";
import { CommentPins, CommentThreadPopover } from "./BoardComments";
import { initialsOf, pinPoints, useThreads } from "./commentThreads";
import { useBoardCamera } from "./useBoardCamera";
import { useBoardGestures, withFrameContents } from "./useBoardGestures";
import { useBoardKeys } from "./useBoardKeys";
import { pasteOps, placeImage, serializeSelection, stickiesToTasks } from "./boardActions";
import type { BoardEl, BoardTool } from "./boardTypes";
import { drawOrder, fitBox } from "./boardFrame";
import { BoardMinimap } from "./BoardMinimap";
import { nextStickySpot } from "./boardPlacement";
import { BoardEditBar } from "./BoardEditBar";
import { BOARD_ART_URLS } from "./boardArtUrls";

const MINIMAP_KEY = "board-minimap";
/** Below this pane width the overview would cover the board itself, so it is not offered. */
const MINIMAP_MIN_W = 600;

const NOOP = () => {};
const NOOP_EDIT = { editing: false, onEditInput: NOOP, onEditDone: NOOP };

type PromptState = { mode: PromptMode; at: Pt; world?: Pt; anchor?: string | null };

export default function BoardView({ doc, live, selection, setSelection, mode, snapshot, toScreen, setExports }: LiveViewProps) {
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
  const editBaseH = useRef<number | null>(null);
  // What the board's own chrome covers at its edges: the zoom bar above, the toolbar below, the overview at the right.
  const chromeInsets = () => {
    const w = cam.rootRef.current?.clientWidth ?? 0;
    return { top: w ? 40 : 0, bottom: 64, right: 0 };
  };
  const [locked, setLocked] = useState(false);
  const [minimap, setMinimapState] = useState(() => { try { return localStorage.getItem(MINIMAP_KEY) === "1"; } catch { return false; } });
  const setMinimap = (on: boolean) => { setMinimapState(on); try { localStorage.setItem(MINIMAP_KEY, on ? "1" : "0"); } catch { /* private mode */ } };
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
  const lastFit = useRef<{ w: number; h: number; ready: boolean } | null>(null);
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
    // Once the board has loaded, a new element is someone's edit, not more of the board arriving:
    // the view stays put (only a pane resize frames it again).
    const last = lastFit.current;
    if (fitted.current && last && last.ready && last.w === cam.viewport.w && last.h === cam.viewport.h) return;
    fitted.current = true;
    cam.fit(fitBox(elements, byKey), { instant: true, minReadable: true, insets: chromeInsets() });
    autoCam.current = { ...cam.cam.current };
    lastFit.current = { w: cam.viewport.w, h: cam.viewport.h, ready: live.ready };
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

  // ── Export: the shell's Download menu asks the board for a picture of itself (or of the selection) ──
  const exportRef = useRef({ elements, byKey });
  exportRef.current = { elements, byKey };
  useMountEffect(() => {
    const picture = async (selection: string[]) => {
      const { boardSvg } = await import("./boardExport");
      const root = cam.rootRef.current;
      if (!root) throw new Error("the board is not on screen");
      return boardSvg({ ...exportRef.current, root, only: selection });
    };
    setExports([
      { format: "png", selectionAware: true, run: async ({ selection }) => (await import("./boardExport")).svgToPng(await picture(selection), 2) },
      { format: "svg", selectionAware: true, run: async ({ selection }) => new Blob([await picture(selection)], { type: "image/svg+xml" }) },
    ]);
    return () => setExports(null);
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
        if (!field) return;
        const extra: Record<string, number | null> = {};
        if (el!.kind === "text") extra.h = null;
        if (el!.kind === "sticky") {
          // A sticky grows with its text past reading size, and back down to where it started.
          const b = elementBox(el!);
          editBaseH.current ??= b.h;
          const h = stickyFitHeight(text, b.w, editBaseH.current, stickyIconHeight(el!.icon, !!boardArtFor(el!.icon), b.w, editBaseH.current));
          if (h !== b.h) extra.h = h;
        }
        live.preview([{ k: editing, set: { [field]: text, ...extra } }]);
      },
      onEditNext: (dir: 1 | -1) => {
        // Tab types the next thought: a sticky like this one beside it (Shift: below), ready for words.
        const el = byKeyRef.current.get(editing);
        if (el?.kind !== "sticky") return;
        const b = elementBox(el);
        const k = newElementKey("el");
        // The next free spot in that direction; inside a frame the row wraps and the frame grows.
        const h = editBaseH.current ?? b.h;
        const { growFrame, ...spot } = nextStickySpot(b, h, dir, byKeyRef.current.values());
        const put = { kind: "sticky", ...spot, w: b.w, h, text: "", color: el.color ?? "yellow", z: nextZ({ elements: [...byKeyRef.current.values()] }) };
        live.commit();
        editBaseH.current = null;
        live.apply([{ k, put: put as any }, ...(growFrame ? [{ k: growFrame.key, set: { h: growFrame.h } }] : [])]);
        byKeyRef.current.set(k, { ...(put as any), key: k, rev: 0 });
        setSelection([k]);
        setEditing(k);
        reveal(byKeyRef.current.get(k)!);
      },
      onEditDone: () => {
        editBaseH.current = null;
        live.commit();
        const el = byKeyRef.current.get(editing);
        // An empty text box is nothing: it goes away instead of leaving an invisible element.
        if (el?.kind === "text" && !String(el.text ?? "").trim()) live.apply([{ k: editing, del: true }], { undoable: false });
        // A blur that lands after Tab opened the next sticky must not close that one.
        setEditing((cur) => (cur === editing ? null : cur));
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
    cam, live, byKey: byKeyRef, selection, setSelection, tool, setTool, shapeKind, stamp, penColor, spaceHeld, startEdit, onComment, onCardTool, readOnly, locked,
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
      case "edit":
        if (selection.length === 1) startEdit(selection[0]);
        return;
      case "frame": {
        // Wrap what is selected in a new frame, title ready to type, as FigJam's Frame selection does.
        const inside = selectedEls.filter((e) => e.kind !== "connector").map(elementBounds);
        const op = frameAround(inside, "Frame", bottomZ({ elements: allEls() }), 24);
        if (!op) return;
        live.apply([op]);
        byKeyRef.current.set(op.k, { ...("put" in op ? (op.put as any) : {}), key: op.k, rev: 0 });
        setSelection([op.k]);
        startEdit(op.k);
        return;
      }
      case "open": {
        const node = cam.rootRef.current?.querySelector(`[data-key="${CSS.escape(selection[0])}"] a[href]`) as HTMLAnchorElement | null;
        node?.click();
        return;
      }
      case "delete":
        deleteSelection();
    }
  };
  const startTemplate = (t: BoardTemplate) => {
    const { ops } = templateOps(t, { x: 0, y: 0 }, bottomZ({ elements: allEls() }), nextZ({ elements: allEls() }));
    live.apply(ops);
    const placed = ops.flatMap((o) => ("put" in o ? [{ ...(o.put as any), key: o.k, rev: 0 } as BoardEl] : []));
    const m = new Map(placed.map((e) => [e.key, e]));
    cam.fit(fitBox(placed, m), { maxZ: 1, insets: chromeInsets() });
  };
  /** Bring an element into view at the current zoom when it is off screen (Tab walking). */
  const reveal = (el: BoardEl) => {
    const root = cam.rootRef.current;
    if (!root) return;
    const b = el.kind === "connector" ? connectorGeometry(el, (k) => byKeyRef.current.get(k))?.box : elementBounds(el);
    if (!b) return;
    const { x, y, z } = cam.cam.current;
    const s = { x: b.x * z + x, y: b.y * z + y, w: b.w * z, h: b.h * z };
    const W = root.clientWidth, H = root.clientHeight, m = 60;
    if (s.x >= m && s.y >= m && s.x + s.w <= W - m && s.y + s.h <= H - 80) return;
    cam.glide({ z, x: W / 2 - (b.x + b.w / 2) * z, y: H / 2 - (b.y + b.h / 2) * z });
  };
  const fitTo = (selectionOnly: boolean) => {
    const els = selectionOnly && selectedEls.length ? selectedEls : elements;
    cam.fit(fitBox(els, byKey), { maxZ: selectionOnly ? 2 : 1, insets: chromeInsets() });
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
    frameSelection: () => { if (selectedEls.length) runBar({ type: "frame" }); },
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
    editSelection: () => {
      if (selection.length === 1) { startEdit(selection[0]); return; }
      // With a making tool armed and nothing selected, Enter places one in the middle of the view: the keyboard's click.
      if (!selection.length && (tool === "sticky" || tool === "text" || tool === "shape" || tool === "frame" || tool === "stamp")) gestures.placeAt(tool, viewCenter());
    },
    cycle: (dir) => {
      const order = readingOrder([...byKeyRef.current.values()].filter((e) => e.kind !== "pen")) as BoardEl[];
      if (!order.length) return false;
      const at = selection.length ? order.findIndex((e) => e.key === selection[selection.length - 1]) : -1;
      const next = order[at === -1 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length];
      setSelection([next.key]);
      reveal(next);
      return true;
    },
    hasSelection: () => selection.length > 0,
    toggleLock: () => setLocked((l) => !l),
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

  // Elbow connectors route around these: everything a line should not cross.
  const obstacles = useMemo(() => elbowObstacles(elements), [elements]);

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

  // Where the format bar sits while text is being edited: above the element, like the selection bar.
  const editAt = useMemo(() => {
    const el = editing ? byKey.get(editing) : undefined;
    if (!el || readOnly || el.kind === "frame" || el.kind === "connector" || !cam.viewport.w) return null;
    const b = elementBounds(el);
    const top = b.y * vcam.z + vcam.y;
    return { x: (b.x + b.w / 2) * vcam.z + vcam.x, y: Math.max(48, top - 12) };
  }, [editing, byKey, vcam, readOnly, cam.viewport.w]);
  // What a screen reader hears when the selection moves.
  const announce = useMemo(() => {
    if (selectedEls.length !== 1) return selectedEls.length ? `${selectedEls.length} selected` : "";
    const e = selectedEls[0];
    const words = String(e.text ?? e.title ?? e.label ?? e.ref ?? e.emoji ?? "").replace(/\s+/g, " ").slice(0, 120);
    return `${e.kind}${e.shape ? ` ${e.shape}` : ""}${words ? `: ${words}` : ""}`;
  }, [selectedEls]);

  const openThread = threads.find((t) => t.root.key === thread);
  const threadAt = openThread ? (() => { const p = pinPoints(threads, byKey).get(openThread.root.key); return p ? cam.toScreen(p) : null; })() : null;
  const zoomPct = Math.round(vcam.z * 100);
  const empty = live.ready && elements.length === 0 && !snapshot && !prompt;
  const teamId = (doc as typeof doc & { team_id?: string }).team_id;
  const docRef = useMemo(() => ({ _id: doc._id, title: doc.title, doc_type: doc.doc_type, project_path: doc.project_path, git_root: doc.git_root, team_id: teamId }), [doc._id, doc.title, doc.doc_type, doc.project_path, doc.git_root, teamId]);

  return (
    <div
      ref={cam.rootRef}
      className={`board-root board-tool-${tool}${readOnly ? " is-readonly" : ""}`}
      data-board
      tabIndex={0}
      role="application"
      aria-label={`${doc.title}: board. Tab walks elements, Enter edits, ? lists shortcuts`}
      aria-roledescription="board"
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
              obstacles={el.curve === "elbow" ? obstacles : undefined}
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
          <div role="group" aria-label="Templates" style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", maxWidth: "calc(100vw - 48px)" }}>
            {BOARD_TEMPLATES.map((t) => (
              <button key={t} type="button" className="board-empty-btn" style={{ padding: "0 12px 0 6px" }} onClick={() => startTemplate(t)}>
                <img src={BOARD_ART_URLS[BOARD_TEMPLATE_ART[t]]} alt="" draggable={false} style={{ width: 26, height: 26, objectFit: "contain" }} />
                <span>{BOARD_TEMPLATE_LABELS[t]}</span>
              </button>
            ))}
          </div>
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
        <ShortcutTooltip label="Zoom to selection" accel="Shift+2" side="bottom">
          <button type="button" className="board-bar-btn" aria-label="Zoom to selection" disabled={selectedEls.length === 0} style={selectedEls.length ? undefined : { opacity: 0.35 }} onClick={() => fitTo(true)}><ScanSearch size={14} strokeWidth={1.75} /></button>
        </ShortcutTooltip>
        {cam.viewport.w >= MINIMAP_MIN_W && <ShortcutTooltip label={minimap ? "Hide overview" : "Overview"} side="bottom">
          <button type="button" className={`board-bar-btn${minimap ? " is-active" : ""}`} aria-label="Overview" aria-pressed={minimap} onClick={() => setMinimap(!minimap)}><MapIcon size={14} strokeWidth={1.75} /></button>
        </ShortcutTooltip>}
      </div>

      {minimap && elements.length > 0 && cam.viewport.w >= MINIMAP_MIN_W && <BoardMinimap elements={elements} byKey={byKey} cam={cam} top={cam.viewport.w < 820} />}
      {editAt && <BoardEditBar at={editAt} />}
      <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>{announce}</div>

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
          onComment={(text) => live.comment({ text, ...(prompt.anchor ? { anchor: prompt.anchor } : {}), ...(prompt.world ? { point: { x: Math.round(prompt.world.x), y: Math.round(prompt.world.y) } } : {}) })}
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
        locked={locked}
        setLocked={setLocked}
        onImages={(files) => {
          const at = viewCenter();
          files.forEach((f, i) => void placeImage(live, convex as any, f, { x: at.x + i * 40, y: at.y + i * 40 }, allEls()));
        }}
        compact={cam.viewport.w > 0 && cam.viewport.w < 600}
        askSlot={
          <ShortcutTooltip label="Ask agent" accel="A" side="top">
            <AskButton className="board-ask" label={cam.viewport.w > 0 && cam.viewport.w < 600 ? null : undefined} aria-label="Ask agent" onClick={() => openAsk(selection.length ? "describe" : "ask")} />
          </ShortcutTooltip>
        }
      />
    </div>
  );
}
