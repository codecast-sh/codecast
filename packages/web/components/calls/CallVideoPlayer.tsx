import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AlertTriangle, Loader2, MonitorUp, Trash2, Users } from "lucide-react";
import { recordingFailureWords, recordingSubject } from "@codecast/shared/contracts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useStableMediaSrcs } from "../../hooks/useStableMediaSrcs";
import {
  callMsOf,
  fileSecondsAt,
  playableFiles,
  screenChips,
  videoAt,
  type CallVideoFile,
  type CallVideoNotice,
} from "../../lib/calls/callVideo";
import { RecordingMark } from "./RecordingMark";
import { fmtClock } from "./speakers";

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
// `cl-42@12:34` reference use.
//
// URLS. A file's URL changes under it (a presigned one every window, the share
// page's redirect signs a short one per request), and a video element handed a
// new src starts over. So each file keeps the URL it was first loaded with and
// moves only when the element refuses it (useStableMediaSrcs), resuming at the
// same moment.
//
// ONE CALL, SEVERAL RECORDINGS. Record pressed twice makes two runs with a gap
// between. Playing to the end of one carries on into the next, the way the
// transcript does.

export type CallVideoHandle = {
  /** Show the call at `callMs`. False when no video covers that moment. */
  seek: (callMs: number, opts?: { play?: boolean }) => boolean;
};

