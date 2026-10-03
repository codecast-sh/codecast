import { useRef, useState } from "react";
import { toast } from "sonner";
import { recordingFailureWords, recordingKeptWords } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWindowPresent } from "../../hooks/usePagePresence";
import { useFaceRowSelect, type FaceRow } from "../../hooks/useFaceRow";
import {
  noteRecordConfirmed,
  noteRecordingNoticed,
  owesRecordingNotice,
  recordConfirmed,
  recordingNoticed,
  setRoomRecording,
  stoppedHere,
  useRoomRecording,
  useRoomRecordingMark,
  useRoomRecordingPress,
  useSeatedRoomKey,
  type RoomRecordingEnd,
  type RoomRecordingLive,
} from "../../hooks/useRoomRecording";
import { isCallPanelWindow } from "../../lib/desktop";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { RecordingMark } from "./RecordingMark";
import { STAGE_CTL, STAGE_CTL_IDLE } from "./stageHost";
import { firstName, speakerShortName } from "./speakers";

// Recording a huddle, from inside it: the Record button on the stage's
// control bar, the red mark on the stage's header and on the face row's card,
// and the notice that tells everyone else in the room (convex
// callRecordings: LiveKit films the room on its own servers, so what is kept
// never depends on whose tab stayed open).
//
// The rules the surfaces keep: recording starts only on a press, the first
// press ever asks once and says the room will be told, the room IS told
// (everyone present, anyone who joins later), and anyone in the room can stop
// it. The mark is settled from this window's press in flight, the room's flag
// and the detail together (recordingMarkStatus), so every surface agrees.
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

/** The stage header's mark: REC and the time filmed, while the room records. */
export function StageRecordingBadge({ roomKey }: { roomKey: string | null }) {
  const { status, live } = useRoomRecordingMark(roomKey);
  const me = useMe();
  if (!status) return null;
  return (
    <RecordingMark
      status={status}
      startedAt={status === "recording" ? live?.started_at : null}
      by={byWords(live, me)}
      className="ml-1"
    />
  );
}

const selectEngagedRoom = (row: FaceRow) => row.room;

/** The mark on a call's own card in the face row (header and float): the dot
 *  and REC, beside the controls, for the room the card is about. */
export function CallCardRecordingMark() {
  const roomKey = useFaceRowSelect(selectEngagedRoom);
  const { status } = useRoomRecordingMark(roomKey);
  if (!status) return null;
  return <RecordingMark size="dot" className="mr-1" />;
}

// ── Record and Stop ──────────────────────────────────────────────────────

/** The control bar's round button. Absent on a server where recording is
 *  not set up (a button that can only fail is worse than none), except while
 *  the room records: Stop is always offered to anyone in it. Until the
 *  server has said which, the button's place is held, so the bar does not
 *  shift under the person's pointer when the answer lands. */
