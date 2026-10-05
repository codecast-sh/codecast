import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AlertTriangle, Loader2, MonitorUp, RotateCw, Trash2, Users, Volume2, VolumeX } from "lucide-react";
import { recordingFailureWords, recordingSubject, type CallView } from "@codecast/shared/contracts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { usePressOutside } from "../../hooks/usePressOutside";
import { useStableMediaSrcs } from "../../hooks/useStableMediaSrcs";
import {
  CALL_VIDEO_LOADING,
  callMsOf,
  fileSecondsAt,
  filmedSpans,
  noVideoWords,
  playableFiles,
  screenChips,
  videoAt,
  type CallVideoFile,
  type CallVideoNotice,
} from "../../lib/calls/callVideo";
import { isMediaDenial } from "../../lib/calls/mediaDenial";
import { RecordingMark } from "./RecordingMark";
import { ParticipantTag } from "./GuestTag";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { formatCallTime } from "@codecast/shared/entities";
import "./callVideoPlayer.css";

// A call's video on its page, kept in step with the transcript the way the
// recording's audio always was: a line clicked seeks the picture there, and
// the line being said lights as it plays. Store free, so the public share page
// plays the same thing from its own query.
//
// WHAT PLAYS. A press of Record makes a run: the room's file (faces, the share
// in its layout, everyone's audio) and a file for every screen shared during
// it, at the screen's own size and with no sound. The room's file is the one a
// person watches; a screen file is the view to switch to when the text on the
// share is what matters. Switching keeps the room's file playing underneath,
// unseen, for the voices, and the screen follows it frame for frame (or it
// leads and the room follows, once the person drives the screen's own
// controls). When the share ends the view falls back to the room at the same
// moment, still playing.
//
// THE CLOCK. The native controls count from the file's own start, which is
// not the call's (Record was pressed some minutes in). So the toolbar says
// where in the CALL the picture is, in the clock the transcript and every
// `cl-42@12:34` reference use, and the browser's own time readouts are hidden
// (callVideoPlayer.css): one picture, one clock. The browser's download,
// speed and picture-in-picture menus are left out too: they are not this
// page's controls, and a downloaded file leaves the call's access rules
// behind.
//
// LOADING. Until a file's metadata arrives the box pulses the way the page's
// placeholder does (CallVideoPlaceholder) and the browser draws nothing: no
// spinner on black, no control bar at 0:00. Under load that can last a while,
// and the move from placeholder to picture should be the only change seen.
//
// URLS. A file's URL changes under it (a presigned one every window, the share
// page's redirect signs a short one per request), and a video element handed a
// new src starts over. So each file keeps the URL it was first loaded with and
// moves only when the element refuses it (useStableMediaSrcs), resuming at the
// same moment.
//
// SOUND. A screen file has no audio track, and a browser draws no volume
// control on a video without one, while the room's file that carries the
// voices is playing unseen with its controls off. So the toolbar has its own
// mute and volume while a screen is shown, and they act on the room's file.
// A phone browser (iOS Safari above all) plays sound only from a play() made
// inside a tap on that element, and the room's file is started by the
// screen's play, not by a tap: the browser refuses, and the screen would run
// silent with nothing saying why. So a refused play of the room's file turns
// the mute button into "Tap for sound", whose tap is the gesture the browser
// wants. A phone also ignores a page's volume, so there the toolbar offers
// mute alone.
//
// ONE SHAPE. The picture's box is 16:9 whatever the file's own shape, capped
// by the space the page leaves after its header and a floor for the thread
// (and never below a size worth watching), and the page's placeholder is the
// same box (CallVideoPlaceholder): the transcript under it never moves when
// the metadata lands or the view switches to a screen of another shape.
//
// ONE CALL, SEVERAL RECORDINGS. Record pressed twice makes two runs with a gap
// between. Playing to the end of one carries on into the next, the way the
// transcript does.

/** The picture's box: one shape for the player and for whatever holds its
 *  place before it mounts. */