export function CallVideoPlayer({
  files,
  callStartedAt,
  handleRef,
  onTime,
  actions,
  className = "",
}: {
  files: readonly CallVideoFile[];
  callStartedAt: number;
  handleRef?: RefObject<CallVideoHandle | null>;
  /** Where in the call the picture is, as it plays or is moved. */
  onTime?: (callMs: number, playing: boolean) => void;
  /** The host's own controls on the toolbar (copy a moment, delete). */
  actions?: (at: { callMs: number; file: CallVideoFile }) => ReactNode;
  className?: string;
}) {
  const playable = useMemo(() => playableFiles(files), [files]);
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
  const srcOf = (f: CallVideoFile) => media.srcOf(f);

  const driver = () => (screen && screenEl.current ? { el: screenEl.current, file: screen } : main && mainEl.current ? { el: mainEl.current, file: main } : null);
  const follower = () => (screen && screenEl.current && main && mainEl.current ? { el: mainEl.current, file: main } : null);

  // The last moment and play state seen, for resuming after a refused URL
  // (an errored element has already lost both).
  const lastSeen = useRef({ callMs: 0, playing: false });
  const report = () => {
    const d = driver();
    if (!d) return;
    const at = callMsOf(d.file, callStartedAt, d.el.currentTime);
    lastSeen.current = { callMs: at, playing: !d.el.paused };
    setCallMs(at);
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
      else void f.el.play().catch(() => {});
    }
  };

  const showMain = (file: CallVideoFile, seconds: number, play: boolean) => {
    if (file.id === main?.id && mainEl.current) {
      mainEl.current.currentTime = seconds;
      if (play) void mainEl.current.play().catch(() => {});
      return;
    }
    pending.current.set(file.id, { seconds, play });
    setMainId(file.id);
  };

  const seek = (at: number, opts: { play?: boolean } = {}): boolean => {
    const play = opts.play ?? true;
    // Watching a screen that covers the moment: stay on it.
    const intoScreen = screen ? fileSecondsAt(screen, callStartedAt, at) : null;
    if (screen && intoScreen !== null && screenEl.current) {
      screenEl.current.currentTime = intoScreen;
      if (play) void screenEl.current.play().catch(() => {});
      setCallMs(at);
      return true;
    }
    const hit = videoAt(leads, callStartedAt, at);
    if (!hit) return false;
    setScreenId(null);
    showMain(hit.file, hit.seconds, play);
    setCallMs(at);
    onTime?.(at, play);
    return true;
  };
  if (handleRef) handleRef.current = { seek };

  /** Switch the view to a screen file (or back to the room), at the moment
   *  the picture is at now; a screen that was not up now jumps to its start. */
  const pickView = (file: CallVideoFile | null) => {
    if (!file) {
      const s = screenEl.current;
      const playing = !!s && !s.paused;
      setScreenId(null);
      if (main && mainEl.current && playing) void mainEl.current.play().catch(() => {});
      return;
    }
    const into = fileSecondsAt(file, callStartedAt, callMs);
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
    // A screen joins with the room's sound settings, so its controls move
    // the voices it is shown over.
    if (file.kind === "screen" && mainEl.current && el === screenEl.current) {
      el.volume = mainEl.current.volume;
      el.muted = mainEl.current.muted;
    }
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
    const seconds = fileSecondsAt(file, callStartedAt, lastSeen.current.callMs) ?? e.currentTarget.currentTime ?? 0;
    pending.current.set(file.id, { seconds, play: lastSeen.current.playing });
    media.refused(file.id);
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
    onVolumeChange: (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const f = follower();
      if (!f || !isDriver(e.currentTarget)) return;
      f.el.volume = e.currentTarget.volume;
      f.el.muted = e.currentTarget.muted;
    },
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

  return (
    // Always dark, like the stage: video wants a dark room, and the `dark`
    // class makes every sol token inside (the toolbar's words) read on it
    // whatever theme the page is in.
    <div className={`dark overflow-hidden rounded-lg bg-black ring-1 ring-sol-border/30 ${className}`}>
      <div className="relative flex max-h-[46vh] min-h-[180px] items-center justify-center">
        <video
          key={`${main.id}:${srcOf(main)}`}
          ref={mainEl}
          src={srcOf(main)}
          controls={!screen}
          playsInline
          preload="metadata"
          aria-hidden={screen ? true : undefined}
          tabIndex={screen ? -1 : undefined}
          className={screen ? "pointer-events-none absolute inset-0 h-full w-full opacity-0" : "max-h-[46vh] w-full bg-black object-contain"}
          onLoadedMetadata={onLoadedFile(main)}
          onError={onError(main)}
          onEnded={onMainEnded}
          {...driverHandlers}
        />
        {dead && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 px-6 text-center text-[12px] text-sol-text-muted">
            The video could not be loaded. Reload the page to try again.
          </div>
        )}
        {screen && (
          <video
            key={`${screen.id}:${srcOf(screen)}`}
            ref={screenEl}
            src={srcOf(screen)}
            controls
            playsInline
            preload="metadata"
            className="max-h-[46vh] w-full bg-black object-contain"
            onLoadedMetadata={onLoadedFile(screen)}
            onError={onError(screen)}
            onEnded={onScreenEnded}
            {...driverHandlers}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-white/[0.06] bg-sol-base03 px-2.5 py-1.5 font-mono text-[11px] text-sol-text-muted">
        <span className="tabular-nums text-sol-text-secondary" title="Where in the call this is, in the transcript's clock">
          {fmtClock(callMs)}
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
                      : `${label}, shared at ${fmtClock(at)}. Jump there`
                  }
                >
                  <MonitorUp className="h-3 w-3" /> {label}
                  {several && !up && <span className="text-sol-text-dim">· {fmtClock(at)}</span>}
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
              const from = fmtClock(callMsOf(f, callStartedAt, 0));
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
        <span className="flex-1" />
        {actions?.({ callMs, file: shown })}
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
 * words. `onDelete` offers to clear a failed run away.
 */
export function CallVideoNoticeLine({
  notice,
  onDelete,
}: {
  notice: CallVideoNotice;
  onDelete?: () => void;
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
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-sol-orange/[0.07] px-3 py-2 text-[12px] text-sol-text-secondary ring-1 ring-inset ring-sol-orange/20">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-sol-orange" />
      <span className="min-w-0 flex-1">
        {recordingFailureWords(notice.run.error)}
      </span>
      {onDelete && notice.run.canDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded px-1.5 font-mono text-[11px] text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** Delete a recording, asked twice: the first press says what it does, the
 *  second does it. Everyone loses it, so it says "for everyone". The question
 *  goes away on Esc from anywhere in it, a press outside, or focus leaving. */
export function DeleteRecordingButton({ onConfirm }: { onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useWatchEffect(() => {
    if (!asking) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setAsking(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [asking]);
  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-sol-red/10 hover:text-sol-red"
        title="Delete this recording, its screen files too, for everyone"
      >
        <Trash2 className="h-3 w-3" /> Delete
      </button>
    );
  }
  return (
    <span
      ref={rootRef}
      className="flex items-center gap-1 animate-in fade-in duration-150"
      role="group"
      aria-label="Delete this recording?"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        setAsking(false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAsking(false);
      }}
    >
      <span className="text-sol-text-secondary">Delete for everyone?</span>
      <button
        type="button"
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        className="rounded bg-sol-red px-1.5 py-0.5 font-medium text-white transition-colors hover:bg-sol-red/85"
      >
        Delete
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className="rounded px-1.5 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-sol-text"
      >
        Keep
      </button>
    </span>
  );
}
