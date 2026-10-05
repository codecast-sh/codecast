import { useRef, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { isRecordingFilming } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useWindowPresent } from "../../hooks/usePagePresence";
import { useFaceRowSelect, type FaceRow } from "../../hooks/useFaceRow";
import {
  noteRecordConfirmed,
  noteRecordingNoticed,
  owesRecordingNotice,
  recordConfirmed,
  recordingNoticed,
  setRoomRecording,
  useRoomRecordingMark,
  useSeatedRoomKey,
  type RoomRecordingLive,
} from "../../hooks/useRoomRecording";
import { pressedRunOf, useRecordingCooling, useRoomRecordingPress } from "../../lib/calls/recordingPress";
import {
  owedStopNotice,
  RECORD_ASK,
  RECORDING_STARTED_TITLE,
  roomRunWatch,
  startedWords,
  stopNoticeCard,
  stopNoticeKey,
  useRoomRecordingEnded,
  watchRoomRun,
  type RoomRecordingEnd,
  type RoomRunWatch,
} from "../../lib/calls/roomRecordingEnd";
import { hasBrowserNotificationPermission, isCallPanelWindow, isElectron, navigateMainWindow, notifyNative } from "../../lib/desktop";
import { soundRecordingOff, soundRecordingOn } from "../../lib/sounds";
import { persistentToast } from "../../lib/persistentToast";
import { KeyCap } from "../KeyboardShortcutsHelp";
import {
  PLACE,
  QUESTION_BODY,
  QUESTION_TITLE,
  RecordingMark,
  RecordingQuestionBox,
  RecordingStopControl,
  SAVING_DOT_COLOR,
  STOP_RECORDING_ASK,
  StopRecordingQuestion,
} from "./RecordingMark";
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
  if (!isRecordingFilming(status)) return <span className="ml-1 flex shrink-0">{mark}</span>;
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
  const on = isRecordingFilming(status);
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

/** Record on a call's own card in the header's face row, beside the mark:
 *  the control a person in a huddle sees most of the time, so the press is
 *  there and not only on the stage. While the room records the mark beside
 *  it is the Stop, so this draws nothing then. Not on the float: a window
 *  sized to its card would cut the first press's question off. */