// The cap leaves room for the page's header, the toolbar and the thread's
// floor of about nine lines (callMedia.css) without the page scrolling.
const CALL_VIDEO_BOX = "call-video-box relative aspect-video max-h-[min(46vh,calc(100dvh-520px))] min-h-[180px] w-full overflow-hidden bg-black";
/** The browser menus that are not this page's (THE CLOCK above). */
const NATIVE_MENUS_OFF = "nodownload noplaybackrate noremoteplayback";
const CALL_VIDEO_FRAME = "dark overflow-hidden rounded-lg bg-black ring-1 ring-sol-border/30";
const CALL_VIDEO_BAR = "flex min-h-[34px] flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-white/[0.06] bg-sol-base03 px-2.5 py-1.5 font-mono text-[11px] text-sol-text-muted";

/** The player's place, held before there is anything to play (the thread
 *  says the call was filmed and the recordings have not answered yet), so the
 *  words under it do not jump when the video lands. */
export function CallVideoPlaceholder() {
  // The same breath the player shows while its file loads, so the page goes
  // placeholder, loading, picture with nothing jumping or flashing between.
  return (
    <div className={CALL_VIDEO_FRAME} aria-hidden="true">
      <div className={CALL_VIDEO_BOX}>
        <div className={CALL_VIDEO_LOADING} />
      </div>
      <div className={CALL_VIDEO_BAR} />
    </div>
  );
}

export type CallVideoHandle = {
  /** Show the call at `callMs`. False when no video covers that moment.
   *  `view` (a link's `view=screen`) switches to the screen it names when
   *  one covers the moment, the room playing under it; else the room. */
  seek: (callMs: number, opts?: { play?: boolean; view?: CallView | null }) => boolean;
};

