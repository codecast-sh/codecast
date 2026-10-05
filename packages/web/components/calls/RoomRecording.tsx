import { useRef, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { RECORDING_RESTART_COOLDOWN_MS, recordingKeptWords } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWindowPresent } from "../../hooks/usePagePresence";
import { useFaceRowSelect, type FaceRow } from "../../hooks/useFaceRow";
import {
  noteRecordConfirmed,
  noteRecordingNoticed,
  owesRecordingNotice,
  pressedRunOf,
  recordConfirmed,
  recordingNoticed,
  setRoomRecording,
  useRoomRecordingEnded,
  useRoomRecordingMark,
  useRoomRecordingPress,
  useSeatedRoomKey,
  type RoomRecordingEnd,
  type RoomRecordingLive,
} from "../../hooks/useRoomRecording";
import {
  owedStopNotice,
  recordingEndHref,
  roomRunWatch,
  savedWords,
  stoppedByItself,
  stoppedWords,
  watchRoomRun,
  type RoomRunWatch,
} from "../../lib/calls/roomRecordingEnd";
import { hasBrowserNotificationPermission, isCallPanelWindow, isElectron, navigateMainWindow, notifyNative } from "../../lib/desktop";
import { soundRecordingOff, soundRecordingOn } from "../../lib/sounds";
import { persistentToast } from "../../lib/persistentToast";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { RECORDING_SHARED_WORDS, RecordingMark, RecordingStopControl, STOP_RECORDING_ASK, StopRecordingQuestion } from "./RecordingMark";
import { STAGE_CTL, STAGE_CTL_IDLE } from "./stageHost";
import { firstName } from "./speakers";

// Recording a huddle, from inside it: the Record button on the stage's
// control bar, the red mark on the stage's header and on the face row's card,
// and the notice that tells everyone else in the room (convex
// callRecordings: LiveKit films the room on its own servers, so what is kept
// never depends on whose tab stayed open).
//
// The rules the surfaces keep: recording starts only on a press, the first
// press ever asks once and says the room will be told, the room IS told
// (everyone present, anyone who joins later: a sound when it starts and
// stops, the mark, and once in words), and anyone in the room can stop it,
// from wherever they see the mark: the mark is the Stop control, and Stop
// always asks once more, since it ends the recording for everyone. The mark
// is settled from this window's press in flight and the room's row in the
// store (recordingMarkStatus), so every surface agrees.
//
// WHICH WINDOW. On desktop the call lives in the voice host window, and every
// other window's own call slice stays idle while it does. So the room a
// person sits in is read from the host's mirror (useSeatedRoomKey, the face
// row's card from the face row), never from this window's slice, and a notice
// counts as given only when a window a person is looking at showed it.

const useMe = () => useInboxStore((s: any) => s.currentUser?._id?.toString?.() ?? null);

/** Whoever pressed, as the mark's tooltip names them. */
function byWords(live: RoomRecordingLive | null, me: string | null): string | null {
  if (!live) return null;
  return me && live.started_by.id === me ? "You" : firstName(live.started_by.name);
}

const filming = (status: RoomRecordingLive["status"] | null) => status === "starting" || status === "recording";
const stopForEveryone = (roomKey: string) => () => void setRoomRecording(roomKey, false);

/** The stage header's mark: REC and the time filmed, while the room records,
 *  and the way to stop it. A run that was stopped says it is saving, and
 *  offers nothing: there is nothing left to stop. */
export function StageRecordingBadge({ roomKey }: { roomKey: string | null }) {
  const { status, live } = useRoomRecordingMark(roomKey);
  const me = useMe();
  if (!status || !roomKey) return null;
  const mark = (
    <RecordingMark status={status} startedAt={status === "recording" ? live?.started_at : null} by={byWords(live, me)} shared={!!live?.video_shared} />
  );
  if (!filming(status)) return <span className="ml-1 flex shrink-0">{mark}</span>;
  return (
    <RecordingStopControl onStop={stopForEveryone(roomKey)} place="below-start" className="ml-1">
      {mark}
    </RecordingStopControl>
  );
}

