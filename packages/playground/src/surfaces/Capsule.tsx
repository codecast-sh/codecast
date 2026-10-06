// The capsule (DESIGN 6.2): who is here, the timeline, and "Change it". It
// sits in a corner, moves only when someone drags it, snaps to the nearest
// corner on release, and tucks into a tab when dragged past a side edge.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { plural } from "../lib/format";
import { load, save } from "../lib/storage";
import { useMedia } from "../lib/useMedia";
import { Face } from "../ui/Face";
import { FaceStack } from "../ui/FaceStack";
import { SpeechGlyph, TimelineIcon } from "../ui/icons";
import { Keys } from "../ui/Keys";
import { useAppState } from "./appState";
import s from "./Capsule.module.css";

type Corner = "tl" | "tr" | "bl" | "br";
type Placement = { corner: Corner; tucked: null | { side: "left" | "right"; y: number } };

const KEY = "clayground.capsule";
const HINT_KEY = "clayground.hinted";
const TUCK_PAST = 40;

export function Capsule({ errorDot, onTimeline }: { errorDot: boolean; onTimeline: () => void }) {
  const { app, here, stream, composer, setRoomOpen } = useAppState();
  const narrow = useMedia("(max-width: 767px)");
  const margin = narrow ? 12 : 20;
  const [place, setPlace] = useState<Placement>(() => load<Placement>(KEY, { corner: "br", tucked: null }));
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [viewport, setViewport] = useState({ w: innerWidth, h: innerHeight });
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [place.tucked]);
  useEffect(() => {
    const onResize = () => setViewport({ w: innerWidth, h: innerHeight });
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);

  const commit = (p: Placement) => {
    setPlace(p);
    save(KEY, p);
  };

  // Most recent speaker first, then everyone else in arrival order.
  const people = useMemo(() => {
    const spoke = new Map<string, number>();
    for (const m of stream.messages) if (m.author) spoke.set(m.author.id, m.created_at);
    return [...here.people].sort((a, b) => (spoke.get(b.id) ?? 0) - (spoke.get(a.id) ?? 0));
  }, [here.people, stream.messages]);

  // The faces hop once when a version goes live (the celebration).
  const firstLive = useRef(app.live_version);
  const hop = app.live_version > firstLive.current ? app.live_version : 0;

  const hint = useFirstVisitHint(here.people.length);

  const corner = cornerXY(place.corner, size, viewport, margin);
  const pos = drag ?? corner;

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    hint.dismiss();
    const rect = box.current!.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setDrag({ x: ev.clientX - dx, y: ev.clientY - dy });
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      setDrag(null);
      const x = ev.clientX - dx;
      const y = ev.clientY - dy;
      const yMid = Math.min(Math.max(y, margin), innerHeight - size.h - margin);
      if (x < -TUCK_PAST) return commit({ corner: place.corner, tucked: { side: "left", y: yMid } });
      if (x + size.w > innerWidth + TUCK_PAST) return commit({ corner: place.corner, tucked: { side: "right", y: yMid } });
      commit({ corner: nearestCorner(x + size.w / 2, y + size.h / 2), tucked: null });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  if (place.tucked) {
    const { side, y } = place.tucked;
    return (
      <button
        className={`${s.tab} ${s[side]}`}
        style={{ top: Math.min(y, viewport.h - 100) }}
        onClick={() => commit({ corner: `${y < viewport.h / 2 ? "t" : "b"}${side === "left" ? "l" : "r"}` as Corner, tucked: null })}
        aria-label={`${plural(here.people.length, "person", "people")} here. Show the capsule`}
      >
        {people[0] && <Face person={people[0]} size={24} />}
        <span className={s.count}>{here.people.length}</span>
      </button>
    );
  }

  const openRoom = () => {
    hint.dismiss();
    setRoomOpen(true);
  };

  return (
    <>
      <div
        ref={box}
        className={`${s.capsule} ${drag ? s.dragging : ""}`}
        style={{ left: pos.x, top: pos.y, visibility: size.w ? "visible" : "hidden" }}
        onPointerDown={hint.dismiss}
      >
        <span className={s.grip} onPointerDown={startDrag} aria-hidden title="Drag me">
          <i /><i /><i /><i /><i /><i />
        </span>
        <button className={s.faces} onClick={openRoom} aria-label={`${plural(here.people.length, "person", "people")} here. Open the room`}>
          <FaceStack people={people} max={narrow ? 3 : 4} size={30} typing={here.typing} hop={hop} />
        </button>
        <button className={s.tool} onClick={onTimeline} aria-label="Timeline" title="Timeline">
          <TimelineIcon />
          {errorDot && <i className={s.errorDot} aria-label="The app hit an error" />}
        </button>
        <button className={s.change} onClick={composer.focus}>
          <SpeechGlyph />
          Change it
          {!narrow && <Keys keys={["/"]} />}
        </button>
      </div>
      {hint.show && size.w > 0 && (
        <div className={s.hint} style={hintPosition(place.corner, corner, size, viewport)} onClick={hint.dismiss} role="note">
          {here.people.length} people are in here. Open the room to watch them or change the app.
          <small>
            Drag it anywhere. <Keys keys={["/"]} /> opens the room.
          </small>
        </div>
      )}
    </>
  );
}

function cornerXY(c: Corner, size: { w: number; h: number }, vp: { w: number; h: number }, m: number) {
  return { x: c[1] === "l" ? m : vp.w - size.w - m, y: c[0] === "t" ? m : vp.h - size.h - m };
}

function nearestCorner(cx: number, cy: number): Corner {
  return `${cy < innerHeight / 2 ? "t" : "b"}${cx < innerWidth / 2 ? "l" : "r"}` as Corner;
}

function hintPosition(c: Corner, at: { x: number; y: number }, size: { w: number; h: number }, vp: { w: number; h: number }) {
  const horizontal = c[1] === "l" ? { left: at.x } : { right: vp.w - at.x - size.w };
  const vertical = c[0] === "t" ? { top: at.y + size.h + 14 } : { bottom: vp.h - at.y + 14 };
  return { ...horizontal, ...vertical };
}

/** Shown the first time this device opens any app with 2+ people here; gone
 *  on any click, on drag, or after 10s, and never again. */
function useFirstVisitHint(count: number) {
  const [state, setState] = useState<"unseen" | "showing" | "done">(() => (load(HINT_KEY, false) ? "done" : "unseen"));
  useEffect(() => {
    if (state !== "unseen" || count < 2) return;
    setState("showing");
    save(HINT_KEY, true);
  }, [state, count]);
  useEffect(() => {
    if (state !== "showing") return;
    const t = setTimeout(() => setState("done"), 10_000);
    const click = () => setState("done");
    addEventListener("pointerdown", click, { once: true });
    return () => {
      clearTimeout(t);
      removeEventListener("pointerdown", click);
    };
  }, [state]);
  return { show: state === "showing", dismiss: () => state === "showing" && setState("done") };
}
