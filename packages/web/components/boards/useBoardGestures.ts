// Pointer gestures on the board: one state machine for select, move (with
// snapping and alt-drag duplicate), marquee, resize, rotate, pen, create,
// connect and pan. Every drag paints through live.preview and lands with one
// live.commit on pointerup, so a gesture is one undo step and one sync burst.
import { useCallback, useRef, useState } from "react";
import type { ArtifactOp } from "@codecast/shared/artifacts";
import {
  BOARD_DEFAULT_SIZE,
  clearOffset,
  cloneOps,
  connectorGeometry,
  elbowObstacles,
  isBoardArt,
  nearestAlong,
  contains,
  elementBounds,
  elementBox,
  intersects,
  nextZ,
  bottomZ,
  normBox,
  simplifyStroke,
  snapBox,
  unionBox,
  type Box,
  type Pt,
  type SnapGuide,
} from "@codecast/shared/artifacts/board";
import { newElementKey } from "@codecast/shared/artifacts";
import { zoomAround, type BoardCamera } from "./useBoardCamera";
import type { BoardEl, BoardLive, BoardTool } from "./boardTypes";

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "rotate" | "connect";

type Gesture =
  | { type: "pan"; last: Pt }
  | { type: "pinch"; dist: number; mid: Pt; origin: Pt }
  | { type: "label"; key: string; moved: boolean }
  | { type: "move"; start: Pt; moved: boolean; origin: Map<string, Pt>; ends: Map<string, { x1?: number; y1?: number; x2?: number; y2?: number }>; snapBase: Box | null; others: Box[]; toggleOff?: string }
  | { type: "marquee"; start: Pt; base: string[]; groups: Map<string, string[]> }
  | { type: "resize"; handle: Handle; start: Pt; box: Box; items: Map<string, BoardEl>; rot: number }
  | { type: "rotate"; key: string; center: Pt; startAngle: number; startRot: number }
  | { type: "pen"; pts: Pt[] }
  | { type: "create"; tool: BoardTool; start: Pt; end: Pt }
  | { type: "connect"; from: string | null; start: Pt; end: Pt; over: string | null };

export type GestureOverlay = {
  marquee: Box | null;
  guides: SnapGuide[];
  pen: Pt[] | null;
  draft: Box | null;
  link: { a: Pt; b: Pt; over: string | null } | null;
};

const EMPTY: GestureOverlay = { marquee: null, guides: [], pen: null, draft: null, link: null };

export type GestureDeps = {
  cam: BoardCamera;
  live: BoardLive;
  /** Current merged elements by key (a ref the view refreshes every render). */
  byKey: React.MutableRefObject<Map<string, BoardEl>>;
  selection: string[];
  setSelection(keys: string[]): void;
  tool: BoardTool;
  setTool(t: BoardTool): void;
  shapeKind: string;
  stamp: string;
  penColor: string;
  spaceHeld: React.MutableRefObject<boolean>;
  startEdit(key: string): void;
  onComment(at: Pt, anchor: string | null): void;
  onCardTool(at: Pt): void;
  readOnly: boolean;
  /** The tool stays on after a placement. */
  locked: boolean;
};

/** Element under a pointer event, or null for empty canvas (a frame's body counts as empty). */
export function hitKey(target: EventTarget | null): string | null {
  const t = target as HTMLElement | null;
  const node = t?.closest?.("[data-key]") as HTMLElement | null;
  if (!node) return null;
  if (node.hasAttribute("data-frame") && !t?.closest?.("[data-part=frame-title]")) return null;
  return node.getAttribute("data-key");
}

/**
 * The keys plus everything inside any selected frame, plus connectors whose
 * both ends are in the set. Moving, nudging and duplicating a frame all act
 * on this, so a frame always takes its contents along.
 */