export function CallVideoPlayer({
  files,
  callStartedAt,
  handleRef,
  onTime,
  actions,
  missedMs = null,
  onJump,
  refreshing = false,
  onViewPick,
  className = "",
}: {
  files: readonly CallVideoFile[];
  callStartedAt: number;
  handleRef?: RefObject<CallVideoHandle | null>;
  /** Where in the call the picture is, as it plays or is moved. */
  onTime?: (callMs: number, playing: boolean) => void;
  /** The host's own controls on the toolbar (copy a moment, delete).
   *  `callMs` is the toolbar's clock, which moves once a second; `now()`
   *  reads the exact moment, for whatever a press copies. */
  actions?: (at: { callMs: number; file: CallVideoFile; now: () => number }) => ReactNode;
  /** A moment the page asked for that no video shows (a line clicked, a
   *  `?t=` link): said under the picture until the next seek that lands. */
  missedMs?: number | null;
  /** Go to a moment the player offers (the nearest video, under a moment
   *  without): the host's own seek, so its lit line and its notice move
   *  with it. Without one the player seeks itself. */
  onJump?: (callMs: number) => void;
  /** The files' URLs are being signed again (the page slept past them): a
   *  refused element is waiting for the next ones, not dead. */
  refreshing?: boolean;
  /** The reader picked a view (a screen, or back to the room): the host
   *  writes it to its address, so a reload or a copied address opens on the
   *  picture that was up. Only a pick: a view a link landed on is already
   *  in the address. */
  onViewPick?: (view: CallView | null) => void;
  className?: string;
}) {
  const playable = useMemo(() => playableFiles(files), [files]);
  const spans = useMemo(() => filmedSpans(files, callStartedAt), [files, callStartedAt]);
  // What can lead: the room's files, or a screen file in a run whose room
  // file was lost (better a silent screen than nothing).
  const leads = useMemo(() => {
    const rooms = playable.filter((f) => f.kind === "composite");
    const roomRuns = new Set(rooms.map((f) => f.run_id ?? f.id));
    return [...rooms, ...playable.filter((f) => f.kind === "screen" && !roomRuns.has(f.run_id ?? f.id))].sort(
      (a, b) => a.started_at! - b.started_at!,
    );
  }, [playable]);

  const [mainId, setMainId] = useState<string | null>(null);
  const [screenId, setScreenId] = useState<string | null>(null);
  const main = leads.find((f) => f.id === mainId) ?? leads[0] ?? null;
  const screen = screenId ? (playable.find((f) => f.id === screenId) ?? null) : null;
  const [callMs, setCallMs] = useState(() => (main ? callMsOf(main, callStartedAt, 0) : 0));

  const mainEl = useRef<HTMLVideoElement>(null);
  const screenEl = useRef<HTMLVideoElement>(null);
  // Where a file should open once its element has loaded: keyed by file,
  // since a switch can move the room and the screen at once.
  const pending = useRef(new Map<string, { seconds: number; play: boolean }>());
  // The URL each file plays from (see URLS above).
  const media = useStableMediaSrcs(files);
  // Elements whose metadata has arrived, by element key (LOADING above).
  const [loadedKeys, setLoadedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const noteLoaded = (f: CallVideoFile) => {
    const key = media.keyOf(f);
    setLoadedKeys((prev) => (prev.has(key) ? prev : new Set([...prev, key])));
  };
  const srcOf = (f: CallVideoFile) => media.srcOf(f);

  const driver = () => (screen && screenEl.current ? { el: screenEl.current, file: screen } : main && mainEl.current ? { el: mainEl.current, file: main } : null);
  const follower = () => (screen && screenEl.current && main && mainEl.current ? { el: mainEl.current, file: main } : null);

  // The last moment and play state seen, for resuming after a refused URL
  // (an errored element has already lost both), and the exact moment for
  // anything that needs more than the toolbar's second.
  const lastSeen = useRef({ callMs: callMs, playing: false });
  // The toolbar's clock in state moves once a second: it shows mm:ss, and a
  // playing video reports four times a second, each a render of the whole
  // player and its host's actions for nothing anyone could see.
  const showAt = (at: number) => {
    lastSeen.current.callMs = at;
    setCallMs((prev) => (Math.floor(prev / 1000) === Math.floor(at / 1000) ? prev : at));
  };
  const report = () => {
    const d = driver();
    if (!d) return;
    const at = callMsOf(d.file, callStartedAt, d.el.currentTime);
    lastSeen.current.playing = !d.el.paused;
    showAt(at);
    onTime?.(at, !d.el.paused);
  };

  /** Keep the unseen file where the seen one is. A drift under a third of a
   *  second is left alone: correcting it would stutter the sound. */
  const follow = () => {
    const d = driver();
    const f = follower();
    if (!d || !f) return;
    const at = callMsOf(d.file, callStartedAt, d.el.currentTime);
    const target = fileSecondsAt(f.file, callStartedAt, at);
    if (target === null) return void f.el.pause();
    if (Math.abs(f.el.currentTime - target) > 0.3) f.el.currentTime = target;
    if (f.el.playbackRate !== d.el.playbackRate) f.el.playbackRate = d.el.playbackRate;
    if (d.el.paused !== f.el.paused) {
      if (d.el.paused) f.el.pause();
      else playRoom(f.el);
    }
  };

  // The room's sound refused for want of a tap (SOUND above): the toolbar
  // asks for one. Cleared the moment the room's file does play.
  const [soundBlocked, setSoundBlocked] = useState(false);
  /** Play the room's file, noting a refusal that a tap would lift. */
  const playRoom = (el: HTMLVideoElement) =>
    void el.play().catch((err) => {
      if (isMediaDenial(err)) setSoundBlocked(true);
    });
  /** The tap that lifts it: play the room's file inside the gesture, at the
   *  moment the screen is showing. */
  const unblockSound = () => {
    const el = mainEl.current;
    if (!el) return;
    el.muted = false;
    el.play().then(follow, () => {});
  };

  const showMain = (file: CallVideoFile, seconds: number, play: boolean) => {
    if (file.id === main?.id && mainEl.current) {
      mainEl.current.currentTime = seconds;
      if (play) playRoom(mainEl.current);
      return;
    }
    pending.current.set(file.id, { seconds, play });
    setMainId(file.id);
  };

  const seek = (at: number, opts: { play?: boolean; view?: CallView | null } = {}): boolean => {
    const play = opts.play ?? true;
    // A link that names a screen (a frame of it was cited): show that screen
    // at the moment, with the room's file brought there underneath for the
    // voices. The same rule the frame was located by, so it is the same file.
    const asked = opts.view?.screen ? videoAt(playable, callStartedAt, at, "screen", opts.view.identity) : null;
    // A screen that is itself a lead (its run's room file was lost) plays as
    // the main picture, below.
    if (asked && asked.file.kind === "screen" && !leads.some((f) => f.id === asked.file.id)) {
      if (asked.file.id === screen?.id && screenEl.current) {
        screenEl.current.currentTime = asked.seconds;
        if (play) void screenEl.current.play().catch(() => {});
      } else {
        pending.current.set(asked.file.id, { seconds: asked.seconds, play });
        setScreenId(asked.file.id);
      }
      const room = videoAt(leads, callStartedAt, at);
      if (room && room.file.kind === "composite") showMain(room.file, room.seconds, play);
      showAt(at);
      onTime?.(at, play);
      return true;
    }
    // Watching a screen that covers the moment: stay on it.
    const intoScreen = screen ? fileSecondsAt(screen, callStartedAt, at) : null;
    if (screen && intoScreen !== null && screenEl.current) {
      screenEl.current.currentTime = intoScreen;
      if (play) void screenEl.current.play().catch(() => {});
      showAt(at);
      return true;
    }
    const hit = videoAt(leads, callStartedAt, at);
    if (!hit) return false;
    setScreenId(null);
    showMain(hit.file, hit.seconds, play);
    showAt(at);
    onTime?.(at, play);
    return true;
  };
  if (handleRef) handleRef.current = { seek };

  /** Switch the view to a screen file (or back to the room), at the moment
   *  the picture is at now; a screen that was not up now jumps to its start. */
  const pickView = (file: CallVideoFile | null) => {
    onViewPick?.(file ? { screen: true, identity: file.participant_identity ?? null } : null);
    if (!file) {
      const s = screenEl.current;
      const playing = !!s && !s.paused;
      setScreenId(null);
      if (main && mainEl.current && playing) void mainEl.current.play().catch(() => {});
      return;
    }
    // Already the view: nothing to switch, and nothing to leave waiting for
    // an element that will not load again.
    if (file.id === screenId) return;
    const into = fileSecondsAt(file, callStartedAt, lastSeen.current.callMs);
    const playing = !!driver() && !driver()!.el.paused;
    pending.current.set(file.id, { seconds: into ?? 0, play: playing });
    if (into === null) {
      // The share is at another moment: bring the room there too.
      const at = callMsOf(file, callStartedAt, 0);
      const hit = videoAt(leads, callStartedAt, at);
      if (hit && hit.file.kind === "composite") showMain(hit.file, hit.seconds, playing);
    }
    setScreenId(file.id);
  };

  const onLoaded = (file: CallVideoFile) => (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const p = pending.current.get(file.id);
    if (!p) return;
    pending.current.delete(file.id);
    const el = e.currentTarget;
    el.currentTime = p.seconds;
    if (p.play) void el.play().catch(() => {});
    report();
  };
  const onLoadedFile = (file: CallVideoFile) => (e: React.SyntheticEvent<HTMLVideoElement>) => {
    media.loaded(file.id);
    onLoaded(file)(e);
  };

  /** The element refused its URL (expired, or the window rolled): carry on
   *  from the same moment on whatever URL comes next. */
  const onError = (file: CallVideoFile) => (e: React.SyntheticEvent<HTMLVideoElement>) => {
    // A seek still waiting for this file (a `?t=` landing, a line pressed
    // before the element loaded) is where the person asked to be: keep it
    // over where the element last was, which on a fresh element is 0. Only
    // an element that never loaded can have one (onLoaded takes it).
    pending.current.set(file.id, pending.current.get(file.id) ?? resumePoint(file, e.currentTarget));
    media.refused(file.id);
  };
  /** Where a file's element should come back to: the moment last seen. */
  const resumePoint = (file: CallVideoFile, el?: HTMLVideoElement | null) => ({
    seconds: fileSecondsAt(file, callStartedAt, lastSeen.current.callMs) ?? el?.currentTime ?? 0,
    play: lastSeen.current.playing,
  });
  const retry = (file: CallVideoFile) => {
    pending.current.set(file.id, { ...resumePoint(file), play: false });
    media.retry(file.id);
  };

  // The room's sound, as the toolbar's own controls show and set it while a
  // screen is the view (see SOUND above).
  const [sound, setSound] = useState({ volume: 1, muted: false });
  const onMainVolume = (e: React.SyntheticEvent<HTMLVideoElement>) => setSound({ volume: e.currentTarget.volume, muted: e.currentTarget.muted });
  const setMainSound = (next: { volume?: number; muted?: boolean }) => {
    const el = mainEl.current;
    if (!el) return;
    if (next.volume !== undefined) el.volume = next.volume;
    if (next.muted !== undefined) el.muted = next.muted;
  };

  const isDriver = (el: HTMLVideoElement) => driver()?.el === el;
  const driverHandlers = {
    onTimeUpdate: (e: React.SyntheticEvent<HTMLVideoElement>) => {
      if (!isDriver(e.currentTarget)) return;
      report();
      follow();
    },
    onPlay: (e: React.SyntheticEvent<HTMLVideoElement>) => isDriver(e.currentTarget) && (report(), follow()),
    onPause: (e: React.SyntheticEvent<HTMLVideoElement>) => isDriver(e.currentTarget) && (report(), follow()),
    onSeeked: (e: React.SyntheticEvent<HTMLVideoElement>) => isDriver(e.currentTarget) && (report(), follow()),
    onRateChange: (e: React.SyntheticEvent<HTMLVideoElement>) => isDriver(e.currentTarget) && follow(),
  };

  // A screen that ends while the room goes on hands the view back to the
  // room, still playing, at the same moment.
  const onScreenEnded = () => {
    if (!main || !mainEl.current) return setScreenId(null);
    setScreenId(null);
    void mainEl.current.play().catch(() => {});
  };

  // A recording that plays to its end carries on into the next one, the way
  // the transcript below does (a gap between runs is skipped, not waited out).
  const onMainEnded = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!isDriver(e.currentTarget) || !main) return;
    const at = leads.indexOf(main);
    const next = at >= 0 ? leads[at + 1] : undefined;
    if (next) showMain(next, 0, true);
  };

  // Files vanish (a run deleted, the share link revoked): fall back to what
  // is left rather than holding an element on a dead id.
  useWatchEffect(() => {
    if (screenId && !playable.some((f) => f.id === screenId)) setScreenId(null);
    if (mainId && !leads.some((f) => f.id === mainId)) setMainId(null);
  }, [playable, leads]);

  if (!main) return null;

  // A moment asked for that no video shows, with the nearest one that does.
  const missed = missedMs !== null ? noVideoWords(missedMs, spans) : null;

  // The view switch: the room, and a chip for each person who shared a screen
  // during this run (one chip however often they shared: the share up now,
  // else their next). A share that is not up at this moment is still offered,
  // dimmed, and jumps to where it began.
  const runId = main.run_id ?? main.id;
  const runScreens = playable.filter((f) => f.kind === "screen" && (f.run_id ?? f.id) === runId && f.id !== main.id);
  const chips = screenChips(runScreens, callStartedAt, callMs);
  const runIndex = leads.findIndex((f) => f.id === main.id);
  const shown = screen ?? main;
  const dead = media.dead(shown.id);
  // The file shown has its metadata (LOADING above): keyed by the element,
  // so a fresh URL after a refusal starts loading again.
  const shownLoaded = loadedKeys.has(media.keyOf(shown));

  return (
    // Always dark, like the stage: video wants a dark room, and the `dark`
    // class makes every sol token inside (the toolbar's words) read on it
    // whatever theme the page is in.
    <div className={`${CALL_VIDEO_FRAME} ${className}`}>
      <div className={CALL_VIDEO_BOX} aria-busy={!shownLoaded && !dead ? true : undefined}>
        <video
          key={media.keyOf(main)}
          ref={mainEl}
          src={srcOf(main)}
          controls={!screen && loadedKeys.has(media.keyOf(main))}
          controlsList={NATIVE_MENUS_OFF}
          disablePictureInPicture
          playsInline
          preload="metadata"
          aria-hidden={screen ? true : undefined}
          tabIndex={screen ? -1 : undefined}
          className={`call-video absolute inset-0 h-full w-full object-contain ${screen || !loadedKeys.has(media.keyOf(main)) ? "pointer-events-none opacity-0" : ""}`}
          onLoadedMetadata={(e) => {
            noteLoaded(main);
            onMainVolume(e);
            onLoadedFile(main)(e);
          }}
          onVolumeChange={onMainVolume}
          onError={onError(main)}
          onEnded={onMainEnded}
          {...driverHandlers}
          onPlaying={() => setSoundBlocked(false)}
        />
        {screen && (
          <video
            key={media.keyOf(screen)}
            ref={screenEl}
            src={srcOf(screen)}
            controls={loadedKeys.has(media.keyOf(screen))}
            controlsList={NATIVE_MENUS_OFF}
            disablePictureInPicture
            muted
            playsInline
            preload="metadata"
            className={`call-video absolute inset-0 h-full w-full object-contain ${loadedKeys.has(media.keyOf(screen)) ? "" : "opacity-0"}`}
            onLoadedMetadata={(e) => {
              noteLoaded(screen);
              onLoadedFile(screen)(e);
            }}
            onError={onError(screen)}
            onEnded={onScreenEnded}
            {...driverHandlers}
          />
        )}
        {!shownLoaded && !dead && <div className={CALL_VIDEO_LOADING} aria-hidden="true" />}
        {dead && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black/85 px-6 text-center text-[12px] text-sol-text-muted" role="status">
            {refreshing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-sol-text-dim motion-reduce:animate-none" />
                Refreshing the video
              </>
            ) : (
              <>
                The video could not be loaded.
                <button
                  type="button"
                  onClick={() => retry(shown)}
                  className="flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1 font-mono text-[11px] text-sol-text transition-colors hover:bg-white/[0.14]"
                >
                  <RotateCw className="h-3 w-3" /> Try again
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {/* What the picture cannot say for itself: the moment asked for has no
          video, or the room's own file is gone and this is all there is. */}
      {(missed || main.kind === "screen") && (
        <div className="space-y-0.5 border-t border-white/[0.06] bg-sol-base03 px-2.5 py-1.5 text-[11.5px] leading-snug text-sol-text-muted" role="status">
          {missed && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                {missed.title}. {missed.detail}
              </span>
              {missed.jump && (
                <button
                  type="button"
                  onClick={() => (onJump ? onJump(missed.jump!.ms) : seek(missed.jump!.ms))}
                  className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[11px] text-sol-text transition-colors hover:bg-white/[0.12]"
                >
                  {missed.jump.words}
                </button>
              )}
            </p>
          )}
          {main.kind === "screen" && <p>The room's video was lost. This is {recordingSubject(main)}, without sound.</p>}
        </div>
      )}
      <div className={CALL_VIDEO_BAR}>
        <span className="tabular-nums text-sol-text-secondary" title="Where in the call this is, in the transcript's clock">
          {formatCallTime(callMs)}
        </span>
        {chips.length > 0 && (
          <span className="flex items-center gap-0.5 rounded-md bg-white/[0.05] p-0.5" role="radiogroup" aria-label="What to watch">
            <ViewChip active={!screen} onClick={() => pickView(null)} title="The room as everyone saw it, with every voice">
              <Users className="h-3 w-3" /> Room
            </ViewChip>
            {chips.map(({ file: f, up, at, several }) => {
              const label = recordingSubject(f, "label");
              const sharer = screen && (screen.participant_identity ?? screen.id) === (f.participant_identity ?? f.id);
              return (
                <ViewChip
                  key={f.participant_identity ?? f.id}
                  active={!!sharer}
                  dim={!up && !sharer}
                  onClick={() => pickView(sharer ? screen : f)}
                  title={
                    up
                      ? `${label} at full size: the text on it legible, the room's sound underneath`
                      : `${label}, shared at ${formatCallTime(at)}. Jump there`
                  }
                >
                  <MonitorUp className="h-3 w-3" /> {label}
                  <ParticipantTag identity={f.participant_identity} />
                  {several && !up && <span className="text-sol-text-dim">· {formatCallTime(at)}</span>}
                </ViewChip>
              );
            })}
          </span>
        )}
        {leads.length > 1 && (
          <span className="flex items-center gap-0.5" aria-label="Recordings of this call">
            <span className="mr-1 text-sol-text-dim">
              Recording {runIndex + 1} of {leads.length}
            </span>
            {leads.map((f, i) => {
              const from = formatCallTime(callMsOf(f, callStartedAt, 0));
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => seek(callMsOf(f, callStartedAt, 0))}
                  aria-current={i === runIndex || undefined}
                  className={`rounded px-1.5 py-0.5 tabular-nums transition-colors ${
                    i === runIndex ? "bg-white/10 text-sol-text" : "hover:bg-white/[0.06] hover:text-sol-text"
                  }`}
                  title={`Recording ${i + 1} of ${leads.length}, from ${from} in the call`}
                >
                  {from}
                </button>
              );
            })}
          </span>
        )}
        {screen && (
          // The slider rises above the button on hover or focus rather than
          // sitting in the bar: the bar holds one line at the page's usual
          // width, and a control that only the screen view has must not
          // wrap it there and move the transcript down when the view
          // switches.
          <span className="group/vol relative flex items-center" role="group" aria-label="The room's sound">
            {soundBlocked ? (
              <button
                type="button"
                onClick={unblockSound}
                className="flex items-center gap-1 rounded bg-sol-violet/15 px-1.5 py-0.5 text-sol-violet transition-colors hover:bg-sol-violet/25"
              >
                <VolumeX className="h-3.5 w-3.5" />
                Tap for sound
              </button>
            ) : (
            <button
              type="button"
              onClick={() => setMainSound({ muted: !sound.muted })}
              aria-pressed={sound.muted}
              aria-label={sound.muted ? "Unmute the room" : "Mute the room"}
              title={sound.muted ? "Unmute: the room's voices, under this screen" : "Mute the room's voices"}
              className="rounded p-0.5 transition-colors hover:bg-white/[0.06] hover:text-sol-text"
            >
              {sound.muted || sound.volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </button>
            )}
            {/* No slider on a touch screen: a phone ignores a page's volume. */}
            <span className="absolute bottom-full left-1/2 z-10 hidden -translate-x-1/2 pb-1.5 group-focus-within/vol:block group-hover/vol:block [@media(pointer:coarse)]:!hidden">
              <span className="flex rounded-md bg-sol-base03 px-2.5 py-2 shadow-lg ring-1 ring-white/[0.08]">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sound.muted ? 0 : sound.volume}
                  onChange={(e) => setMainSound({ volume: Number(e.currentTarget.value), muted: Number(e.currentTarget.value) === 0 })}
                  aria-label="The room's volume"
                  className="h-1 w-20 cursor-pointer accent-sol-violet"
                />
              </span>
            </span>
          </span>
        )}
        <span className="flex-1" />
        {actions?.({ callMs, file: shown, now: () => lastSeen.current.callMs })}
      </div>
    </div>
  );
}

