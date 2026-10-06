import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { formatCallTime } from "@codecast/shared/entities";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { usePressOutside } from "../../hooks/usePressOutside";

// The call video's own controls, drawn over the picture in the page's type
// and colors, in the look of the cast player on published pages (a shade at
// the foot, an accent scrubber, frosted menus, controls that step aside while
// the film plays untouched).
//
// Two elements, two jobs. `el` is the picture shown (the room, or a screen
// over it): play, scrub and speed act on it, and the player keeps the room's
// file in step underneath. `room` carries every voice, so the sound controls
// act on it whichever picture is up; a screen file has no sound of its own.
//
// The scrubber spans the file shown, read in the CALL's clock (the clock of
// the transcript and of every `cl-42@12:34`), never the file's own.
//
// The fill moves every frame by writing its style directly, so a playing film
// renders this component once a second for the readout, and the player around
// it not at all.

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const RATE_KEY = "codecast:call-video-rate";
const IDLE_MS = 2400;

function storedRate(): number {
  try {
    const n = Number(localStorage.getItem(RATE_KEY));
    return (RATES as readonly number[]).includes(n) ? n : 1;
  } catch {
    return 1;
  }
}

const rateWords = (r: number) => `${r}×`;

export function CallVideoControls({
  boxRef,
  el,
  room,
  toCallMs,
  ready,
  soundBlocked,
  onUnblockSound,
}: {
  /** The picture's box: what fullscreen fills and where the pointer wakes the controls. */
  boxRef: RefObject<HTMLDivElement | null>;
  el: HTMLVideoElement | null;
  room: HTMLVideoElement | null;
  /** A second into `el`'s file, as a moment of the call. */
  toCallMs: (seconds: number) => number;
  /** The file shown has its metadata: until then the box holds its placeholder. */
  ready: boolean;
  soundBlocked: boolean;
  onUnblockSound: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [second, setSecond] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sound, setSound] = useState({ volume: 1, muted: false });
  const [rate, setRate] = useState(storedRate);
  const [menu, setMenu] = useState(false);
  const [full, setFull] = useState(false);
  const [awake, setAwake] = useState(true);
  const [hover, setHover] = useState<{ x: number; s: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const fillRef = useRef<HTMLSpanElement>(null);
  const bufRef = useRef<HTMLSpanElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePressOutside(menuRef, menu, () => setMenu(false), { escape: true });

  /** Draw the fill, the buffered run and the knob where `el` is. */
  const paint = () => {
    if (!el) return;
    const d = el.duration || 0;
    const p = d ? Math.min(1, el.currentTime / d) : 0;
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${p})`;
    if (knobRef.current) knobRef.current.style.left = `${p * 100}%`;
    const b = el.buffered;
    if (bufRef.current && d && b.length) bufRef.current.style.transform = `scaleX(${Math.min(1, b.end(b.length - 1) / d)})`;
  };

  // Follow the picture shown: its play state, length and place.
  useWatchEffect(() => {
    if (!el) return;
    const sync = () => {
      setPlaying(!el.paused);
      if (!el.paused) setStarted(true);
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setSecond(Math.floor(el.currentTime));
      paint();
    };
    sync();
    let frame = 0;
    const loop = () => {
      paint();
      frame = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      sync();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };
    const onPause = () => {
      cancelAnimationFrame(frame);
      sync();
    };
    const events: [string, () => void][] = [
      ["play", onPlay],
      ["pause", onPause],
      ["ended", onPause],
      ["timeupdate", sync],
      ["durationchange", sync],
      ["loadedmetadata", sync],
      ["progress", paint],
      ["seeked", sync],
    ];
    for (const [k, f] of events) el.addEventListener(k, f);
    if (!el.paused) onPlay();
    return () => {
      cancelAnimationFrame(frame);
      for (const [k, f] of events) el.removeEventListener(k, f);
    };
  }, [el]);

  // A speed holds across pictures and recordings: a fresh element starts at 1.
  useWatchEffect(() => {
    if (!el) return;
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  }, [el, rate]);

  useWatchEffect(() => {
    if (!room) return;
    const read = () => setSound({ volume: room.volume, muted: room.muted });
    read();
    room.addEventListener("volumechange", read);
    return () => room.removeEventListener("volumechange", read);
  }, [room]);

  useWatchEffect(() => {
    const read = () => setFull(!!boxRef.current && document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", read);
    return () => document.removeEventListener("fullscreenchange", read);
  }, []);

  // The controls step aside while the film plays and the pointer rests, and
  // come back on any movement over the picture.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = () => {
    setAwake(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setAwake(false), IDLE_MS);
  };
  useWatchEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const leave = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setAwake(false);
    };
    box.addEventListener("pointermove", wake);
    box.addEventListener("pointerdown", wake);
    box.addEventListener("focusin", wake);
    box.addEventListener("pointerleave", leave);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      box.removeEventListener("pointermove", wake);
      box.removeEventListener("pointerdown", wake);
      box.removeEventListener("focusin", wake);
      box.removeEventListener("pointerleave", leave);
    };
  }, []);
  const shown = !playing || awake || menu || dragging;

  const toggle = () => {
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };
  const seekTo = (s: number) => {
    if (!el || !duration) return;
    el.currentTime = Math.max(0, Math.min(duration - 0.05, s));
    paint();
  };
  const setRoom = (next: { volume?: number; muted?: boolean }) => {
    if (!room) return;
    if (next.volume !== undefined) room.volume = next.volume;
    if (next.muted !== undefined) room.muted = next.muted;
  };
  const pickRate = (r: number) => {
    setRate(r);
    setMenu(false);
    try {
      localStorage.setItem(RATE_KEY, String(r));
    } catch {}
  };
  const toggleFull = () => {
    const box = boxRef.current;
    if (!box) return;
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
    if (box.requestFullscreen) return void box.requestFullscreen().catch(() => {});
    // An iPhone fills the screen with a video element only, in its own player.
    (el as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
  };

  /** The second of the file under a pointer on the track. */
  const secondAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || !duration) return { x: 0, s: 0, w: 0 };
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    return { x, s: (x / r.width) * duration, w: r.width };
  };
  const onTrackDown = (e: React.PointerEvent) => {
    if (!duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const at = secondAt(e.clientX);
    setHover(at);
    seekTo(at.s);
  };
  const onTrackMove = (e: React.PointerEvent) => {
    const at = secondAt(e.clientX);
    setHover(at);
    if (dragging) seekTo(at.s);
  };
  const onTrackUp = (e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  // Keys, while focus is on the picture itself (a button keeps its own Space).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || !el) return;
    const step = (s: number) => seekTo(el.currentTime + s);
    const act: Record<string, () => void> = {
      " ": toggle,
      k: toggle,
      ArrowLeft: () => step(-5),
      ArrowRight: () => step(5),
      j: () => step(-10),
      l: () => step(10),
      m: () => setRoom({ muted: !sound.muted }),
      f: toggleFull,
      "<": () => pickRate(RATES[Math.max(0, RATES.indexOf(rate as (typeof RATES)[number]) - 1)]),
      ">": () => pickRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(rate as (typeof RATES)[number]) + 1)]),
    };
    const f = act[e.key];
    if (!f) return;
    e.preventDefault();
    wake();
    f();
  };

  if (!ready || !el) return null;
  const quiet = sound.muted || sound.volume === 0;

  return (
    <div
      className="call-controls absolute inset-0 outline-none"
      data-shown={shown || undefined}
      data-started={started || undefined}
      tabIndex={0}
      role="group"
      aria-label="Call video"
      onKeyDown={onKeyDown}
    >
      {/* The picture itself: a press plays or pauses, a double press fills the screen. */}
      <div className="absolute inset-0" onClick={toggle} onDoubleClick={toggleFull} aria-hidden="true" />
      <div className="call-controls-shade" aria-hidden="true" />
      {!started && (
        <button type="button" className="call-controls-big" onClick={toggle} aria-label="Play">
          <Play className="ml-1 h-7 w-7" fill="currentColor" strokeWidth={0} />
        </button>
      )}
      <div className="call-controls-bar">
        <div
          ref={trackRef}
          className="call-controls-track"
          data-drag={dragging || undefined}
          role="slider"
          aria-label="Where in the recording"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={second}
          aria-valuetext={formatCallTime(toCallMs(second))}
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerCancel={onTrackUp}
          onPointerLeave={() => !dragging && setHover(null)}
        >
          <span className="call-controls-rail">
            <span ref={bufRef} className="call-controls-buf" />
            <span ref={fillRef} className="call-controls-fill" />
          </span>
          <span ref={knobRef} className="call-controls-knob" />
          {hover && (
            <span className="call-controls-tip" style={{ left: Math.max(26, Math.min(hover.w - 26, hover.x)) }}>
              {formatCallTime(toCallMs(hover.s))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton onClick={toggle} label={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="h-[15px] w-[15px]" fill="currentColor" strokeWidth={0} /> : <Play className="h-[15px] w-[15px]" fill="currentColor" strokeWidth={0} />}
          </IconButton>
          {soundBlocked ? (
            <button type="button" onClick={onUnblockSound} className="call-controls-chip text-sol-violet">
              <VolumeX className="h-3.5 w-3.5" /> Tap for sound
            </button>
          ) : (
            <span className="call-controls-vol group/vol flex items-center">
              <IconButton onClick={() => setRoom({ muted: !sound.muted })} label={quiet ? "Unmute" : "Mute"} pressed={quiet}>
                {quiet ? <VolumeX className="h-[15px] w-[15px]" /> : <Volume2 className="h-[15px] w-[15px]" />}
              </IconButton>
              {/* No slider on a touch screen: a phone ignores a page's volume. */}
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={quiet ? 0 : sound.volume}
                onChange={(e) => setRoom({ volume: Number(e.currentTarget.value), muted: Number(e.currentTarget.value) === 0 })}
                aria-label="Volume"
                className="call-controls-range"
                style={{ ["--v" as string]: quiet ? 0 : sound.volume }}
              />
            </span>
          )}
          <span className="ml-2 select-none whitespace-nowrap font-mono text-[11.5px] tabular-nums text-white/90">
            {formatCallTime(toCallMs(second))}
            <span className="text-white/45"> / {formatCallTime(toCallMs(duration))}</span>
          </span>
          <span className="flex-1" />
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenu((m) => !m)}
              aria-haspopup="menu"
              aria-expanded={menu}
              aria-label={`Speed, ${rateWords(rate)}`}
              className={`call-controls-chip tabular-nums ${rate !== 1 ? "text-sol-violet" : ""}`}
            >
              {rateWords(rate)}
            </button>
            {menu && (
              <div className="call-controls-menu" role="menu" aria-label="Speed">
                <div className="px-2.5 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-white/40">Speed</div>
                {RATES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="menuitemradio"
                    aria-checked={r === rate}
                    onClick={() => pickRate(r)}
                    className="call-controls-menu-item"
                  >
                    <span>{r === 1 ? "Normal" : rateWords(r)}</span>
                    {r === rate && <span className="h-1.5 w-1.5 rounded-full bg-sol-violet" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <IconButton onClick={toggleFull} label={full ? "Exit full screen" : "Full screen"}>
            {full ? <Minimize2 className="h-[15px] w-[15px]" /> : <Maximize2 className="h-[15px] w-[15px]" />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function IconButton({ onClick, label, pressed, children }: { onClick: () => void; label: string; pressed?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} aria-pressed={pressed} title={label} className="call-controls-ic">
      {children}
    </button>
  );
}
