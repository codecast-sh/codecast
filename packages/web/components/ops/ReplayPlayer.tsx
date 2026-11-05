// The replay player: the recorded page (or the semantic view), its controls
// and scrubber, and the events rail beside it on one clock. See ReplayPage.tsx.
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { useInboxStore } from "../../store/inboxStore";
import { type ReplayPlayerMessage, replayWindowHolds } from "@codecast/shared/contracts/replayPlayer";
import type { ReplayEvent } from "@codecast/shared/contracts/replay";
import { ExternalLink, FastForward, Image as ImageIcon, ImageOff, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Pause, Play, X } from "lucide-react";
import { formatReplayTime, idleRanges, isFailure, primaryFailure, rageBursts } from "@codecast/shared/replay";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { eventIndexAt, isScrubberTick, outlineAt, replayLength, urlAt } from "./opsModel";
import { opsHref } from "./opsPaths";
import type { OpsReplay } from "./opsTypes";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ReplayPlayerIframe } from "./ReplayPlayerFrame";
import { useReplayPlayerChannel, useReplayPlayerLink } from "../../hooks/useReplayPlayer";
import {
  captureEndFrom,
  pathOf,
  playerImportedUntil,
  type RestHold,
  restLine,
  type RestQueued,
  restState,
  stageProblemText,
  vendorUrlAt,
  withRemoteAssets,
} from "./replayModel";
import { activityBins, describeEvent, isUserAction, selectorName, skipTarget, stepTo } from "./replayRail";
import {
  CONTROLS_PX,
  inBlocks,
  inkOf,
  RAIL_BLOCK,
  RAIL_MAX_PX,
  RAIL_MIN_PX,
  RAIL_W_KEY,
  readFlag,
  readSkip,
  SKIP_KEY,
  type Speed,
  SPEEDS,
  STAGE_PAD_PX,
  THEATER_KEY,
  URL_SETTLE_MS,
  useViewportFit,
  wordOf,
  writeFlag,
} from "./replayPlayerModel";
import { EventRail, RestStatus, SemanticStage, ShareMoment } from "./ReplayPlayerParts";

type PlayerProps = {
  replay: OpsReplay;
  /** Why the server is not reading the rest now, and until when (restHold). */
  hold?: RestHold | null;
  /** Ask the server again to read the rest of a long recording, when reading it stopped. */
  readRest?: () => void;
  /** The page asked the server to read the rest and it has not answered yet. */
  starting?: boolean;
  /** Where a cut copy waits for the sweep (restQueued). */
  queued?: RestQueued;
  /** The recording the source's import line names as read now (event_sources.replay_rest.reading), so this one's chain reads as queued when it is another. */
  restReading?: string | null;
  events: ReplayEvent[];
  /** The events are still being read: the page capture plays meanwhile, and the rail says so. */
  reading?: boolean;
  initialT: number | null;
  /** The recording in its vendor's own player, for the part the import does not hold. */
  vendor?: { href: string; name: string } | null;
  /** Where each linked issue first happens, marked on the scrubber. */
  issueMarks?: { t: number; short_id: string; title: string }[];
  /** Set to "play from here" for controls outside the player (the header's issue, the issue cards). */
  seekRef?: { current: ((t: number) => void) | null };
};

/**
 * The player proper: exported for its mount test (ops/__tests__/replayPlayer.mount.test.tsx).
 * Each recording gets its own player, so moving between recordings in the app opens the next one
 * at the time its address asks for, as a full load does.
 */
export function Player(props: PlayerProps) {
  return <RecordingPlayer key={props.replay._id} {...props} />;
}

