// The room overlay: a resizable side panel on desktop, a bottom sheet with
// three detents below 1024px (DESIGN 6.3, 6.11). Same parts in both.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useIdentity } from "../lib/identity";
import { useExit } from "../lib/useExit";
import { freshFocus, useAppState, useComposer, useStream } from "./appState";
import { ROOM_DEFAULT, ROOM_MIN, clampWidth, roomMax } from "./roomSize";
import { Composer } from "./Composer";
import { RoomHeader } from "./RoomHeader";
import { PastRow, SheetPeek } from "./SheetPeek";
import { Stream } from "./Stream";
import { TimelineStrip } from "./Timeline";
import s from "./Room.module.css";

export function RoomPanel({ open, width, onResize }: { open: boolean; width: number; onResize: (w: number) => void }) {
  const { setRoomOpen, picking, setPicking } = useAppState();
  const { mounted, leaving } = useExit(open, 180);
  if (!mounted) return null;

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onResize(clampWidth(innerWidth - ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <aside
      className={`${s.panel} ${leaving ? s.leaving : ""}`}
      style={{ width }}
      aria-label="Room"
      data-room
      tabIndex={-1}
      inert={leaving}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        // Picking was started from here; Esc ends it before it closes the room.
        e.preventDefault();
        if (picking) setPicking(false);
        else setRoomOpen(false);
      }}
    >
      <span
        className={s.resize}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize the room"
        aria-valuemin={ROOM_MIN}
        aria-valuemax={roomMax()}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels wide`}
        aria-keyshortcuts="ArrowLeft ArrowRight Home Enter"
        onPointerDown={startResize}
        onDoubleClick={() => onResize(ROOM_DEFAULT)}
        onKeyDown={(e) => {
          // The room grows leftward, so ← widens it.
          const to = { ArrowLeft: width + RESIZE_STEP, ArrowRight: width - RESIZE_STEP, Home: ROOM_DEFAULT, Enter: ROOM_DEFAULT }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          onResize(clampWidth(to));
        }}
      />
      <RoomHeader />
      <Stream />
      <Composer />
    </aside>
  );
}

const RESIZE_STEP = 20;

type Detent = "peek" | "half" | "full";
const DETENTS: Detent[] = ["peek", "half", "full"];
/** A press that moves less than this is a tap, not a drag. */
const TAP_SLOP_PX = 6;
const heightOf = (d: Detent, vh: number) => (d === "peek" ? 132 : d === "half" ? vh * 0.55 : vh * 0.92);

export function RoomSheet() {
  const { roomOpen, setRoomOpen, picking, showAppAt, viewing, view } = useAppState();
  const composer = useComposer();
  const { building } = useStream();
  const { me } = useIdentity();
  const [detent, setDetent] = useState<Detent>("half");
  const [drag, setDrag] = useState<number | null>(null);
  const vv = useVisualViewport();
  const { mounted, leaving } = useExit(roomOpen, 180);
  // Writing a change keeps the app in view above the keyboard: the sheet
  // rises from its peek to half, never further on its own.
  const toHalf = () => setDetent((d) => (d === "peek" ? "half" : d));
  const toPeek = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setDetent("peek");
  };

  useEffect(() => {
    if (roomOpen) setDetent("half");
  }, [roomOpen]);
  useEffect(() => {
    if (picking) setDetent("peek");
  }, [picking]);
  useEffect(() => {
    if (freshFocus(composer.focusAt)) toHalf();
  }, [composer.focusAt]);
  // Anything whose point is the app (See it, View, Back to live, Undo) gets
  // the sheet and the keyboard out of its way.
  useEffect(() => {
    if (freshFocus(showAppAt)) toPeek();
  }, [showAppAt]);
  // Your change is on its way (sent as Change it, or Auto made it one): the
  // sheet drops to its peek, so the app the change lands in is on screen when
  // it goes live. A half-written next message keeps its keyboard.
  const mine = building?.author?.id === me.id && building.build ? building.build.id : null;
  const seenBuild = useRef(mine);
  useEffect(() => {
    if (!mine || mine === seenBuild.current) return;
    seenBuild.current = mine;
    const field = document.activeElement;
    if (field instanceof HTMLTextAreaElement && field.value.trim()) return;
    toPeek();
  }, [mine]);

  if (!mounted) return null;

  const base = heightOf(detent, vv.height);
  const height = drag ?? base;

  const startDrag = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = height;
    let last = { y: e.clientY, t: performance.now() };
    let velocity = 0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientY - y0) < TAP_SLOP_PX && !moved) return;
      moved = true;
      const now = performance.now();
      velocity = (ev.clientY - last.y) / Math.max(1, now - last.t);
      last = { y: ev.clientY, t: now };
      setDrag(Math.max(60, Math.min(vv.height * 0.95, h0 - (ev.clientY - y0))));
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      // A tap on the handle or the peek opens the room to half.
      if (!moved) return toHalf();
      const h = h0 - (ev.clientY - y0);
      setDrag(null);
      const i = DETENTS.indexOf(detent);
      // A flick moves one detent; otherwise land on the nearest, and below
      // the peek, close.
      if (Math.abs(velocity) > 0.5) {
        if (velocity > 0 && i === 0) return setRoomOpen(false);
        return setDetent(DETENTS[Math.min(2, Math.max(0, i + (velocity > 0 ? -1 : 1)))]);
      }
      if (h < heightOf("peek", vv.height) * 0.6) return setRoomOpen(false);
      const nearest = DETENTS.reduce((a, b) => (Math.abs(heightOf(b, vv.height) - h) < Math.abs(heightOf(a, vv.height) - h) ? b : a));
      setDetent(nearest);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const peek = detent === "peek" && drag === null;
  return (
    <div
      className={`${s.sheet} ${drag !== null ? s.dragging : ""} ${leaving ? s.sheetLeaving : ""}`}
      style={{ height, bottom: vv.keyboard }}
      aria-label="Room"
      data-room
      tabIndex={-1}
      inert={leaving}
    >
      <div className={`${s.grab} ${peek ? s.grabPeek : ""}`} onPointerDown={startDrag}>
        <span className={s.handle} />
        {peek ? <SheetPeek /> : <RoomHeader compact />}
      </div>
      {!peek && (
        <>
          {viewing !== null && <PastRow n={viewing} onBack={() => view(null)} className={s.past} />}
          {/* Reading back through history is what the tall sheet is for. */}
          <Stream onBrowse={() => setDetent("full")} />
          {detent === "full" && <TimelineStrip />}
        </>
      )}
      <Composer compact={peek} onFocus={toHalf} />
    </div>
  );
}

/** The visible viewport, so the keyboard pushes the sheet up instead of
 *  covering the composer. */
function useVisualViewport() {
  const read = () => {
    const v = window.visualViewport;
    return v ? { height: v.height, keyboard: Math.max(0, innerHeight - v.height - v.offsetTop) } : { height: innerHeight, keyboard: 0 };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const v = window.visualViewport;
    const update = () => setState(read());
    v?.addEventListener("resize", update);
    v?.addEventListener("scroll", update);
    addEventListener("resize", update);
    return () => {
      v?.removeEventListener("resize", update);
      v?.removeEventListener("scroll", update);
      removeEventListener("resize", update);
    };
  }, []);
  return state;
}