const selectEngagedRoom = (row: FaceRow) => row.room;

// How long the float's mark says who is recording, and the runs it has said
// it for in this window (the float remounts when it docks and floats again).
const CARD_TELL_MS = 10_000;
const cardTold = new Set<string>();

/**
 * The mark on a call's own card in the face row (header and float), beside
 * the controls, for the room the card is about. It is where a huddle sits
 * most of the time, so the mark is the Stop control here too: a press swaps
 * it for the question, in the card's own line (the float is a window sized to
 * its card; a popover would be cut off by its edge).
 *
 * `tell` is for the float, which stays on screen over whatever app the person
 * is working in: a run somebody else started is said in words there for a few
 * seconds, since the toast waits for a codecast window to have focus.
 * `inert` draws the mark alone, for a host that is itself a button.
 */
export function CallCardRecordingMark({ tell = false, inert = false }: { tell?: boolean; inert?: boolean }) {
  const roomKey = useFaceRowSelect(selectEngagedRoom);
  const { status, live } = useRoomRecordingMark(roomKey);
  const me = useMe();
  const [asking, setAsking] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const on = filming(status);
  const open = asking && on;
  useWatchEffect(() => {
    if (!open) return setAsking(false);
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setAsking(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const runId = on ? (live?.run_id ?? null) : null;
  const others = !!live && !!me && live.started_by.id !== me;
  const [telling, setTelling] = useState<string | null>(null);
  useWatchEffect(() => {
    if (!tell || !runId || !others || cardTold.has(runId)) return;
    cardTold.add(runId);
    setTelling(runId);
    const timer = setTimeout(() => setTelling((cur) => (cur === runId ? null : cur)), CARD_TELL_MS);
    return () => clearTimeout(timer);
  }, [tell, runId, others]);

  if (!status || !roomKey) return null;
  if (!on || inert) return <RecordingMark size="dot" status={status} className="mr-1" />;
  const by = byWords(live, me);
  return (
    <span
      ref={rootRef}
      className="mr-1 inline-flex shrink-0 items-center"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        setAsking(false);
      }}
    >
      {open ? (
        <StopRecordingQuestion dense onStop={() => (setAsking(false), stopForEveryone(roomKey)())} onKeep={() => setAsking(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-sol-red/10"
          aria-label="This call is being recorded. Stop recording"
          data-card-action="recording"
        >
          <RecordingMark size="dot" status={status} by={by} shared={!!live?.video_shared} />
          {telling === runId && live && (
            <span className="whitespace-nowrap font-mono text-[10px] text-sol-text-secondary" role="status">
              {firstName(live.started_by.name)} is recording
            </span>
          )}
        </button>
      )}
    </span>
  );
}

// ── Record and Stop ──────────────────────────────────────────────────────

/** The control bar's round button. Absent on a server where recording is
 *  not set up (a button that can only fail is worse than none), except while
 *  the room records: Stop is always offered to anyone in it. A server that is
 *  set up but cannot record right now (the LiveKit plan spent its minutes)
 *  shows the button disabled with the reason, so nobody presses it in front
 *  of the room to find out. Until the room's row has said which, the
 *  button's place is held, so the bar does not shift under the person's
 *  pointer when the answer lands. Stop asks once more, as it does
 *  everywhere: it sits between Transcribe and Hang up, where a stray click is
 *  likeliest, and it ends the recording for everyone. */
export function RecordButton({ roomKey }: { roomKey: string }) {
  const { status, live, configured, unavailable } = useRoomRecordingMark(roomKey);
  const press = useRoomRecordingPress(roomKey);
  const [asking, setAsking] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const on = filming(status);
  // The last run is still being written. A new press waits only the
  // server's short cooldown after the stop (the shared rule, counted from
  // the stop rather than from LiveKit's upload, which can take minutes), then
  // records while the last file is still saving.
  const stoppedAt = status === "stopping" ? (live?.stop_requested_at ?? null) : null;
  const now = useNowWhen((t) => (stoppedAt !== null && t - stoppedAt < RECORDING_RESTART_COOLDOWN_MS ? "wait" : "go"), 1_000);
  const cooling = status === "stopping" && (stoppedAt === null || now - stoppedAt < RECORDING_RESTART_COOLDOWN_MS);
  const stillSaving = status === "stopping" && !cooling;

  if (on) {
    return (
      <RecordingStopControl
        onStop={stopForEveryone(roomKey)}
        place="above"
        disabled={press !== null}
        label="Stop recording"
        title="Stop recording, for everyone"
        buttonClassName={`${STAGE_CTL} bg-sol-red/15 text-sol-red hover:bg-sol-red/25`}
      >
        <RecordGlyph look={status === "starting" ? "starting" : "on"} />
      </RecordingStopControl>
    );
  }
  if (!cooling && configured === undefined) {
    return (
      <span className={`${STAGE_CTL} invisible`} aria-hidden="true">
        <RecordGlyph look="idle" />
      </span>
    );
  }
  if (!cooling && !configured) return null;
  // Set up, but LiveKit is refusing every recording: say why, offer nothing.
  const blocked = !cooling && !!unavailable;
  const idle = !cooling && !blocked;

  const pressButton = () => {
    if (asking) return setAsking(false);
    if (press !== null || !idle) return;
    if (!recordConfirmed()) return setAsking(true);
    void setRoomRecording(roomKey, true);
  };

  const title = cooling
    ? "Saving the last recording. Record again in a moment"
    : blocked
      ? unavailable!
      : stillSaving
        ? "Record this huddle again. The last recording is still saving to the call"
        : "Record this huddle: video of everyone and any shared screen";

  return (
    <span ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={pressButton}
        // aria-disabled, not disabled, when blocked: a disabled button shows
        // no tooltip, and the reason is the point.
        disabled={cooling}
        aria-disabled={blocked || undefined}
        className={`${STAGE_CTL} ${idle ? STAGE_CTL_IDLE : "cursor-default text-sol-text-dim"}`}
        title={title}
        aria-label={cooling ? "Saving the last recording" : blocked ? `Recording unavailable: ${unavailable}` : "Record this huddle"}
        aria-pressed={false}
        aria-expanded={asking || undefined}
      >
        <RecordGlyph look={cooling ? "saving" : blocked ? "unavailable" : "idle"} />
      </button>
      {asking && (
        <RecordConfirm
          roomKey={roomKey}
          insideRef={wrapRef}
          onCancel={() => setAsking(false)}
          onRecord={() => {
            setAsking(false);
            noteRecordConfirmed();
            void setRoomRecording(roomKey, true);
          }}
        />
      )}
    </span>
  );
}

/** Record is the universal red dot in a ring; recording is the stop square
 *  (breathing while LiveKit has not begun); saving is the ring with a dim,
 *  breathing dot; unavailable is the ring with a dim, still dot. Drawn rather
 *  than an icon font glyph so the dot is red while the ring keeps the bar's
 *  quiet tone. */
function RecordGlyph({ look }: { look: "idle" | "starting" | "on" | "saving" | "unavailable" }) {
  if (look === "on" || look === "starting") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center" aria-hidden="true">
        <span className={`h-[9px] w-[9px] rounded-[2px] bg-current ${look === "starting" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
      </span>
    );
  }
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.75px] border-current" aria-hidden="true">
      <span
        className={`h-[7px] w-[7px] rounded-full ${
          look === "saving" ? "animate-pulse bg-sol-red/40 motion-reduce:animate-none" : look === "unavailable" ? "bg-sol-text-dim/50" : "bg-sol-red"
        }`}
      />
    </span>
  );
}

/** The first press, ever: what recording does, who is told and who can watch,
 *  once. Focus lands on the question, not on Record, so a stray Space cannot
 *  film the room. Enter on the question records and Esc cancels, each shown
 *  on its button: the question is itself the deliberate second step. A held
 *  Enter (the press that opened it, repeating) is not an answer. */
function RecordConfirm({
  roomKey,
  insideRef,
  onCancel,
  onRecord,
}: {
  roomKey: string;
  /** The button and the question together: a press anywhere in it is not "outside". */
  insideRef: React.RefObject<HTMLElement | null>;
  onCancel: () => void;
  onRecord: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useMountEffect(() => {
    boxRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!insideRef.current?.contains(e.target as Node)) cancel.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  });
  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Record this huddle?"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.repeat && e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          onRecord();
          return;
        }
        if (e.key !== "Escape") return;
        // The stage collapses on Esc; this Esc only closes the question.
        e.stopPropagation();
        onCancel();
      }}
      className="absolute bottom-full left-1/2 z-10 mb-3 w-[300px] -translate-x-1/2 outline-none"
    >
      {/* The rise is on an inner box: the enter animation writes `transform`,
          which would drop the centring translate above for its duration. */}
      <div className="rounded-xl bg-sol-bg-alt p-3.5 text-left shadow-2xl ring-1 ring-white/5 animate-in fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none">
        <div className="flex items-center gap-2 font-mono text-[12.5px] text-sol-text">
          <span className="h-2 w-2 rounded-full bg-sol-red" aria-hidden="true" />
          Record this huddle?
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-sol-text-secondary">
          Everyone in the call sees that it is being recorded, and anyone who joins later is told. Anyone in the call can
          stop it.
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-sol-text-muted">
          It films faces, voices and shared screens. {recordingKeptWords(roomKey)}
        </p>
        <div className="mt-3.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11.5px] text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text"
          >
            Cancel <KeyCap size="xs">Esc</KeyCap>
          </button>
          <button
            type="button"
            onClick={onRecord}
            className="sol-btn-solid flex items-center gap-1.5 rounded-md bg-sol-red px-3 py-1.5 font-mono text-[11.5px] font-medium text-white"
          >
            Record <KeyCap size="xs" tone="onAccent">Enter</KeyCap>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Telling the room ─────────────────────────────────────────────────────

const STARTED_TITLE = "This call is being recorded";

function startedWords(live: RoomRecordingLive): string {
  const shared = live.video_shared ? ` ${RECORDING_SHARED_WORDS}` : "";
  return `${firstName(live.started_by.name)} started recording.${shared} Anyone in the call can stop it.`;
}

// A notice nobody was there to read: how long a window waits for a person
// to look at it before the run is said by a system banner instead (how long
// a stop stays worth saying is STOP_NEWS_MS, shared with the phone).
const AWAY_MS = 4_000;

// Runs this tab has sounded, so a second mount of the hook (the banner beside
// the toast) or a remount does not sound one twice. Across windows the sound
// itself is collapsed by its key (lib/sounds).
const cued = new Set<string>();

type RecordingSay = {
  started: (live: RoomRecordingLive) => void;
  stopped: (live: RoomRecordingLive, end: RoomRecordingEnd | null) => void;
  /** The presser's line once their run landed (stopNoticeVerdict `saved`). */
  saved: (live: RoomRecordingLive, end: RoomRecordingEnd) => void;
  /** The same two, for a person who is not looking at any codecast window:
   *  said where an unfocused person is reached. Absent: this surface only
   *  speaks to someone looking at it. */
  away?: {
    started: (live: RoomRecordingLive) => Promise<boolean>;
    stopped: (live: RoomRecordingLive, end: RoomRecordingEnd | null) => Promise<boolean>;
    saved: (live: RoomRecordingLive, end: RoomRecordingEnd) => Promise<boolean>;
  };
};

/** The room's recording as this window owes its person: a sound when a run
 *  starts and when it stops (everyone, whichever window has focus), the
 *  notice of a run somebody else started (or that was already running when
 *  they walked in), and a line saying how it ended when somebody else stops
 *  one or it stops by itself (stoppedWords). The words are claimed once per
 *  run across every window, and only while `present` (this window on screen
 *  and focused): a hidden window that showed it to nobody must not stand the
 *  others down. A notice still owed after a few seconds with nobody looking
 *  goes out through `say.away`, and a stop nobody saw stays owed until it is
 *  said, a newer run begins, or it is old news. */
function useRecordingNotices(roomKey: string | null, present: boolean, say: RecordingSay): void {
  // The run as the room's row has it: null when nothing runs. A room whose
  // row has not landed reads as nothing running, and a run already filming
  // when it lands is then told as one walked in on.
  const { live } = useRoomRecordingMark(roomKey);
  // Read in the effect, not a dependency: the end lands with the push that
  // ends the run, and a later change to it is not a new stop.
  const ended = useRoomRecordingEnded(roomKey);
  const endedRef = useRef(ended);
  endedRef.current = ended;
  const sayRef = useRef(say);
  sayRef.current = say;
  const me = useMe();
  // What this window has seen of the room's runs (shared with the phone:
  // lib/calls/roomRecordingEnd watchRoomRun).
  const seen = useRef<RoomRunWatch>(roomRunWatch(null));
  useWatchEffect(() => {
    if (seen.current.room !== roomKey) seen.current = roomRunWatch(roomKey);
    if (!roomKey) return;
    const { running, stopped } = watchRoomRun(seen.current, live, endedRef.current, pressedRunOf(roomKey), recordingNoticed, Date.now());
    if (running && !cued.has(running.run_id)) {
      cued.add(running.run_id);
      soundRecordingOn(running.run_id);
    }
    if (stopped) soundRecordingOff(stopped.run_id);
    // A notice is claimed once it was said: at once where a person is
    // looking, and for a banner only if it went up (the shell holds one back
    // when a codecast window is in front, and that window says it itself).
    const claim = (key: string, said: void | Promise<boolean>, then?: () => void) => {
      const done = () => (noteRecordingNoticed(key), then?.());
      if (!said) return done();
      void said.then((shown) => shown && done()).catch(() => {});
    };
    /** Say what is still owed, through `how`; each claimed as it is said. */
    const settle = (how: Pick<RecordingSay, "started" | "stopped" | "saved"> | NonNullable<RecordingSay["away"]>) => {
      const owed = owedStopNotice(seen.current, endedRef.current, me, recordingNoticed, Date.now());
      if (owed) {
        const drop = () => void (seen.current.stop === owed.stop && (seen.current.stop = null));
        if (owed.how === "drop") drop();
        // Their own Stop: not that it stopped, only where it went once it
        // landed, in one window.
        else if (owed.how === "saved" && owed.end) claim(owed.key, how.saved(owed.stop.was, owed.end), drop);
        else if (owed.how === "say") claim(owed.key, how.stopped(owed.stop.was, owed.end), drop);
      }
      if (owesRecordingNotice(running, me)) claim(running.run_id, how.started(running));
    };
    if (present) return settle(sayRef.current);
    if (!sayRef.current.away || (!seen.current.stop && !owesRecordingNotice(running, me))) return;
    const timer = setTimeout(() => sayRef.current.away && settle(sayRef.current.away), AWAY_MS);
    return () => clearTimeout(timer);
  }, [roomKey, live?.run_id, live?.status, ended?.run_id, ended?.status, me, present]);
}

/** Open the call page a notice names: in the main window from the call's
 *  own window (the desktop's voice window, a popped out stage), here
 *  anywhere else. */
function useOpenCallPage(): (href: string) => void {
  const router = useRouter();
  return (href) => {
    if (isCallPanelWindow() && navigateMainWindow(href)) return;
    router.push(href);
  };
}

/** The stage's own notice, for the call window: the toast that tells the
 *  rest of the app lives in the main window, and a stage in a window of its
 *  own is where the person is looking. Said once per run (shared with the
 *  toast), never to whoever pressed, with Stop a deliberate two presses
 *  away; somebody else's Stop gets a quiet line that goes by itself, naming
 *  the call the video went to with a way to open it, and the presser gets
 *  one such line once their run has landed. */
export function RecordingNoticeBanner({ roomKey }: { roomKey: string | null }) {
  const present = useWindowPresent();
  const me = useMe();
  const openCall = useOpenCallPage();
  const [shown, setShown] = useState<{
    live: RoomRecordingLive;
    mode: "started" | "confirm" | "stopped" | "saved";
    end?: RoomRecordingEnd | null;
  } | null>(null);
  useRecordingNotices(roomKey, present, {
    started: (live) => setShown({ live, mode: "started" }),
    stopped: (live, end) => setShown({ live, mode: "stopped", end }),
    saved: (live, end) => setShown({ live, mode: "saved", end }),
  });
  const ending = shown?.mode === "stopped" || shown?.mode === "saved";
  // A run that stopped by itself while the huddle goes on stays said until
  // somebody dismisses it: the mark going away is easy to miss.
  const sticky = shown?.mode === "stopped" && stoppedByItself(shown.end);
  useWatchEffect(() => {
    if (!ending || sticky) return;
    const timer = setTimeout(() => setShown((cur) => (cur?.mode === "stopped" || cur?.mode === "saved" ? null : cur)), 8_000);
    return () => clearTimeout(timer);
  }, [shown?.mode, shown?.live.run_id, sticky]);
  const { status, unavailable } = useRoomRecordingMark(roomKey);
  if (!shown || !roomKey) return null;
  // Somebody already pressed again: the old run's line has nothing to offer.
  const again = sticky && !unavailable && !filming(status);
  // A run that ended without a word from here (this window's own Stop) takes
  // its notice with it.
  if (!ending && (status === null || status === "stopping")) return null;
  const stopped =
    shown.mode === "stopped"
      ? stoppedWords(shown.end ?? null, me)
      : shown.mode === "saved"
        ? { title: savedWords(shown.end ?? null), body: "", failed: false }
        : null;
  const words = stopped ?? { title: STARTED_TITLE, body: startedWords(shown.live) };
  const href = ending ? recordingEndHref(shown.end) : null;
  return (
    <div
      role="status"
      className={`pointer-events-auto flex max-w-[380px] items-start gap-2.5 rounded-lg bg-sol-base03/90 px-3 py-2.5 shadow-2xl ring-1 backdrop-blur animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none ${
        stopped?.failed ? "ring-sol-orange/30" : stopped ? "ring-white/10" : "ring-sol-red/30"
      }`}
    >
      {shown.mode === "confirm" ? (
        <div className="min-w-0 flex-1">
          <StopRecordingQuestion
            onStop={() => {
              setShown(null);
              stopForEveryone(roomKey)();
            }}
            onKeep={() => setShown({ ...shown, mode: "started" })}
          />
        </div>
      ) : (
        <>
          <span
            className={
              stopped?.failed
                ? "mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-sol-orange"
                : stopped
                  ? "mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-sol-text-dim"
                  : "rec-pill-dot rec-pill-dot--sm mt-[5px]"
            }
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12px] text-sol-text">{words.title}</div>
            {words.body && <div className="mt-0.5 text-[11.5px] leading-snug text-sol-text-muted">{words.body}</div>}
            {(href || sticky) && (
              <div className="mt-2 flex items-center gap-1.5">
                {again && (
                  <button
                    type="button"
                    onClick={() => {
                      setShown(null);
                      void setRoomRecording(roomKey, true);
                    }}
                    className="rounded-md bg-sol-red/15 px-2 py-0.5 font-mono text-[11px] text-sol-red transition-colors hover:bg-sol-red/25"
                    title="Start recording this huddle again. Everyone in it is told"
                  >
                    Record again
                  </button>
                )}
                {href && (
                  <button
                    type="button"
                    onClick={() => {
                      setShown(null);
                      openCall(href);
                    }}
                    className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-sol-text transition-colors hover:bg-white/10"
                    title="Open the call page at the recording"
                  >
                    Open
                  </button>
                )}
                {sticky && (
                  <button
                    type="button"
                    onClick={() => setShown(null)}
                    className="rounded-md px-2 py-0.5 font-mono text-[11px] text-sol-text-muted transition-colors hover:bg-white/10 hover:text-sol-text"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            )}
            {shown.mode === "started" && (
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShown(null)}
                  className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-sol-text transition-colors hover:bg-white/10"
                >
                  Got it
                </button>
                <button
                  type="button"
                  onClick={() => setShown({ ...shown, mode: "confirm" })}
                  className="rounded-md px-2 py-0.5 font-mono text-[11px] text-sol-text-muted transition-colors hover:bg-sol-red/10 hover:text-sol-red"
                >
                  Stop recording
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The main window's notice: a toast for a run somebody else started in the
 *  room this person sits in (wherever the call itself lives), or one already
 *  running when they walked in, and a quiet line when somebody else stops it.
 *  With no codecast window in front (the usual posture in a huddle: the
 *  person is in their editor, the faces floating over it), the same words go
 *  out as a system banner, the way a knock at the door does. The call window
 *  has its banner instead, and there this only keeps the sound. Mounted with
 *  the app's call effects. */
export function useRecordingNoticeToast(): void {
  const me = useMe();
  const openCall = useOpenCallPage();
  // The toast's way to the video: the call page at the run, when the end
  // says which call it went to.
  const openAction = (end: RoomRecordingEnd | null) => {
    const href = recordingEndHref(end);
    return href ? { action: { label: "Open", onClick: () => openCall(href) } } : {};
  };
  const panel = isCallPanelWindow();
  const seated = useSeatedRoomKey();
  const present = useWindowPresent();
  const roomKey = seated;
  const recordingUnavailable = useRoomRecordingMark(roomKey).unavailable;
  // A banner counts as said only where one can go up: the desktop shell, or
  // a browser the person let notify. Anywhere else the notice stays owed and
  // the toast says it when they come back.
  const banner = async (key: string, title: string, body: string) =>
    (isElectron() || hasBrowserNotificationPermission()) && (await notifyNative(title, body, { key: `call-recording:${key}` }));
  useRecordingNotices(roomKey, present && !panel, {
    started: (live) => {
      const id = `call-recording-${live.run_id}`;
      toast(STARTED_TITLE, {
        id,
        description: startedWords(live),
        duration: 10_000,
        action: {
          label: "Stop recording",
          // Stopping is for everyone, so the toast asks once more in place
          // rather than ending the room's recording on a stray click.
          onClick: (e) => {
            e.preventDefault();
            toast(STOP_RECORDING_ASK.title, {
              id,
              description: STOP_RECORDING_ASK.body,
              duration: 10_000,
              action: { label: "Stop", onClick: () => roomKey && stopForEveryone(roomKey)() },
              cancel: { label: "Keep recording", onClick: () => {} },
            });
          },
        },
      });
    },
    stopped: (live, end) => {
      toast.dismiss(`call-recording-${live.run_id}`);
      const words = stoppedWords(end, me);
      // Stopped by itself while this person sits in the call: it stays until
      // closed, and offers to record again (the video, if any, a second
      // button). The server refuses a press it cannot honour and says why.
      const href = recordingEndHref(end);
      const sticky = stoppedByItself(end) && !!roomKey;
      (words.failed ? toast.warning : toast)(words.title, {
        ...(words.body ? { description: words.body } : {}),
        ...(sticky
          ? {
              ...persistentToast,
              ...(recordingUnavailable
                ? openAction(end)
                : {
                    action: { label: "Record again", onClick: () => roomKey && void setRoomRecording(roomKey, true) },
                    ...(href ? { cancel: { label: "Open", onClick: () => openCall(href) } } : {}),
                  }),
            }
          : { ...openAction(end), duration: 8_000 }),
      });
    },
    saved: (live, end) => {
      toast(savedWords(end), { id: `call-recording-${live.run_id}`, ...openAction(end), duration: 8_000 });
    },
    ...(panel
      ? {}
      : {
          away: {
            started: (live) => banner(live.run_id, STARTED_TITLE, startedWords(live)),
            stopped: (live, end) => {
              const words = stoppedWords(end, me);
              return banner(`stop:${live.run_id}`, words.title, words.body);
            },
            saved: (live, end) => banner(`stop:${live.run_id}`, savedWords(end), ""),
          },
        }),
  });
}