function RecordingPlayer({ replay, events, reading = false, initialT, issueMarks = [], seekRef, vendor = null, readRest, starting = false, hold = null, queued, restReading = null }: PlayerProps) {
  // The capture can run past the last event (a page left open): the player says how long its clock runs once it is ready.
  const [captureMs, setCaptureMs] = useState(0);
  // Where the page capture itself ends (0 until the player says): what the import cut is read from when the row stores no reach.
  const [captureEnd, setCaptureEnd] = useState(0);
  const length = useMemo(() => Math.max(1, replayLength(events, replay.duration_ms), captureMs), [events, replay.duration_ms, captureMs]);
  const fit = useViewportFit();
  // Theater hides the events rail so the page gets the width; fullscreen gives the player the screen.
  const [theater, setTheater] = useState(() => readFlag(THEATER_KEY));
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useWatchEffect(() => {
    if (typeof document === "undefined") return;
    const on = () => setFullscreen(!!document.fullscreenElement && document.fullscreenElement === mainRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  // The rail's width, dragged from its left edge and kept for every recording; null is the layout's own width.
  const [railW, setRailW] = useState<number | null>(() => {
    try {
      const n = Number(localStorage.getItem(RAIL_W_KEY));
      return n >= RAIL_MIN_PX && n <= RAIL_MAX_PX ? n : null;
    } catch {
      return null;
    }
  });
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const main = mainRef.current;
    if (!main) return;
    e.preventDefault();
    const right = main.getBoundingClientRect().right;
    const cap = Math.min(RAIL_MAX_PX, Math.round(main.clientWidth * 0.5));
    let last = railW;
    const move = (ev: PointerEvent) => {
      last = Math.max(RAIL_MIN_PX, Math.min(cap, Math.round(right - ev.clientX)));
      setRailW(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        if (last) localStorage.setItem(RAIL_W_KEY, String(last));
      } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resetRail = () => {
    setRailW(null);
    try {
      localStorage.removeItem(RAIL_W_KEY);
    } catch {}
  };
  const toggleTheater = () => setTheater((v) => {
    writeFlag(THEATER_KEY, !v);
    return !v;
  });
  const toggleFullscreen = () => {
    const el = mainRef.current;
    if (!el || typeof document === "undefined") return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.().catch(() => {});
  };
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  useWatchEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setVh(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const avail = fullscreen ? vh : fit.height;
  const failure = useMemo(() => primaryFailure(events), [events]);
  const [t, setT] = useState(() => Math.min(length, initialT ?? (failure ? Math.max(0, failure.t - 3000) : 0)));
  // Where the imported copy stops, when the recording runs well past it; from there on nothing plays.
  const cut = useMemo(() => playerImportedUntil(replay, events[events.length - 1]?.t ?? 0, captureEnd), [replay, events, captureEnd]);
  const end = cut ?? length;
  // A time asked for past the import (a ?t, a seek into the rest) lands at the import's end, and the stage says so with the vendor's player at that time.
  const [pastCut, setPastCut] = useState<number | null>(null);
  // The time the address asked for, held until the reach is known: the player clamps its clock to what is imported, so `t` alone forgets it.
  const asked = useRef<number | null>(initialT);
  const restNow = useCoarseNow(15_000);
  const rest = restState(replay, restNow, restReading);
  useWatchEffect(() => {
    // The rest reached the time a person asked for: open the longer capture there and play.
    if (pastCut !== null && (cut === null || pastCut <= cut + 1000)) {
      const to = pastCut;
      setPastCut(null);
      if (domParts > stagedParts.current) {
        stagedParts.current = domParts;
        setT(to);
        setPlaying(true);
        setStageGen((g) => g + 1);
      } else playFrom(to);
      return;
    }
    const want = asked.current ?? t;
    if (cut !== null) asked.current = null;
    if (cut !== null && want > cut + 1000) seekTo(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the reach is known, and each time it grows
  }, [cut, replay.dom_chunks]);
  // The page capture grows as the rest of a long recording lands. The stage
  // opens again on the longer capture when the whole recording is in, or at
  // once when the person is waiting at the end of what is there.
  const domParts = replay.dom_chunks ?? 0;
  const [stageGen, setStageGen] = useState(0);
  const stagedParts = useRef(domParts);
  const atCut = pastCut !== null || (cut !== null && t >= cut - 2000);
  useWatchEffect(() => {
    if (domParts <= stagedParts.current) return;
    if (replay.import_rest && !atCut) return;
    stagedParts.current = domParts;
    setStageGen((g) => g + 1);
  }, [domParts, !!replay.import_rest, atCut]);
  // Opened before the events were read: once they are, an untouched player moves to just before the failure, as it would have opened.
  const placed = useRef(!reading || initialT !== null);
  useWatchEffect(() => {
    if (reading || placed.current) return;
    placed.current = true;
    if (failure && !playing && t < 1) seekTo(Math.max(0, failure.t - 3000));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the events land
  }, [reading, failure]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [skip, setSkip] = useState(readSkip);
  const idx = eventIndexAt(events, t);
  const outline = outlineAt(events, t);
  const url = urlAt(events, t, replay.url);
  const ticks = useMemo(() => events.filter(isScrubberTick), [events]);
  const idle = useMemo(() => idleRanges(events, end), [events, end]);
  const rage = useMemo(() => rageBursts(events), [events]);
  const bins = useMemo(() => activityBins(events, length, 120), [events, length]);
  const hasOutlines = useMemo(() => events.some((e) => e.type === "view"), [events]);

  // The page itself, when the recording kept it. Opened once, at the time the
  // page opened on; from then on it follows this page's clock.
  const stage = useReplayStage(replay, t, playing, speed, length, setT, setPlaying, setSpeed, (len, capEnd) => {
    setCaptureMs(len);
    setCaptureEnd(capEnd);
  }, avail ? avail - CONTROLS_PX : null, stageGen);
  const driven = stage.driven;

  // The capture ran past the stored length: the server reads the capture and keeps the longer length, so the list agrees.
  const lengthAsked = useRef<string | null>(null);
  useWatchEffect(() => {
    // Also once for a copy whose reach is not stored, so the list can mark a recording the import cut short.
    const unstored = replay.provider !== "sdk" && replay.captured_ms == null && (captureMs > 0 || captureEnd > 0);
    if ((!unstored && Math.max(captureMs, captureEnd) <= (replay.duration_ms ?? 0) + 1000) || lengthAsked.current === replay._id) return;
    lengthAsked.current = replay._id;
    useInboxStore.getState().checkReplayCaptureLength(replay._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per replay, when the capture says it is longer
  }, [captureMs, captureEnd, replay._id, replay.duration_ms, replay.captured_ms]);

  // Without the page, playback advances on animation frames by real elapsed
  // time, times the speed. With it, the player is the clock and its time
  // posts move this one (useReplayStage).
  useWatchEffect(() => {
    if (!playing || driven) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setT((cur) => {
        const next = cur + dt;
        if (next >= end) {
          setPlaying(false);
          return end;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end, driven]);

  /** Move to a time, paused unless `keepPlaying`: the scrubber, the rail and the keys all land here. */
  const seekTo = (to: number, keepPlaying = false) => {
    asked.current = null;
    if (cut !== null && to > cut + 1000) setPastCut(Math.min(length, to));
    else if (pastCut !== null) setPastCut(null);
    const next = Math.min(end, Math.max(0, to));
    if (!keepPlaying) setPlaying(false);
    setT(next);
    if (!keepPlaying) stage.send({ type: "pause" });
    stage.send({ type: "seek", t_ms: next, ...(keepPlaying && playing ? { play: true } : {}) });
  };
  /** Play from a time: what the issue controls outside the player press. */
  const playFrom = (to: number) => {
    const next = Math.min(end, Math.max(0, to));
    setT(next);
    setPlaying(true);
    stage.send({ type: "seek", t_ms: next, play: true });
  };
  if (seekRef) seekRef.current = playFrom;

  // A link to this same recording at another time (the address changes, the recording does not) moves the player there.
  // The address following the scrubber asks for where the player already is, so that echo moves nothing.
  const lastAsked = useRef(initialT);
  useWatchEffect(() => {
    if (initialT === lastAsked.current) return;
    lastAsked.current = initialT;
    if (initialT !== null && Math.abs(initialT - (pastCut ?? t)) > 1000) seekTo(initialT);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the address alone
  }, [initialT]);

  // Skip inactivity: while playing, an idle stretch is jumped to its end, on whichever clock runs.
  useWatchEffect(() => {
    if (!playing || !skip) return;
    const to = skipTarget(idle, t);
    // Idle to the end: nothing more happens, so playback ends there.
    if (to !== null) seekTo(to, to < end);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the clock alone
  }, [t, playing, skip, idle]);

  const togglePlay = () => {
    const from = t >= end - 50 ? 0 : t;
    if (from !== t) setT(from);
    setPastCut(null);
    const next = !playing || from !== t;
    setPlaying(next);
    if (from !== t) stage.send({ type: "seek", t_ms: from });
    stage.send({ type: next ? "play" : "pause" });
  };
  const pickSpeed = (s: Speed) => {
    setSpeed(s);
    stage.send({ type: "speed", speed: s });
  };
  const toggleSkip = () => {
    setSkip((v) => {
      try {
        localStorage.setItem(SKIP_KEY, v ? "0" : "1");
      } catch {}
      return !v;
    });
  };

  // The address follows the scrubber once it rests, so a copied URL opens here.
  useWatchEffect(() => {
    if (playing || typeof window === "undefined") return;
    const id = setTimeout(() => {
      // Waiting past the cut, the address keeps the time asked for, so a reload or a copied link still asks for it.
      const href = opsHref.replay(replay.short_id || replay._id, Math.round(pastCut ?? t));
      const target = new URL(href, window.location.origin);
      const cur = new URL(window.location.href);
      if (cur.searchParams.get("t") === target.searchParams.get("t")) return;
      cur.searchParams.set("t", target.searchParams.get("t") ?? "0");
      window.history.replaceState(window.history.state, "", `${cur.pathname}?${cur.searchParams.toString()}`);
    }, URL_SETTLE_MS);
    return () => clearTimeout(id);
  }, [t, pastCut, playing, replay.short_id, replay._id]);

  // Space plays and pauses; the arrows step between events, with Shift ten seconds; N and P walk
  // the failures, ] and [ what the person did; S toggles skipping, T theater, F fullscreen.
  const keys = useRef({ togglePlay, seekTo, t, toggleSkip, toggleTheater, toggleFullscreen });
  keys.current = { togglePlay, seekTo, t, toggleSkip, toggleTheater, toggleFullscreen };
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      const { togglePlay: toggle, seekTo: to, t: cur, toggleSkip: flip } = keys.current;
      const walk = (dir: 1 | -1, pick: (ev: ReplayEvent) => boolean) => {
        const hit = stepTo(events, cur, dir, pick);
        if (hit) to(hit.t);
      };
      if (e.key === " ") toggle();
      else if (e.key === "ArrowRight" && e.shiftKey) to(cur + 10_000);
      else if (e.key === "ArrowLeft" && e.shiftKey) to(cur - 10_000);
      else if (e.key === "ArrowRight") to(events.find((ev) => ev.t > cur + 1)?.t ?? end);
      else if (e.key === "ArrowLeft") to([...events].reverse().find((ev) => ev.t < cur - 1)?.t ?? 0);
      else if (e.key === "n") walk(1, isFailure);
      else if (e.key === "p") walk(-1, isFailure);
      else if (e.key === "]") walk(1, isUserAction);
      else if (e.key === "[") walk(-1, isUserAction);
      else if (e.key === "s") flip();
      else if (e.key === "t") keys.current.toggleTheater();
      else if (e.key === "f") keys.current.toggleFullscreen();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [events, end]);

  const railRef = useRef<HTMLDivElement>(null);
  const seek = (clientX: number) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r) return;
    seekTo(((clientX - r.left) / r.width) * length);
  };
  // On the focused scrubber, Page Up and Page Down move ten seconds, Home and End jump to the ends.
  const onScrubKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const to = e.key === "Home" ? 0 : e.key === "End" ? end : e.key === "PageUp" ? t - 10_000 : e.key === "PageDown" ? t + 10_000 : null;
    if (to === null) return;
    e.preventDefault();
    seekTo(to);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seek(e.clientX);
  };

  const pct = (ms: number) => `${(Math.min(length, Math.max(0, ms)) / length) * 100}%`;

  return (
    <div
      className="rp-main ops-player"
      ref={(el) => {
        mainRef.current = el;
        fit.ref(el);
      }}
      style={{ ...(fit.height ? { "--rp-fit": `${fit.height}px` } : {}), ...(railW ? { "--rp-rail-w": `${railW}px` } : {}) } as CSSProperties}
      data-rail-w={railW ? "true" : undefined}
      data-has-stage={stage.view ? "true" : "false"}
      data-sized={stage.box ? "true" : undefined}
      data-theater={theater ? "true" : undefined}
      data-fullscreen={fullscreen ? "true" : undefined}
    >
      <div className="rp-stagecol">
        <div className="rp-stagearea" ref={stage.areaRef} style={stage.box ? { height: stage.box.height + STAGE_PAD_PX } : undefined}>
          {stage.problem && (
            <div className="ops-stage-note rp-stage-note" role="status">
              <b>{stageProblemText(stage.problem)}</b>
              <span className="ops-dim">events still play</span>
              <span className="rp-stage-note-acts">
                {vendor && (
                  <a className="ops-btn" href={vendorUrlAt(vendor.href, t)} target="_blank" rel="noreferrer noopener">
                    Play at {formatReplayTime(t).replace(/\.\d$/, "")} in {vendor.name} <ExternalLink className="w-3 h-3" aria-hidden />
                  </a>
                )}
                <button type="button" className="ops-btn" onClick={stage.retry}>Try again</button>
              </span>
            </div>
          )}
          {pastCut !== null && cut !== null && (
            <div className="rp-past-cut" role="status">
              <span className="rp-past-cut-fact ops-num"><b>{formatReplayTime(pastCut).replace(/\.\d$/, "")}</b> not imported yet <span className="ops-dim">· {formatReplayTime(cut).replace(/\.\d$/, "")} of {formatReplayTime(length).replace(/\.\d$/, "")} imported</span></span>
              <RestStatus rest={rest} starting={starting} readRest={readRest} hold={hold} vendorName={vendor?.name ?? null} queued={queued} />
              {vendor && (
                <a className="ops-btn" data-tone="primary" href={vendorUrlAt(vendor.href, pastCut)} target="_blank" rel="noreferrer noopener">
                  Play at {formatReplayTime(pastCut).replace(/\.\d$/, "")} in {vendor.name} <ExternalLink className="w-3 h-3" aria-hidden />
                </a>
              )}
              <button type="button" className="rp-icon-btn" aria-label="Dismiss" onClick={() => setPastCut(null)}><X className="w-3.5 h-3.5" /></button>
            </div>
          )}
          {stage.view ?? <SemanticStage events={events} idx={idx} url={url} outline={outline?.outline ?? null} />}
        </div>
        <div className="rp-controls">
          <div ref={railRef} className="ops-scrub rp-scrub" onPointerDown={onPointerDown} onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)} role="slider" tabIndex={0} onKeyDown={onScrubKey} aria-label="Position" aria-valuemin={0} aria-valuemax={length} aria-valuenow={Math.round(t)} aria-valuetext={`${formatReplayTime(t)} of ${formatReplayTime(length)}`}>
            <div className="rp-activity" aria-hidden>
              {bins.map((b, i) => (b > 0 ? <i key={i} style={{ left: `${(i / bins.length) * 100}%`, width: `${100 / bins.length}%`, height: `${Math.max(12, b * 100)}%` }} /> : null))}
            </div>
            {inBlocks(idle, RAIL_BLOCK).map((block, b) => (
              <Fragment key={`ib${b}`}>
                {block.map((r, k) => (
                  <span key={k} className="rp-idle" style={{ left: pct(r.from), width: `calc(${pct(r.to)} - ${pct(r.from)})` }} title={`Idle ${formatReplayTime(r.to - r.from).replace(/\.\d$/, "")}${skip ? ", skipped" : ""}`} />
                ))}
              </Fragment>
            ))}
            {/* In blocks, as the rail's rows are (RAIL_BLOCK): a long recording has thousands of ticks. */}
            {inBlocks(ticks, RAIL_BLOCK).map((block, b) => (
              <Fragment key={`tb${b}`}>
                {block.map((e, k) => (
                  <span key={k} className="ops-scrub-tick" data-kind={isFailure(e) ? "fail" : e.type} style={{ left: pct(e.t), background: inkOf(e) }} title={`${formatReplayTime(e.t)} ${wordOf(e)}: ${describeEvent(e)}`} />
                ))}
              </Fragment>
            ))}
            {rage.map((r, i) => (
              <span key={`rage${i}`} className="rp-rage-tick" style={{ left: pct(r.t) }} title={`${formatReplayTime(r.t)} rage click: ${r.clicks} clicks on ${r.label || selectorName(r.selector)}`} />
            ))}
            {issueMarks.map((m) => (
              <span key={`issue${m.short_id}`} className="rp-issue-tick" style={{ left: pct(m.t) }} title={`${formatReplayTime(m.t)} ${m.short_id}: ${m.title}`} />
            ))}
            {cut !== null && (
              <span className="rp-cut" data-state={starting ? "starting" : rest?.elsewhere ? "queued" : rest?.state ?? "none"} style={{ left: pct(cut), width: `calc(100% - ${pct(cut)})` }} title={`${formatReplayTime(cut).replace(/\.\d$/, "")} of ${formatReplayTime(length).replace(/\.\d$/, "")} imported · ${restLine(rest, hold, starting, vendor?.name ?? "the vendor", restNow, queued).text}`} />
            )}
            <div className="ops-scrub-rail" />
            <div className="ops-scrub-fill" style={{ width: pct(t) }} />
            <div className="ops-scrub-head" style={{ left: pct(t) }} />
          </div>
          <div className="ops-player-bar rp-bar">
            <button type="button" className="ops-btn rp-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
            <span className="ops-mono ops-num text-[12px] whitespace-nowrap rp-clock">{formatReplayTime(t)} <span className="ops-dim">/ {formatReplayTime(length)}</span></span>
            <div className="ops-seg rp-speeds" role="group" aria-label="Speed">
              {SPEEDS.map((s) => (
                // Pressing the speed already on moves to the next one, so the control still works where only the current speed fits.
                <button key={s} type="button" data-on={s === speed ? "true" : undefined} aria-pressed={s === speed} onClick={() => pickSpeed(s === speed ? SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] : s)}>{s}x</button>
              ))}
            </div>
            <button type="button" className="rp-toggle" aria-pressed={skip} data-on={skip ? "true" : undefined} onClick={toggleSkip} title="Jump over stretches where nothing happens">
              <FastForward className="w-3 h-3" aria-hidden /> <span className="rp-toggle-word">Skip idle</span>
            </button>
            <span className="ops-dim text-[11px] truncate ops-mono flex-1 min-w-0 rp-bar-path" title={url ?? undefined}>{url ? pathOf(url) : ""}</span>
            {stage.size && <span className="ops-dim text-[11px] ops-num whitespace-nowrap rp-viewport" title="The recorded window">{stage.size.width}×{stage.size.height}</span>}
            {stage.remoteAssets && (
              <button type="button" className="rp-icon-btn" aria-pressed={stage.remoteAssets.on} data-on={stage.remoteAssets.on ? "true" : undefined} onClick={stage.remoteAssets.toggle} aria-label={stage.remoteAssets.on ? "Stop loading the page's images" : "Load the page's images"} title={stage.remoteAssets.on ? "Images and fonts load from the sites the page names. Press to stop." : "Load images and fonts from the sites the page names (they see that you opened it)"}>
                {stage.remoteAssets.on ? <ImageIcon className="w-3.5 h-3.5" /> : <ImageOff className="w-3.5 h-3.5" />}
              </button>
            )}
            <ShareMoment replay={replay} t={t} />
            <button type="button" className="rp-icon-btn" aria-pressed={theater} data-on={theater ? "true" : undefined} onClick={toggleTheater} aria-label={theater ? "Show events" : "Hide events"} title={theater ? "Show events (T)" : "Hide events (T)"}>
              {theater ? <PanelRightOpen className="w-3.5 h-3.5" /> : <PanelRightClose className="w-3.5 h-3.5" />}
            </button>
            <button type="button" className="rp-icon-btn" aria-pressed={fullscreen} onClick={toggleFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}>
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
          <div className="rp-keys ops-dim" aria-hidden>
            <span><KeyCap size="xs">Space</KeyCap> play</span>
            <span><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap> step</span>
            <span><KeyCap size="xs">N</KeyCap><KeyCap size="xs">P</KeyCap> failure</span>
            <span><KeyCap size="xs">[</KeyCap><KeyCap size="xs">]</KeyCap> action</span>
            <span><KeyCap size="xs">S</KeyCap> skip idle</span>
            <span><KeyCap size="xs">T</KeyCap> theater</span>
            <span><KeyCap size="xs">F</KeyCap> fullscreen</span>
          </div>
        </div>
      </div>
      {!theater && (reading ? (
        <aside className="rp-rail rp-rail-reading" aria-label="Events" aria-busy="true">
          <span className="rp-wait-bar" aria-hidden />
          <span className="ops-quiet">Reading events</span>
        </aside>
      ) : (
        <EventRail events={events} t={t} hasOutlines={hasOutlines} outline={outline} onSeek={(at) => seekTo(at)}>
          <div className="rp-rail-grip" role="separator" aria-orientation="vertical" aria-label="Resize events" title="Drag to resize; double-click for the default width" onPointerDown={onGripDown} onDoubleClick={resetRail} />
        </EventRail>
      ))}
    </div>
  );
}

const NO_SIZE = { width: 16, height: 10, below: 0 };

/** How long after a seek a stale time post is ignored, and how far from the asked time the player's own echo may land. */
const SEEK_SETTLE_MS = 300;
const SEEK_ECHO_SLACK_MS = 50;
/** How close to a stretch's end playback opens the next one. */
const STRETCH_LEAD_MS = 400;

/** The largest box of a page's shape that fits the area: the recorded page fills the space without spilling past the controls. */
function fitBox(area: { width: number; height: number } | null, page: { width: number; height: number }): { width: number; height: number } | null {
  if (!area || area.width <= 0 || area.height <= 0) return null;
  const scale = Math.min(area.width / page.width, area.height / page.height);
  return { width: Math.max(1, Math.floor(page.width * scale)), height: Math.max(1, Math.floor(page.height * scale)) };
}

/**
 * The recorded page, when the replay kept its capture: the isolated player
 * with its own bar hidden, opened at the time the page opened on. Until it
 * says ready the page keeps its own clock; once it does, it is told where
 * this page stands (time, playing, speed), and from then on its time posts
 * are the clock. If it cannot play (an expired capture, a capture with
 * nothing to draw), it says why in one line and the semantic view goes on as
 * it would without a capture.
 */
function useReplayStage(
  replay: OpsReplay,
  t: number,
  playing: boolean,
  speed: number,
  length: number,
  setT: (t: number) => void,
  setPlaying: (p: boolean) => void,
  setSpeed: (s: Speed) => void,
  /** The player's clock length and where its capture ends (0 when it cannot say; captureEndFrom). */
  setCaptureMs: (lengthMs: number, captureEndMs: number) => void,
  /** The tallest the stage may be (the window less the controls); null until measured. */
  maxStageH: number | null = null,
  /** Raised to open the stage again on a capture that grew (a long recording's rest landed); it opens where the clock stands. */
  gen = 0,
) {
  const hasDom = (replay.dom_chunks ?? 0) > 0;
  const [openedAt] = useState(t);
  // A long capture plays a stretch at a time (replayDomWindow): leaving the stretch, by playing past it or seeking out of it, opens the player again there.
  // A new link opens where the clock stands; once ready it is told whether to play (the ready handler below).
  const [hop, setHop] = useState({ n: 0, t: 0 });
  const link = useReplayPlayerLink(hasDom ? replay._id : null, hasDom, { t_ms: gen > 0 || hop.n > 0 ? t : openedAt, controls: false }, gen + hop.n);
  const win = link.state === "ready" ? link.window : null;
  const [size, setSize] = useState<{ width: number; height: number; below: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page's images and fonts on other sites: the player draws an opt-in strip under the page for them, which the stage
  // clips (the frame runs past the stage's bottom by its height); the bar's image chip asks for them instead, on this view only.
  const [remoteAssets, setRemoteAssets] = useState<{ offered: boolean; on: boolean }>({ offered: false, on: false });
  const frameUrl = link.state === "ready" ? (remoteAssets.on ? withRemoteAssets(link.url) : link.url) : null;
  const [area, setArea] = useState<{ width: number; height: number } | null>(null);
  const areaObserver = useRef<ResizeObserver | null>(null);
  const areaRef = (el: HTMLDivElement | null) => {
    areaObserver.current?.disconnect();
    areaObserver.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setArea((prev) => (prev && Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1 ? prev : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    areaObserver.current = ro;
  };
  const here = useRef({ t, playing, speed });
  here.current = { t, playing, speed };
  const hopping = useRef<number | null>(null);
  // A new stretch is loading: the stage says so until its player is ready, rather than showing a blank page.
  const [reloading, setReloading] = useState(false);
  const hopTo = (to: number) => {
    if (hopping.current !== null && Math.abs(hopping.current - to) < 1000) return;
    hopping.current = to;
    setReloading(true);
    setT(Math.min(length, Math.max(0, to)));
    setHop((h) => ({ n: h.n + 1, t: Math.max(0, Math.round(to)) }));
  };
  /** Playing into the stretch's end: open the next one where it ends, still playing. */
  const atStretchEnd = (at: number, isPlaying: boolean) => {
    if (!win || win.end_ms === null || !isPlaying || at < win.end_ms - STRETCH_LEAD_MS) return false;
    hopTo(win.end_ms);
    return true;
  };
  // A time post the player queued before this page's seek can land after it
  // and pull the scrubber back for a beat. For a moment after a seek only the
  // player's echo of the seek itself (at the asked time) is followed.
  const lastSeek = useRef<{ t_ms: number; at: number } | null>(null);
  const channel = useReplayPlayerChannel(link.state === "ready" ? link.origin : null, (msg: ReplayPlayerMessage) => {
    if (msg.type === "ready") {
      setSize({ width: msg.width, height: msg.height, below: msg.below_px ?? 0 });
      if ((msg.below_px ?? 0) > 0 && !remoteAssets.offered) setRemoteAssets((r) => ({ ...r, offered: true }));
      // A stretch ends where its chunks do, not where the capture does: only a whole capture says where the import stopped.
      if (msg.duration_ms > 0) setCaptureMs(msg.duration_ms, win && win.end_ms !== null ? 0 : captureEndFrom(msg, replay.duration_ms));
      setError(null);
      hopping.current = null;
      setReloading(false);
      const cur = here.current;
      // The person moved out of this stretch while it loaded.
      if (!replayWindowHolds(win, cur.t) && Math.abs(cur.t - hop.t) > 2000) return hopTo(cur.t);
      if (cur.speed !== 1) channel.send({ type: "speed", speed: cur.speed });
      channel.send({ type: "seek", t_ms: cur.t, ...(cur.playing ? { play: true } : {}) });
    } else if (msg.type === "size") {
      setSize((prev) => (prev ? { ...prev, width: msg.width, height: msg.height } : prev));
    } else if (msg.type === "time") {
      const sought = lastSeek.current;
      if (sought && Date.now() - sought.at < SEEK_SETTLE_MS && Math.abs(msg.t_ms - sought.t_ms) > SEEK_ECHO_SLACK_MS) return;
      setT(Math.min(length, Math.max(0, msg.t_ms)));
      if (atStretchEnd(msg.t_ms, msg.playing || here.current.playing)) return;
      setPlaying(msg.playing);
    } else if (msg.type === "state") {
      // The stretch's player stops at its last event; the recording goes on in the next stretch.
      if (!msg.playing && atStretchEnd(here.current.t, here.current.playing)) return;
      setPlaying(msg.playing);
      if ((SPEEDS as readonly number[]).includes(msg.speed)) setSpeed(msg.speed as Speed);
    } else if (msg.type === "error") {
      setError(msg.message);
    }
  });
  const driven = link.state === "ready" && size !== null && error === null && !reloading;
  const send = (cmd: Parameters<typeof channel.send>[0]) => {
    if (!driven) return;
    if (cmd.type === "seek" && !replayWindowHolds(win, cmd.t_ms)) return hopTo(cmd.t_ms);
    if (cmd.type === "seek") lastSeek.current = { t_ms: cmd.t_ms, at: Date.now() };
    channel.send(cmd);
  };
  // The stage takes the area's whole width and only the height the page's shape needs, up to what
  // the window leaves; the area then shrinks to it, so a wide capture has no empty band above and below.
  const box = fitBox(area && maxStageH ? { width: area.width, height: Math.max(160, maxStageH - STAGE_PAD_PX) } : area, size ?? NO_SIZE);

  const problem = link.state === "failed" ? link.error : error;
  /** Load the page's remote images and fonts, or stop: the frame reloads where the clock stands (its ready handler seeks there). */
  const toggleRemoteAssets = () => {
    setReloading(true);
    setRemoteAssets((r) => ({ ...r, on: !r.on }));
  };
  /** Open the player again where the clock stands (a lapsed link, a load that failed). */
  const retry = () => {
    setError(null);
    hopping.current = null;
    setReloading(true);
    setHop((h) => ({ n: h.n + 1, t: here.current.t }));
  };
  let view: ReactNode = null;
  if (!problem && (link.state === "opening" || link.state === "ready")) {
    // The box keeps the page's shape inside the area; whatever the player
    // draws below the page (its remote-assets strip) runs past the box's bottom and is clipped.
    view = (
      <div className="ops-stage rp-stage" style={{ overflow: "hidden", ...(box ? { width: box.width, height: box.height } : { width: "100%", aspectRatio: `${(size ?? NO_SIZE).width} / ${(size ?? NO_SIZE).height}` }) }}>
        {frameUrl && (
          <ReplayPlayerIframe frameRef={channel.frameRef} url={frameUrl} title={`The page recorded in ${replay.short_id}`} style={{ position: "absolute", left: 0, top: 0, width: "100%", height: `calc(100% + ${size?.below ?? 0}px)`, opacity: size && !reloading ? 1 : 0 }} />
        )}
        {(!size || link.state === "opening" || reloading) && <div className="ops-stage-wait ops-quiet">{hop.n > 0 ? `Loading from ${formatReplayTime(hop.t).replace(/\.\d$/, "")}…` : "Loading the page capture…"}</div>}
      </div>
    );
  }
  return { driven, send, view: problem ? null : view, problem, retry, size: size ? { width: size.width, height: size.height } : null, areaRef, box: !problem && view && maxStageH ? box : null, remoteAssets: remoteAssets.offered ? { on: remoteAssets.on, toggle: toggleRemoteAssets } : null };
}