export function withFrameContents(keys: readonly string[], byKey: Map<string, BoardEl>): string[] {
  const set = new Set(keys);
  const frames: Box[] = [];
  for (const k of keys) {
    const el = byKey.get(k);
    if (el?.kind !== "frame") continue;
    const fb = elementBox(el);
    frames.push(fb);
    for (const o of byKey.values()) if (o.kind !== "connector" && o.kind !== "frame" && contains(fb, elementBounds(o))) set.add(o.key);
  }
  // An arrow comes along when each end is either attached to something that moves or a loose end inside a moving frame.
  const inFrame = (x: unknown, y: unknown) => typeof x === "number" && typeof y === "number" && frames.some((f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h);
  for (const o of byKey.values()) {
    if (o.kind !== "connector") continue;
    const a = typeof o.from === "string" ? set.has(o.from) : inFrame(o.x1, o.y1);
    const b = typeof o.to === "string" ? set.has(o.to) : inFrame(o.x2, o.y2);
    if (a && b) set.add(o.key);
  }
  return [...set];
}

/** The keys that select together with `key`: its whole group. */
export function withGroup(key: string, byKey: Map<string, BoardEl>): string[] {
  const g = byKey.get(key)?.group;
  if (typeof g !== "string") return [key];
  return [...byKey.values()].filter((e) => e.group === g).map((e) => e.key);
}

export function useBoardGestures(d: GestureDeps) {
  const g = useRef<Gesture | null>(null);
  /** Fingers on the canvas, by pointer id, in client coordinates. */
  const touches = useRef(new Map<number, Pt>());
  const [overlay, setOverlay] = useState<GestureOverlay>(EMPTY);
  const deps = useRef(d);
  deps.current = d;

  const worldOf = (e: { clientX: number; clientY: number }) => deps.current.cam.clientToWorld(e.clientX, e.clientY);

  const beginMove = (start: Pt, keys: string[], duplicate: boolean, toggleOff?: string) => {
    const { byKey, live } = deps.current;
    // A selected frame carries what sits inside it; work that out before any copy.
    let moving = withFrameContents(keys, byKey.current);
    if (duplicate) {
      const els = moving.map((k) => byKey.current.get(k)).filter(Boolean) as BoardEl[];
      const { ops, keys: copies, map } = cloneOps(els, 0, 0, nextZ({ elements: [...byKey.current.values()] }), (k) => byKey.current.has(k));
      live.apply(ops);
      for (const op of ops) if ("put" in op) byKey.current.set(op.k, { ...(op.put as any), key: op.k, rev: 0 });
      // The copy of what was selected stays selected; the copied contents move with it.
      deps.current.setSelection(keys.map((k) => map.get(k)).filter((k): k is string => !!k));
      moving = copies;
    }
    const origin = new Map<string, Pt>();
    const ends = new Map<string, { x1?: number; y1?: number; x2?: number; y2?: number }>();
    const boxes: Box[] = [];
    for (const k of moving) {
      const el = byKey.current.get(k);
      if (!el) continue;
      if (el.kind === "connector") {
        // Attached ends follow their elements; free ends move with the selection.
        const e: { x1?: number; y1?: number; x2?: number; y2?: number } = {};
        if (typeof el.from !== "string" && typeof el.x1 === "number") { e.x1 = el.x1; e.y1 = Number(el.y1) || 0; }
        if (typeof el.to !== "string" && typeof el.x2 === "number") { e.x2 = el.x2; e.y2 = Number(el.y2) || 0; }
        if (Object.keys(e).length) ends.set(k, e);
        continue;
      }
      origin.set(k, { x: Number(el.x) || 0, y: Number(el.y) || 0 });
      boxes.push(elementBounds(el));
    }
    const set = new Set(moving);
    const view = deps.current.cam.viewport.world;
    const others: Box[] = [];
    for (const o of byKey.current.values()) {
      if (set.has(o.key) || o.kind === "connector" || o.kind === "pen") continue;
      const b = elementBounds(o);
      if (intersects(b, view)) others.push(b);
      if (others.length > 400) break;
    }
    g.current = { type: "move", start, moved: false, origin, ends, snapBase: unionBox(boxes), others, toggleOff };
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const dd = deps.current;
    if (e.button === 2) return;
    const root = dd.cam.rootRef.current;
    if (!root) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-board-ui]")) return;
    try { root.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        // A second finger turns whatever the first one started into a pinch: zoom and pan together.
        const cur = g.current;
        if (cur?.type === "move" && cur.moved) dd.live.commit();
        if (cur?.type === "marquee") dd.setSelection(cur.base);
        setOverlay(EMPTY);
        const [a, b] = [...touches.current.values()];
        const r = root.getBoundingClientRect();
        g.current = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, origin: { x: r.left, y: r.top } };
        dd.cam.stopGlide();
        return;
      }
      if (touches.current.size > 2) return;
    }
    const p = worldOf(e);
    if (e.button === 1 || dd.tool === "hand" || dd.spaceHeld.current) {
      g.current = { type: "pan", last: { x: e.clientX, y: e.clientY } };
      root.dataset.panning = "1";
      dd.cam.stopGlide();
      return;
    }
    if (dd.readOnly) {
      g.current = { type: "pan", last: { x: e.clientX, y: e.clientY } };
      return;
    }
    const handle = target.closest("[data-handle]")?.getAttribute("data-handle") as Handle | null;
    if (handle === "connect") {
      g.current = { type: "connect", from: dd.selection[0] ?? null, start: p, end: p, over: null };
      return;
    }
    if (handle === "rotate" && dd.selection.length === 1) {
      const el = dd.byKey.current.get(dd.selection[0]);
      if (el) {
        const b = elementBox(el);
        const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        // Rotation follows the pointer's turn around the center from where the drag began.
        g.current = { type: "rotate", key: el.key, center: c, startAngle: (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI, startRot: typeof el.rot === "number" ? el.rot : 0 };
      }
      return;
    }
    if (handle) {
      const items = new Map<string, BoardEl>();
      for (const k of dd.selection) {
        const v = dd.byKey.current.get(k);
        if (v && v.kind !== "connector") items.set(k, v);
      }
      const box = unionBox([...items.values()].map(elementBox));
      // One turned element resizes along its own axes (the handles sit on its turned outline).
      const only = items.size === 1 ? [...items.values()][0] : null;
      const rot = only && typeof only.rot === "number" ? only.rot : 0;
      if (box) g.current = { type: "resize", handle, start: p, box, items, rot };
      return;
    }
    // A selected arrow's label slides along the arrow.
    const labelKey = target.closest(".board-connector-label") ? hitKey(e.target) : null;
    if (labelKey && dd.selection.length === 1 && dd.selection[0] === labelKey && dd.tool === "select") {
      g.current = { type: "label", key: labelKey, moved: false };
      return;
    }
    // A live card's own controls (open, expand) work when its card is the selection.
    if (target.closest(".board-card.is-interactive a, .board-card.is-interactive button")) return;
    const key = hitKey(e.target);
    switch (dd.tool) {
      case "pen":
        g.current = { type: "pen", pts: [p] };
        setOverlay({ ...EMPTY, pen: [p] });
        return;
      case "connector":
        g.current = { type: "connect", from: key, start: p, end: p, over: null };
        return;
      case "comment":
        dd.onComment(p, key);
        return;
      case "card":
        dd.onCardTool(p);
        return;
      case "sticky":
      case "text":
      case "shape":
      case "frame":
      case "stamp":
        g.current = { type: "create", tool: dd.tool, start: p, end: p };
        return;
    }
    // Select tool.
    if (key) {
      const group = withGroup(key, dd.byKey.current);
      const selected = dd.selection.includes(key);
      if (e.shiftKey) {
        if (selected) {
          beginMove(p, dd.selection, false, key);
          return;
        }
        const next = [...new Set([...dd.selection, ...group])];
        dd.setSelection(next);
        beginMove(p, next, e.altKey);
        return;
      }
      const next = selected ? dd.selection : group;
      if (!selected) dd.setSelection(next);
      beginMove(p, next, e.altKey);
      return;
    }
    // A finger on empty canvas pans, as in every touch canvas; a tap there still clears the selection.
    if (e.pointerType === "touch") {
      if (dd.selection.length) dd.setSelection([]);
      g.current = { type: "pan", last: { x: e.clientX, y: e.clientY } };
      dd.cam.stopGlide();
      return;
    }
    // A selected frame drags by its body too (an unselected frame's body is canvas, for a marquee inside it).
    const frameKey = (target.closest("[data-frame]") as HTMLElement | null)?.getAttribute("data-key");
    if (frameKey && dd.selection.includes(frameKey) && !e.shiftKey) {
      beginMove(p, dd.selection, e.altKey);
      return;
    }
    const base = e.shiftKey ? dd.selection : [];
    if (!e.shiftKey && dd.selection.length) dd.setSelection([]);
    // Index groups once per marquee, not once per hit per frame.
    const groups = new Map<string, string[]>();
    for (const el of dd.byKey.current.values()) if (typeof el.group === "string") groups.set(el.group, [...(groups.get(el.group) ?? []), el.key]);
    g.current = { type: "marquee", start: p, base, groups };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const dd = deps.current;
    if (e.pointerType === "touch" && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cur = g.current;
    if (!cur) return;
    if (cur.type === "pinch") {
      if (touches.current.size < 2) return;
      const [a, b] = [...touches.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const at = { x: mid.x - cur.origin.x, y: mid.y - cur.origin.y };
      const zoomed = zoomAround(dd.cam.cam.current, cur.dist > 0 ? dist / cur.dist : 1, at);
      dd.cam.set({ ...zoomed, x: zoomed.x + mid.x - cur.mid.x, y: zoomed.y + mid.y - cur.mid.y });
      cur.dist = dist;
      cur.mid = mid;
      return;
    }
    const p = worldOf(e);
    switch (cur.type) {
      case "label": {
        const el = dd.byKey.current.get(cur.key);
        const geo = el && connectorGeometry(el, (k) => dd.byKey.current.get(k), el.curve === "elbow" ? elbowObstacles(dd.byKey.current.values()) : undefined);
        if (!geo) return;
        cur.moved = true;
        dd.live.preview([{ k: cur.key, set: { label_at: Math.round(nearestAlong(geo.points, p) * 1000) / 1000 } }]);
        return;
      }
      case "pan": {
        const dx = e.clientX - cur.last.x, dy = e.clientY - cur.last.y;
        cur.last = { x: e.clientX, y: e.clientY };
        dd.cam.set({ ...dd.cam.cam.current, x: dd.cam.cam.current.x + dx, y: dd.cam.cam.current.y + dy });
        return;
      }
      case "move": {
        let dx = p.x - cur.start.x, dy = p.y - cur.start.y;
        const z = dd.cam.cam.current.z;
        if (!cur.moved && Math.hypot(dx * z, dy * z) < 3) return;
        cur.moved = true;
        let guides: SnapGuide[] = [];
        if (cur.snapBase && !e.metaKey && !e.ctrlKey) {
          const s = snapBox({ ...cur.snapBase, x: cur.snapBase.x + dx, y: cur.snapBase.y + dy }, cur.others, 6 / z);
          dx += s.dx; dy += s.dy; guides = s.guides;
        }
        const ops: ArtifactOp[] = [];
        for (const [k, o] of cur.origin) ops.push({ k, set: { x: Math.round(o.x + dx), y: Math.round(o.y + dy) } });
        for (const [k, e] of cur.ends) {
          const set: Record<string, number> = {};
          if (e.x1 !== undefined) { set.x1 = Math.round(e.x1 + dx); set.y1 = Math.round(e.y1! + dy); }
          if (e.x2 !== undefined) { set.x2 = Math.round(e.x2 + dx); set.y2 = Math.round(e.y2! + dy); }
          ops.push({ k, set });
        }
        dd.live.preview(ops);
        setOverlay((prev) => (prev.guides.length === 0 && guides.length === 0 ? prev : { ...EMPTY, guides }));
        return;
      }
      case "marquee": {
        const box = normBox(cur.start, p);
        const hits: string[] = [];
        for (const el of dd.byKey.current.values()) {
          if (el.kind === "connector") continue;
          const b = elementBounds(el);
          if (el.kind === "frame" ? contains(box, b) : intersects(box, b)) hits.push(el.key);
        }
        const grouped = new Set(cur.base);
        for (const k of hits) {
          const gid = dd.byKey.current.get(k)?.group;
          for (const gk of typeof gid === "string" ? cur.groups.get(gid) ?? [k] : [k]) grouped.add(gk);
        }
        const next = [...grouped];
        if (next.length !== dd.selection.length || next.some((k, i) => k !== dd.selection[i])) dd.setSelection(next);
        setOverlay({ ...EMPTY, marquee: box });
        return;
      }
      case "resize": {
        // A picture keeps its proportions on a corner drag (Shift frees it); everything else scales freely (Shift locks it).
        const keep = keepsAspect(cur.items) ? !e.shiftKey : e.shiftKey;
        const nb = cur.rot
          ? rotatedResizeBox(cur.box, cur.rot, cur.handle, p.x - cur.start.x, p.y - cur.start.y, keep)
          : resizedBox(cur.box, cur.handle, p.x - cur.start.x, p.y - cur.start.y, keep);
        dd.live.preview(resizeOps(cur.items, cur.box, nb, cur.handle));
        return;
      }
      case "rotate": {
        let deg = cur.startRot + (Math.atan2(p.y - cur.center.y, p.x - cur.center.x) * 180) / Math.PI - cur.startAngle;
        deg = ((e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg)) % 360 + 360) % 360;
        if (deg < 3 || deg > 357) deg = 0;
        dd.live.preview([{ k: cur.key, set: { rot: deg ? ((deg % 360) + 360) % 360 : null } }]);
        return;
      }
      case "pen": {
        const last = cur.pts[cur.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * dd.cam.cam.current.z < 2) return;
        cur.pts.push(p);
        setOverlay({ ...EMPTY, pen: [...cur.pts] });
        return;
      }
      case "create": {
        cur.end = p;
        if (cur.tool === "frame" || cur.tool === "shape") setOverlay({ ...EMPTY, draft: normBox(cur.start, p) });
        return;
      }
      case "connect": {
        cur.end = p;
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const over = hitKey(under);
        cur.over = over && over !== cur.from && dd.byKey.current.get(over)?.kind !== "connector" ? over : null;
        setOverlay({ ...EMPTY, link: { a: cur.start, b: p, over: cur.over } });
        return;
      }
    }
  }, []);

  /**
   * Make what a tool makes: at `start` for a click (the tool's own size,
   * centered), or filling start→end for a drag. The keyboard places one the
   * same way at the middle of the view.
   */
  const place = (tool: BoardTool, start: Pt, end: Pt) => {
    const dd = deps.current;
    const all = () => ({ elements: [...dd.byKey.current.values()] });
    const drag = normBox(start, end);
    const dragged = drag.w * dd.cam.cam.current.z > 6 && drag.h * dd.cam.cam.current.z > 6;
    const k = newElementKey("el");
    const size = BOARD_DEFAULT_SIZE[tool] ?? { w: 160, h: 100 };
    const at = (w: number, h: number) => (dragged ? { x: Math.round(drag.x), y: Math.round(drag.y), w: Math.round(drag.w), h: Math.round(drag.h) } : { x: Math.round(start.x - w / 2), y: Math.round(start.y - h / 2), w, h });
    let op: ArtifactOp;
    if (tool === "sticky") op = { k, put: { kind: "sticky", ...at(200, 160), text: "", color: "yellow", z: nextZ(all()) } };
    else if (tool === "text") op = { k, put: { kind: "text", x: Math.round(start.x), y: Math.round(start.y - 13), text: "", size: 20, z: nextZ(all()) } };
    else if (tool === "shape") op = { k, put: { kind: "shape", shape: dd.shapeKind, ...at(size.w, size.h), color: "gray", z: nextZ(all()) } };
    else if (tool === "frame") op = { k, put: { kind: "frame", ...at(size.w, size.h), title: "Frame", z: bottomZ(all()) } };
    else {
      // A painted illustration is a sticker worth seeing; an emoji stays a small reaction.
      const sz = isBoardArt(dd.stamp) ? 120 : 48;
      op = { k, put: { kind: "stamp", x: Math.round(start.x - sz / 2), y: Math.round(start.y - sz / 2), size: sz, emoji: dd.stamp, z: nextZ(all()) } };
    }
    dd.live.apply([op]);
    dd.byKey.current.set(k, { ...(op.put as any), key: k, rev: 0 });
    if (tool !== "stamp") {
      dd.setSelection([k]);
      if (!dd.locked) dd.setTool("select");
      // A new sticky, text, shape or frame opens for typing straight away.
      dd.startEdit(k);
    }
  };

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const dd = deps.current;
    touches.current.delete(e.pointerId);
    const cur = g.current;
    // A pinch ends when either finger lifts; the one left on the glass starts nothing.
    if (cur?.type === "pinch") {
      if (touches.current.size < 2) g.current = null;
      return;
    }
    g.current = null;
    const root = dd.cam.rootRef.current;
    if (root) delete root.dataset.panning;
    setOverlay(EMPTY);
    if (!cur) return;
    const p = worldOf(e);
    const all = () => ({ elements: [...dd.byKey.current.values()] });
    switch (cur.type) {
      case "move":
        if (cur.moved) dd.live.commit();
        else if (cur.toggleOff) dd.setSelection(dd.selection.filter((k) => !withGroup(cur.toggleOff!, dd.byKey.current).includes(k)));
        return;
      case "resize":
      case "rotate":
        dd.live.commit();
        return;
      case "label":
        if (cur.moved) dd.live.commit();
        return;
      case "pen": {
        const pts = simplifyStroke(cur.pts, 0.8 / dd.cam.cam.current.z);
        if (pts.length < 2 && cur.pts.length < 2) return;
        const minX = Math.min(...pts.map((q) => q.x)), minY = Math.min(...pts.map((q) => q.y));
        const flat: number[] = [];
        for (const q of pts) flat.push(Math.round((q.x - minX) * 10) / 10, Math.round((q.y - minY) * 10) / 10);
        dd.live.apply([{ k: newElementKey("el"), put: { kind: "pen", x: Math.round(minX), y: Math.round(minY), points: flat, width: 3, color: dd.penColor, z: nextZ(all()) } }]);
        return;
      }
      case "create":
        place(cur.tool, cur.start, cur.end);
        return;
      case "connect": {
        const z = dd.cam.cam.current.z;
        if (Math.hypot(cur.end.x - cur.start.x, cur.end.y - cur.start.y) * z < 8) return;
        const k = newElementKey("el");
        const fields: Record<string, any> = { kind: "connector", arrow: "end", z: nextZ(all()) };
        if (cur.from) fields.from = cur.from; else { fields.x1 = Math.round(cur.start.x); fields.y1 = Math.round(cur.start.y); }
        if (cur.over) fields.to = cur.over; else { fields.x2 = Math.round(p.x); fields.y2 = Math.round(p.y); }
        dd.live.apply([{ k, put: fields as any }]);
        dd.setSelection([k]);
        if (dd.tool === "connector" && !dd.locked) dd.setTool("select");
        return;
      }
    }
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const dd = deps.current;
    if ((e.target as HTMLElement).closest("[data-board-ui]")) return;
    const t = e.target as HTMLElement;
    const node = t.closest("[data-key]") as HTMLElement | null;
    // A frame's body is canvas: a double-click there drops a sticky inside the frame.
    const key = hitKey(e.target);
    const card = key ? dd.byKey.current.get(key) : undefined;
    if (card?.kind === "card") {
      (node?.querySelector("a[href]") as HTMLAnchorElement | null)?.click();
      return;
    }
    if (dd.readOnly) return;
    if (!key) {
      // Double-click on empty canvas drops a sticky, the fastest way to start a thought.
      const p = worldOf(e);
      const k = newElementKey("el");
      dd.live.apply([{ k, put: { kind: "sticky", x: Math.round(p.x - 100), y: Math.round(p.y - 80), w: 200, h: 160, text: "", color: "yellow", z: nextZ({ elements: [...dd.byKey.current.values()] }) } }]);
      dd.byKey.current.set(k, { kind: "sticky", key: k, rev: 0, x: p.x - 100, y: p.y - 80, text: "" } as any);
      dd.setSelection([k]);
      dd.startEdit(k);
      return;
    }
    if (!dd.byKey.current.get(key)) return;
    dd.setSelection([key]);
    dd.startEdit(key);
  }, []);

  /**
   * Place the armed tool's element near a canvas point (keyboard creation):
   * at the point when it is free, else at the nearest spot that covers
   * nothing, so pressing Enter again and again lays notes out side by side.
   */
  const placeAt = (tool: BoardTool, at: Pt) => {
    const size = tool === "sticky" ? { w: 200, h: 160 } : BOARD_DEFAULT_SIZE[tool] ?? { w: 160, h: 100 };
    const taken = [...deps.current.byKey.current.values()].filter((e) => e.kind !== "frame" && e.kind !== "connector" && e.kind !== "pen").map(elementBounds);
    const off = clearOffset({ x: at.x - size.w / 2, y: at.y - size.h / 2, w: size.w, h: size.h }, taken, 40);
    const p = { x: at.x + off.x, y: at.y + off.y };
    place(tool, p, p);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onDoubleClick, overlay, placeAt };
}

