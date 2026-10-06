// The room overlay: a resizable side panel on desktop, a bottom sheet with
// three detents below 1024px (DESIGN 6.3, 6.11). Same parts in both.
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useExit } from "../lib/useExit";
import { freshFocus, useAppState } from "./appState";
import { ROOM_DEFAULT, clampWidth } from "./AppPage";
import { Composer } from "./Composer";
import { RoomHeader } from "./RoomHeader";
import { Stream } from "./Stream";
import { TimelineStrip } from "./Timeline";
import s from "./Room.module.css";

export function RoomPanel({ open, width, onResize }: { open: boolean; width: number; onResize: (w: number) => void }) {
  const { setRoomOpen } = useAppState();
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
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          setRoomOpen(false);
        }
      }}
    >
      <span
        className={s.resize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the room"
        onPointerDown={startResize}
        onDoubleClick={() => onResize(ROOM_DEFAULT)}
      />
      <RoomHeader />
      <Stream />
      <Composer />
    </aside>
  );
}

type Detent = "peek" | "half" | "full";
const DETENTS: Detent[] = ["peek", "half", "full"];
const heightOf = (d: Detent, vh: number) => (d === "peek" ? 132 : d === "half" ? vh * 0.55 : vh * 0.92);

export function RoomSheet() {
  const { roomOpen, setRoomOpen, picking, composer } = useAppState();
  const [detent, setDetent] = useState<Detent>("half");
  const [drag, setDrag] = useState<number | null>(null);
  const vv = useVisualViewport();
  const { mounted, leaving } = useExit(roomOpen, 180);

  useEffect(() => {
    if (roomOpen) setDetent("half");
  }, [roomOpen]);
  useEffect(() => {
    if (picking) setDetent("peek");
  }, [picking]);
  useEffect(() => {
    if (freshFocus(composer.focusAt)) setDetent("full");
  }, [composer.focusAt]);

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
    const move = (ev: PointerEvent) => {
      const now = performance.now();
      velocity = (ev.clientY - last.y) / Math.max(1, now - last.t);
      last = { y: ev.clientY, t: now };
      setDrag(Math.max(60, Math.min(vv.height * 0.95, h0 - (ev.clientY - y0))));
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
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
    >
      <div className={s.grab} onPointerDown={startDrag}>
        <span className={s.handle} />
        {!peek && <RoomHeader compact />}
      </div>
      {peek ? <Stream latestOnly /> : <Stream />}
      {!peek && <TimelineStrip />}
      <Composer compact={peek} onFocus={() => setDetent("full")} />
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