export function CallCardRecordButton() {
  const roomKey = useFaceRowSelect(selectEngagedRoom);
  return roomKey ? <RecordButton roomKey={roomKey} variant="card" /> : null;
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
/**
 * Record, wherever a seated person can press it: the stage's control bar
 * (`stage`, a square control with the question above it), the call's card
 * in the header (`card`, a switch on the card's plate with the question
 * below; its Stop is the mark beside it) and the Calls page's own column
 * (`wide`, a labelled button with the question below), so
 * someone who went to Calls to record the huddle they are in finds the same
 * press, the same first-time question and the same Stop the stage has.
 */
export function RecordButton({ roomKey, variant = "stage" }: { roomKey: string; variant?: "stage" | "wide" | "card" }) {
  const { status, live, configured, unavailable } = useRoomRecordingMark(roomKey);
  const press = useRoomRecordingPress(roomKey);
  const [asking, setAsking] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const on = isRecordingFilming(status);
  const wide = variant === "wide";
  const card = variant === "card";
  // The last run is still being written. A new press waits only the
  // server's short cooldown after the stop (the shared rule, counted from
  // the stop rather than from LiveKit's upload, which can take minutes), then
  // records while the last file is still saving.
  const cooling = useRecordingCooling(status, status === "stopping" ? (live?.stop_requested_at ?? null) : null);
  const stillSaving = status === "stopping" && !cooling;

  // On the call's card the red mark beside it is already the Stop
  // (CallCardRecordingMark): one control per run, never two.
  if (on && card) return null;
  if (on) {
    return (
      <RecordingStopControl
        onStop={stopForEveryone(roomKey)}
        place={wide ? "below-start" : "above"}
        disabled={press !== null}
        label="Stop recording"
        title="Stop recording, for everyone"
        className={wide ? "block" : ""}
        buttonClassName={
          wide
            ? `${WIDE_CTL} border border-sol-red/50 bg-sol-red/12 text-sol-red hover:bg-sol-red/20`
            : `${STAGE_CTL} bg-sol-red/15 text-sol-red hover:bg-sol-red/25`
        }
      >
        <RecordGlyph look={status === "starting" ? "starting" : "on"} />
        {wide && "Recording this huddle. Stop"}
      </RecordingStopControl>
    );
  }
  if (!cooling && configured === undefined) {
    // The card has no bar to hold steady, and its row hangs under the faces:
    // nothing until the row has said, rather than an empty gap in the plate.
    if (card) return null;
    return (
      <span className={`${wide ? WIDE_CTL : STAGE_CTL} invisible`} aria-hidden="true">
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
    <span ref={wrapRef} className={`relative${wide ? " block" : card ? " engagement-card-toggles" : ""}`}>
      <button
        type="button"
        onClick={pressButton}
        data-card-action={card ? "record" : undefined}
        // aria-disabled, not disabled, when blocked: a disabled button shows
        // no tooltip, and the reason is the point.
        disabled={cooling}
        aria-disabled={blocked || undefined}
        className={
          wide
            ? `${WIDE_CTL} ${idle ? "bg-sol-red/15 text-sol-red hover:bg-sol-red/25" : "cursor-default bg-white/[0.04] text-sol-text-dim"}`
            : card
              ? `engagement-card-toggle${idle ? "" : " is-off cursor-default"}`
              : `${STAGE_CTL} ${idle ? STAGE_CTL_IDLE : "cursor-default text-sol-text-dim"}`
        }
        title={title}
        aria-label={cooling ? "Saving the last recording" : blocked ? `Recording unavailable: ${unavailable}` : "Record this huddle"}
        aria-pressed={false}
        aria-expanded={asking || undefined}
      >
        <RecordGlyph look={cooling ? "saving" : blocked ? "unavailable" : "idle"} small={card} />
        {wide && (cooling ? "Saving the last recording" : blocked ? "Recording unavailable" : "Record this huddle")}
      </button>
      {asking && (
        <RecordConfirm
          roomKey={roomKey}
          insideRef={wrapRef}
          place={wide || card ? "below-start" : "above"}
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

/** The labelled, full-width shape of a control (the Calls page's column). */
const WIDE_CTL = "flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors";

/** Record is the universal red dot in a ring; recording is the stop square
 *  (breathing while LiveKit has not begun); saving is the ring with a still,
 *  dim dot, the mark's own saving grey (SAVING_DOT_COLOR: red means the room
 *  is being filmed right now, and a run being saved is not); unavailable is
 *  the ring with a fainter still dot. Drawn rather than an icon font glyph so
 *  the dot is red while the ring keeps the bar's quiet tone. */
function RecordGlyph({ look, small = false }: { look: "idle" | "starting" | "on" | "saving" | "unavailable"; small?: boolean }) {
  if (small) {
    // The card's plate draws its switches at 14px (the mic and the camera).
    return (
      <span className="flex h-[14px] w-[14px] items-center justify-center rounded-full border-[1.5px] border-current" aria-hidden="true">
        <span
          className={`h-[6px] w-[6px] rounded-full ${
            look === "saving" ? SAVING_DOT_COLOR : look === "unavailable" ? "bg-sol-text-dim/50" : "bg-sol-red"
          }`}
        />
      </span>
    );
  }
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
          look === "saving" ? SAVING_DOT_COLOR : look === "unavailable" ? "bg-sol-text-dim/50" : "bg-sol-red"
        }`}
      />
    </span>
  );
}

/** The first press, ever: what recording does, who is told and who can watch,
 *  once, in the same box Stop asks in (RecordingQuestionBox). Focus lands on
 *  the question, not on Record, so a stray Space cannot film the room. Enter
 *  on the question records and Esc cancels, each shown on its button: the
 *  question is itself the deliberate second step. */
function RecordConfirm({
  roomKey,
  insideRef,
  place = "above",
  onCancel,
  onRecord,
}: {
  roomKey: string;
  /** The button and the question together: a press anywhere in it is not "outside". */
  insideRef: React.RefObject<HTMLElement | null>;
  /** Over a control bar at the bottom, or under a control at the top. */
  place?: keyof typeof PLACE;
  onCancel: () => void;
  onRecord: () => void;
}) {
  return (
    <RecordingQuestionBox label={RECORD_ASK.title} place={place} insideRef={insideRef} onClose={onCancel} onEnter={onRecord}>
      <div className={`flex items-center gap-2 ${QUESTION_TITLE}`}>
        <span className="h-2 w-2 rounded-full bg-sol-red" aria-hidden="true" />
        {RECORD_ASK.title}
      </div>
      <p className={`mt-2 ${QUESTION_BODY} text-sol-text-secondary`}>{RECORD_ASK.lines(roomKey)[0]}</p>
      <p className={`mt-1.5 ${QUESTION_BODY} text-sol-text-muted`}>{RECORD_ASK.lines(roomKey)[1]}</p>
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
    </RecordingQuestionBox>
  );
}

// ── Telling the room ─────────────────────────────────────────────────────

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
    // A stop is owed while the watch holds one, and so is a lost video's
    // word to its presser (owedStopNotice answers both).
    const owesStop = !!owedStopNotice(seen.current, endedRef.current, me, recordingNoticed, Date.now());
    if (!sayRef.current.away || (!owesStop && !owesRecordingNotice(running, me))) return;
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
  const stopped = ending ? stopNoticeCard(shown.mode === "saved" ? "saved" : "say", shown.end, me) : null;
  // A run that stopped by itself while the huddle goes on stays said until
  // somebody dismisses it: the mark going away is easy to miss.
  const sticky = !!stopped?.sticky;
  useWatchEffect(() => {
    if (!ending || sticky) return;
    const timer = setTimeout(() => setShown((cur) => (cur?.mode === "stopped" || cur?.mode === "saved" ? null : cur)), 8_000);
    return () => clearTimeout(timer);
  }, [shown?.mode, shown?.live.run_id, sticky]);
  const { status, unavailable } = useRoomRecordingMark(roomKey);
  if (!shown || !roomKey) return null;
  // Somebody already pressed again: the old run's line has nothing to offer.
  const again = sticky && !unavailable && !isRecordingFilming(status);
  // A run that ended without a word from here (this window's own Stop) takes
  // its notice with it.
  if (!ending && (status === null || status === "stopping")) return null;
  const words = stopped ?? { title: RECORDING_STARTED_TITLE, body: startedWords(shown.live) };
  const href = stopped?.href ?? null;
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
  const openAction = (href: string | null) => (href ? { action: { label: "Open", onClick: () => openCall(href) } } : {});
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
      toast(RECORDING_STARTED_TITLE, {
        id,
        description: startedWords(live),
        duration: 10_000,
        action: {
          label: STOP_RECORDING_ASK.stop,
          // Stopping is for everyone, so the toast asks once more in place
          // rather than ending the room's recording on a stray click.
          onClick: (e) => {
            e.preventDefault();
            toast(STOP_RECORDING_ASK.title, {
              id,
              description: STOP_RECORDING_ASK.body,
              duration: 10_000,
              action: { label: STOP_RECORDING_ASK.stop, onClick: () => roomKey && stopForEveryone(roomKey)() },
              cancel: { label: STOP_RECORDING_ASK.keep, onClick: () => {} },
            });
          },
        },
      });
    },
    stopped: (live, end) => {
      toast.dismiss(`call-recording-${live.run_id}`);
      const card = stopNoticeCard("say", end, me);
      // Stopped by itself while this person sits in the call: it stays until
      // closed, and offers to record again (the video, if any, a second
      // button). The server refuses a press it cannot honour and says why.
      const { href } = card;
      const sticky = card.sticky && !!roomKey;
      (card.failed ? toast.warning : toast)(card.title, {
        ...(card.body ? { description: card.body } : {}),
        ...(sticky
          ? {
              ...persistentToast,
              ...(recordingUnavailable
                ? openAction(href)
                : {
                    action: { label: "Record again", onClick: () => roomKey && void setRoomRecording(roomKey, true) },
                    ...(href ? { cancel: { label: "Open", onClick: () => openCall(href) } } : {}),
                  }),
            }
          : { ...openAction(href), duration: 8_000 }),
      });
    },
    saved: (live, end) => {
      const card = stopNoticeCard("saved", end, me);
      toast(card.title, { id: `call-recording-${live.run_id}`, ...openAction(card.href), duration: 8_000 });
    },
    ...(panel
      ? {}
      : {
          away: {
            started: (live) => banner(live.run_id, RECORDING_STARTED_TITLE, startedWords(live)),
            stopped: (live, end) => {
              const card = stopNoticeCard("say", end, me);
              return banner(stopNoticeKey(live.run_id), card.title, card.body);
            },
            saved: (live, end) => banner(stopNoticeKey(live.run_id), stopNoticeCard("saved", end, me).title, ""),
          },
        }),
  });
}