/** Whether a resize keeps the selection's proportions by default: pictures (images, stickers, cards) do. */
export function keepsAspect(items: Map<string, BoardEl>): boolean {
  return items.size > 0 && [...items.values()].every((e) => e.kind === "image" || e.kind === "stamp" || e.kind === "card");
}

/** The selection box after dragging `handle` by (dx, dy); shift keeps the aspect ratio. */
export function resizedBox(b: Box, handle: Handle, dx: number, dy: number, keepAspect: boolean): Box {
  let { x, y, w, h } = b;
  if (handle.includes("e")) w = b.w + dx;
  if (handle.includes("w")) { w = b.w - dx; x = b.x + dx; }
  if (handle.includes("s")) h = b.h + dy;
  if (handle.includes("n")) { h = b.h - dy; y = b.y + dy; }
  const min = 16;
  if (w < min) { if (handle.includes("w")) x -= min - w; w = min; }
  if (h < min) { if (handle.includes("n")) y -= min - h; h = min; }
  if (keepAspect && handle.length === 2 && b.w && b.h) {
    const k = Math.max(w / b.w, h / b.h);
    const nw = b.w * k, nh = b.h * k;
    if (handle.includes("w")) x = b.x + b.w - nw;
    if (handle.includes("n")) y = b.y + b.h - nh;
    w = nw; h = nh;
  }
  return { x, y, w, h };
}