function ViewChip({
  active,
  dim = false,
  onClick,
  title,
  children,
}: {
  active: boolean;
  dim?: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
        active ? "bg-sol-violet/15 text-sol-violet" : dim ? "text-sol-text-dim hover:text-sol-text-muted" : "hover:bg-white/[0.06] hover:text-sol-text"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * What the page says where the video goes, when the video cannot speak for
 * itself: the room is being filmed right now, a run is saving (an MP4 is
 * uploaded whole when it ends, so there is nothing to play until then), or a
 * run failed and nothing of it will play, with LiveKit's reason in plain
 * words. `onDelete` offers to clear a failed run away. A failure is an alarm
 * only while the call is live, when the room can still press Record again;
 * once the call is over (`quiet`) it is a fact about an old call, said the
 * way a deleted recording is, so nobody opening it next week is shown a
 * warning they can do nothing about.
 */
export function CallVideoNoticeLine({
  notice,
  onDelete,
  quiet = false,
}: {
  notice: CallVideoNotice;
  onDelete?: () => void;
  quiet?: boolean;
}) {
  if (notice.kind === "live") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg bg-sol-red/[0.06] px-3 py-2 text-[12px] text-sol-text-secondary ring-1 ring-inset ring-sol-red/15">
        <RecordingMark status={notice.run.composite?.status === "recording" ? "recording" : "starting"} startedAt={notice.run.startedAt} />
        <span>Recording now. The video plays here once it stops.</span>
      </div>
    );
  }
  if (notice.kind === "saving") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg bg-sol-bg-alt/60 px-3 py-2 text-[12px] text-sol-text-muted">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sol-text-dim motion-reduce:animate-none" />
        <span>Saving the recording. It plays here in a minute or so.</span>
      </div>
    );
  }
  const clear = onDelete && notice.run.canDelete && (
    <button
      type="button"
      onClick={onDelete}
      className="shrink-0 rounded px-1.5 font-mono text-[11px] not-italic text-sol-text-muted transition-colors hover:bg-sol-text-muted/10 hover:text-sol-text"
      title="Remove this failed recording from the call"
    >
      Clear
    </button>
  );
  if (quiet) {
    return (
      <p className="flex items-start gap-2 text-[12px] italic text-sol-text-dim">
        <span className="min-w-0">{recordingFailureWords(notice.run.error)}</span>
        {clear}
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-sol-orange/[0.07] px-3 py-2 text-[12px] text-sol-text-secondary ring-1 ring-inset ring-sol-orange/20">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-sol-orange" />
      <span className="min-w-0 flex-1">
        {recordingFailureWords(notice.run.error)}
      </span>
      {clear}
    </div>
  );
}