export function RecordButton({ roomKey }: { roomKey: string }) {
  const { status, state } = useRoomRecordingMark(roomKey);
  const press = useRoomRecordingPress(roomKey);
  const [asking, setAsking] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const on = status === "starting" || status === "recording";
  // The last run is still being written: a new one would be refused until it
  // is down (the server's cooldown), so the button says so instead.
  const saving = status === "stopping";

  if (!on && !saving && state === undefined) {
    return (
      <span className={`${STAGE_CTL} invisible`} aria-hidden="true">
        <RecordGlyph look="idle" />
      </span>
    );
  }
  if (!on && !saving && !state?.configured) return null;

  const pressButton = () => {
    if (asking) return setAsking(false);
    if (press !== null || saving) return;
    if (on) return void setRoomRecording(roomKey, false);
    if (!recordConfirmed()) return setAsking(true);
    void setRoomRecording(roomKey, true);
  };

  const title = saving
    ? "Saving the last recording. Record again in a moment"
    : on
      ? "Stop recording, for everyone"
      : "Record this huddle: video of everyone and any shared screen";
  return (
    <span ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={pressButton}
        disabled={saving}
        className={`${STAGE_CTL} ${
          on ? "bg-sol-red/15 text-sol-red hover:bg-sol-red/25" : saving ? "cursor-default text-sol-text-dim" : STAGE_CTL_IDLE
        }`}
        title={title}
        aria-label={saving ? "Saving the last recording" : on ? "Stop recording" : "Record this huddle"}
        aria-pressed={on}
        aria-expanded={asking || undefined}
      >
        <RecordGlyph look={saving ? "saving" : on ? (status === "starting" ? "starting" : "on") : "idle"} />
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
 *  (breathing while LiveKit has not begun); saving is the ring alone, dim.
 *  Drawn rather than an icon font glyph so the dot is red while the ring
 *  keeps the bar's quiet tone. */
function RecordGlyph({ look }: { look: "idle" | "starting" | "on" | "saving" }) {
  if (look === "on" || look === "starting") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center" aria-hidden="true">
        <span className={`h-[9px] w-[9px] rounded-[2px] bg-current ${look === "starting" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
      </span>
    );
  }
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.75px] border-current" aria-hidden="true">
      <span className={`h-[7px] w-[7px] rounded-full ${look === "saving" ? "animate-pulse bg-sol-red/40 motion-reduce:animate-none" : "bg-sol-red"}`} />
    </span>
  );
}

/** The first press, ever: what recording does, who is told and who can watch,
 *  once. Focus lands on the question, not on Record: filming a room is a
 *  deliberate press, never a stray Enter or Space. */
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
            className="rounded-md bg-sol-red px-3.5 py-1.5 font-mono text-[11.5px] font-medium text-white transition-colors hover:bg-sol-red/85"
          >
            Record
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Telling the room ─────────────────────────────────────────────────────

const STARTED_TITLE = "This call is being recorded";

function startedWords(live: RoomRecordingLive): string {
  return `${firstName(live.started_by.name)} started recording. Anyone in the call can stop it.`;
}

/** What the room is told when a run stops, from how it ended (convex
 *  roomRecordingEnd): who stopped it, or why it stopped on its own, and
 *  whether there is a video at all. "Saving" is said only of a run that was
 *  filming; a run LiveKit refused or lost left nothing to save. Unknown (a
 *  server older than the end facts), it says only that it stopped. */
export function stoppedWords(end: RoomRecordingEnd | null, me: string | null): { title: string; body: string; failed: boolean } {
  const by = end?.stopped_by ? (me && end.stopped_by.id === me ? "You" : speakerShortName(end.stopped_by.name)) : null;
  const pressed = by && end?.stop_reason === "pressed" ? `${by} stopped recording` : null;
  if (end?.status === "failed") {
    return { title: pressed ?? "Recording failed", body: recordingFailureWords(end.error), failed: !pressed };
  }
  const title = pressed ?? (end?.stop_reason === "limit" ? "Recording stopped at its time limit" : "Recording stopped");
  return { title, body: end ? "The video is saving to the call." : "", failed: false };
}

/** The room's recording as this window owes its person: the notice of a run
 *  somebody else started (or that was already running when they walked in),
 *  and a line saying how it ended when somebody else stops one or it stops
 *  by itself (stoppedWords). Each is claimed once per
 *  run across every window, and only while `present` (this window on screen
 *  and focused): a hidden window that showed it to nobody must not stand the
 *  others down. */
function useRecordingNotices(
  roomKey: string | null,
  present: boolean,
  say: { started: (live: RoomRecordingLive) => void; stopped: (live: RoomRecordingLive, end: RoomRecordingEnd | null) => void },
): void {
  const state = useRoomRecording(roomKey);
  const live = state ? state.live : undefined;
  // Read in the effect, not a dependency: the end lands in the same answer
  // that ends the run, and a later change to it is not a new stop.
  const ended = state?.ended ?? null;
  const me = useMe();
  // The run last seen filming in this room, to tell a stop from a room never
  // recorded.
  const seen = useRef<{ room: string | null; live: RoomRecordingLive | null }>({ room: null, live: null });
  useWatchEffect(() => {
    if (seen.current.room !== roomKey) seen.current = { room: roomKey, live: null };
    if (!roomKey || live === undefined) return;
    const was = seen.current.live;
    const running = live && live.status !== "stopping" ? live : null;
    if (running) seen.current.live = running;
    if (was && (!live || live.run_id !== was.run_id || live.status === "stopping")) {
      seen.current.live = running;
      const key = `stop:${was.run_id}`;
      if (present && !stoppedHere(roomKey) && !recordingNoticed(key)) {
        noteRecordingNoticed(key);
        say.stopped(was, ended?.run_id === was.run_id ? ended : null);
      }
    }
    if (present && owesRecordingNotice(running, me)) {
      noteRecordingNoticed(running.run_id);
      say.started(running);
    }
  }, [roomKey, live?.run_id, live?.status, live === undefined, me, present]);
}

/** The stage's own notice, for the call window: the toast that tells the
 *  rest of the app lives in the main window, and a stage in a window of its
 *  own is where the person is looking. Said once per run (shared with the
 *  toast), never to whoever pressed, with Stop a deliberate two presses
 *  away; somebody else's Stop gets a quiet line that goes by itself. */
export function RecordingNoticeBanner({ roomKey }: { roomKey: string | null }) {
  const present = useWindowPresent();
  const me = useMe();
  const [shown, setShown] = useState<{
    live: RoomRecordingLive;
    mode: "started" | "confirm" | "stopped";
    end?: RoomRecordingEnd | null;
  } | null>(null);
  useRecordingNotices(roomKey, present, {
    started: (live) => setShown({ live, mode: "started" }),
    stopped: (live, end) => setShown({ live, mode: "stopped", end }),
  });
  useWatchEffect(() => {
    if (shown?.mode !== "stopped") return;
    const timer = setTimeout(() => setShown((cur) => (cur?.mode === "stopped" ? null : cur)), 5_000);
    return () => clearTimeout(timer);
  }, [shown?.mode, shown?.live.run_id]);
  const { status } = useRoomRecordingMark(roomKey);
  if (!shown || !roomKey) return null;
  // A run that ended without a word from here (this window's own Stop) takes
  // its notice with it.
  if (shown.mode !== "stopped" && (status === null || status === "stopping")) return null;
  const stopped = shown.mode === "stopped" ? stoppedWords(shown.end ?? null, me) : null;
  const words =
    stopped
      ? stopped
      : shown.mode === "confirm"
        ? { title: "Stop recording for everyone?", body: "The video so far is kept with the call." }
        : { title: STARTED_TITLE, body: startedWords(shown.live) };
  const quiet = "rounded-md px-2 py-0.5 font-mono text-[11px] text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text";
  return (
    <div
      role="status"
      className={`pointer-events-auto flex max-w-[380px] items-start gap-2.5 rounded-lg bg-sol-base03/90 px-3 py-2.5 shadow-2xl ring-1 backdrop-blur animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none ${
        stopped?.failed ? "ring-sol-orange/30" : stopped ? "ring-white/10" : "ring-sol-red/30"
      }`}
    >
      <span
        className={
          stopped?.failed
            ? "mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-sol-orange"
            : stopped
              ? "mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-sol-text-dim"
              : "rec-pill-dot mt-[5px] !h-[7px] !w-[7px]"
        }
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[12px] text-sol-text">{words.title}</div>
        {words.body && <div className="mt-0.5 text-[11.5px] leading-snug text-sol-text-muted">{words.body}</div>}
        {shown.mode !== "stopped" && (
          <div className="mt-2 flex items-center gap-1.5">
            {shown.mode === "confirm" ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setShown(null);
                    void setRoomRecording(roomKey, false);
                  }}
                  className="rounded-md bg-sol-red px-2 py-0.5 font-mono text-[11px] font-medium text-white transition-colors hover:bg-sol-red/85"
                >
                  Stop
                </button>
                <button type="button" onClick={() => setShown({ ...shown, mode: "started" })} className={quiet}>
                  Keep recording
                </button>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The main window's notice: a toast for a run somebody else started in the
 *  room this person sits in (wherever the call itself lives), or one already
 *  running when they walked in, and a quiet line when somebody else stops it.
 *  The call window has its banner instead. Mounted with the app's call
 *  effects. */
export function useRecordingNoticeToast(): void {
  const me = useMe();
  const panel = isCallPanelWindow();
  const seated = useSeatedRoomKey();
  const present = useWindowPresent();
  const roomKey = panel ? null : seated;
  useRecordingNotices(roomKey, present, {
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
            toast("Stop recording for everyone?", {
              id,
              description: "The video so far is kept with the call.",
              duration: 10_000,
              action: { label: "Stop", onClick: () => roomKey && void setRoomRecording(roomKey, false) },
              cancel: { label: "Keep recording", onClick: () => {} },
            });
          },
        },
      });
    },
    stopped: (live, end) => {
      toast.dismiss(`call-recording-${live.run_id}`);
      const words = stoppedWords(end, me);
      (words.failed ? toast.warning : toast)(words.title, {
        ...(words.body ? { description: words.body } : {}),
        duration: words.failed ? 8_000 : 5_000,
      });
    },
  });
}