/**
 * Resize a box turned by `rot` degrees about its center: the drag is read in
 * the box's own axes, and the edge (or corner) opposite the handle stays where
 * it is on the canvas. Returns the new unturned box (same rotation).
 */
export function rotatedResizeBox(b: Box, rot: number, handle: Handle, dx: number, dy: number, keepAspect: boolean): Box {
  const t = (rot * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const local = resizedBox({ x: 0, y: 0, w: b.w, h: b.h }, handle, dx * cos + dy * sin, -dx * sin + dy * cos, keepAspect);
  // How far the center moved, in the box's axes, then on the canvas.
  const ox = local.x + local.w / 2 - b.w / 2, oy = local.y + local.h / 2 - b.h / 2;
  const cx = b.x + b.w / 2 + ox * cos - oy * sin, cy = b.y + b.h / 2 + ox * sin + oy * cos;
  return { x: cx - local.w / 2, y: cy - local.h / 2, w: local.w, h: local.h };
}

/** Ops that map every item from the old selection box into the new one. */
export function resizeOps(items: Map<string, BoardEl>, from: Box, to: Box, handle: Handle): ArtifactOp[] {
  const sx = to.w / (from.w || 1), sy = to.h / (from.h || 1);
  const ops: ArtifactOp[] = [];
  const single = items.size === 1;
  for (const [k, el] of items) {
    const b = elementBox(el);
    const nx = to.x + (b.x - from.x) * sx, ny = to.y + (b.y - from.y) * sy;
    const r = (n: number) => Math.round(n);
    if (el.kind === "stamp") {
      ops.push({ k, set: { x: r(nx), y: r(ny), size: r(Math.max(16, b.w * Math.min(sx, sy))) } });
    } else if (el.kind === "pen") {
      const pts = Array.isArray(el.points) ? (el.points as number[]) : [];
      ops.push({ k, set: { x: r(nx + ((Number(el.x) || 0) - b.x) * sx), y: r(ny + ((Number(el.y) || 0) - b.y) * sy), points: pts.map((v, i) => Math.round(v * (i % 2 === 0 ? sx : sy) * 10) / 10) } });
    } else if (el.kind === "text") {
      // A side handle rewraps the text; a corner handle scales the type.
      const corner = handle.length === 2;
      const size = typeof el.size === "number" ? el.size : 20;
      ops.push({ k, set: corner || !single ? { x: r(nx), y: r(ny), w: r(b.w * sx), size: Math.max(8, Math.round(size * Math.min(sx, sy) * 10) / 10), h: null } : { x: r(nx), y: r(ny), w: r(b.w * sx), h: null } });
    } else {
      ops.push({ k, set: { x: r(nx), y: r(ny), w: r(Math.max(16, b.w * sx)), h: r(Math.max(16, b.h * sy)) } });
    }
  }
  return ops;
}