/** Delete a recording, asked twice: the first press says what it does, the
 *  second does it. At rest it is a dim icon with its words in the tooltip,
 *  set apart from the copy controls beside it (the host puts a rule between
 *  them): the one destructive control on the bar never reads as a peer of
 *  "Link". Everyone loses it, so it says "for everyone". The question
 *  goes away on Esc from anywhere in it, a press outside, or focus leaving.
 *  Focus lands on the question, not on Delete (as RecordConfirm does for
 *  Record): a stray Enter after the first press must not destroy the film. */
export function DeleteRecordingButton({ onConfirm }: { onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useWatchEffect(() => {
    if (asking) rootRef.current?.focus();
  }, [asking]);
  usePressOutside(rootRef, asking, () => setAsking(false), { escape: true });
  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="flex items-center rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-red/10 hover:text-sol-red"
        title="Delete this recording for everyone, with its screen files and any frames shared from it"
        aria-label="Delete this recording"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    );
  }
  return (
    <span
      ref={rootRef}
      tabIndex={-1}
      className="flex items-center gap-1 outline-none animate-in fade-in duration-150"
      role="group"
      aria-label="Delete this recording?"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAsking(false);
      }}
    >
      <span className="text-sol-text-secondary">Delete for everyone?</span>
      <button
        type="button"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        className="sol-btn-solid rounded bg-sol-red px-1.5 py-0.5 font-medium text-white"
      >
        Delete
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-sol-text"
      >
        Keep <KeyCap size="xs">Esc</KeyCap>
      </button>
    </span>
  );
}
