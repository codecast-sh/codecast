import { useRef, useState } from "react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  noteRecordConfirmed,
  noteRecordingNoticed,
  owesRecordingNotice,
  recordConfirmed,
  setRoomRecording,
  useRoomRecording,
  useRoomRecordingOn,
  type RoomRecordingLive,
} from "../../hooks/useRoomRecording";
import { isCallPanelWindow } from "../../lib/desktop";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { RecordingMark } from "./RecordingMark";
import { firstName } from "./speakers";

// Recording a huddle, from inside it: the Record button on the stage's
// control bar, the red mark on the stage's header and on the face row's card,
// and the notice that tells everyone else in the room (convex
// callRecordings: LiveKit films the room on its own servers, so what is kept
// never depends on whose tab stayed open).
//
// The rules the surfaces keep: recording starts only on a press, the first
// press ever asks once and says the room will be told, the room IS told
// (everyone present, anyone who joins later), and anyone in the room can stop
// it. The mark is read from the room's flag in the store, so every surface
// agrees and an always-mounted one costs no subscription; the detail (who
// pressed, the clock) is the stage's own read.

const useMe = () => useInboxStore((s: any) => s.currentUser?._id?.toString?.() ?? null);

/** The stage header's mark: REC and the time filmed, while the room records. */
export function StageRecordingBadge({ roomKey }: { roomKey: string | null }) {
  const on = useRoomRecordingOn(roomKey);
  const live = useRoomRecording(roomKey)?.live ?? null;
  const me = useMe();
  if (!on && !live) return null;
  // The flag moves first on a press (the store's draft), the detail a round
  // trip later. So the flag decides on or off, and the detail only refines
  // it: filming once LiveKit's first frame landed, "starting" until then,
  // and "saving" from the moment Stop is pressed until the file is down.
  const status = on ? (live?.status === "recording" ? "recording" : "starting") : "stopping";
  return (
    <RecordingMark
      status={status}
      startedAt={status === "recording" ? live?.started_at : null}
      by={live ? (me && live.started_by.id === me ? "You" : firstName(live.started_by.name)) : null}
      className="ml-1"
    />
  );
}

/** The mark on a call's own card in the face row (header and float): the dot
 *  and REC, beside the controls, for the room the viewer is in. */
export function CallCardRecordingMark() {
  const roomKey = useInboxStore((s: any) => s.call.roomKey ?? null);
  const on = useRoomRecordingOn(roomKey);
  if (!on) return null;
  return <RecordingMark size="dot" className="mr-1" />;
}

// ── Record and Stop ──────────────────────────────────────────────────────

const STAGE_CTL = "rounded-full p-2 transition-colors";
const STAGE_CTL_IDLE = "text-sol-text-muted hover:bg-white/10 hover:text-sol-text";

/** The control bar's round button. Absent on a server where recording is
 *  not set up (a button that can only fail is worse than none), except while
 *  the room records: Stop is always offered to anyone in it. */
export function RecordButton({ roomKey }: { roomKey: string }) {
  const on = useRoomRecordingOn(roomKey);
  const state = useRoomRecording(roomKey);
  const [asking, setAsking] = useState(false);
  if (!on && !state?.configured) return null;
  const starting = on && state?.live?.status === "starting";

  const press = () => {
    if (on) return setRoomRecording(roomKey, false);
    if (!recordConfirmed()) return setAsking(true);
    setRoomRecording(roomKey, true);
  };

  return (
    <span className="relative">
      <button
        type="button"
        onClick={press}
        className={`${STAGE_CTL} ${on ? "bg-sol-red/15 text-sol-red hover:bg-sol-red/25" : STAGE_CTL_IDLE}`}
        title={on ? "Stop recording, for everyone" : "Record this huddle: video of everyone and any shared screen"}
        aria-label={on ? "Stop recording" : "Record this huddle"}
        aria-pressed={on}
      >
        <RecordGlyph on={on} starting={!!starting} />
      </button>
      {asking && (
        <RecordConfirm
          onCancel={() => setAsking(false)}
          onRecord={() => {
            setAsking(false);
            noteRecordConfirmed();
            setRoomRecording(roomKey, true);
          }}
        />
      )}
    </span>
  );
}

/** Record is the universal red dot in a ring; recording is the stop square.
 *  Drawn rather than an icon font glyph so the dot is red while the ring
 *  keeps the bar's quiet tone. */
function RecordGlyph({ on, starting }: { on: boolean; starting: boolean }) {
  if (on) {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center" aria-hidden="true">
        <span className={`h-[9px] w-[9px] rounded-[2px] bg-current ${starting ? "animate-pulse" : ""}`} />
      </span>
    );
  }
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.75px] border-current" aria-hidden="true">
      <span className="h-[7px] w-[7px] rounded-full bg-sol-red" />
    </span>
  );
}

/** The first press, ever: what recording does and who is told, once. */
function RecordConfirm({ onCancel, onRecord }: { onCancel: () => void; onRecord: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onCancel]);
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Record this huddle?"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // The stage collapses on Esc; this Esc only closes the question.
        e.stopPropagation();
        onCancel();
      }}
      className="absolute bottom-full left-1/2 z-10 mb-3 w-[300px] -translate-x-1/2 rounded-xl bg-sol-bg-alt p-3.5 text-left shadow-2xl ring-1 ring-white/5 animate-in fade-in slide-in-from-bottom-1 duration-150"
    >
      <div className="flex items-center gap-2 font-mono text-[12.5px] text-sol-text">
        <span className="h-2 w-2 rounded-full bg-sol-red" aria-hidden="true" />
        Record this huddle?
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-sol-text-secondary">
        Everyone in the call sees that it is being recorded, and anyone who joins later is told.
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-sol-text-muted">
        The video keeps faces, voices and shared screens, and stays with the call for the people in it. Anyone in the
        call can stop it.
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
          autoFocus
          onClick={onRecord}
          className="flex items-center gap-1.5 rounded-md bg-sol-red px-3 py-1.5 font-mono text-[11.5px] font-medium text-white transition-colors hover:bg-sol-red/85"
        >
          Record <KeyCap size="xs">Enter</KeyCap>
        </button>
      </div>
    </div>
  );
}

// ── Telling the room ─────────────────────────────────────────────────────

function noticeWords(live: RoomRecordingLive): { title: string; body: string } {
  return {
    title: "This call is being recorded",
    body: `${firstName(live.started_by.name)} started recording. Anyone in the call can stop it.`,
  };
}

/** The stage's own notice, for the call window: the toast that tells the
 *  rest of the app lives in the main window, and a stage in a window of its
 *  own is where the person is looking. Said once per run (shared with the
 *  toast), never to whoever pressed. */
export function RecordingNoticeBanner({ roomKey }: { roomKey: string | null }) {
  const live = useRoomRecording(roomKey)?.live ?? null;
  const me = useMe();
  const [shownRun, setShownRun] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Claim the run on first sight, so the toast in another window stands down,
  // and keep showing it here until dismissed.
  useWatchEffect(() => {
    if (owesRecordingNotice(live, me)) {
      noteRecordingNoticed(live.run_id);
      setShownRun(live.run_id);
    }
  }, [live?.run_id, live?.status, me]);
  if (!live || live.run_id !== shownRun || dismissed === shownRun || live.status === "stopping") return null;
  const words = noticeWords(live);
  return (
    <div
      role="status"
      className="pointer-events-auto flex max-w-[360px] items-start gap-2.5 rounded-lg bg-sol-base03/90 px-3 py-2.5 shadow-2xl ring-1 ring-sol-red/30 backdrop-blur animate-in fade-in slide-in-from-top-1 duration-200"
    >
      <span className="rec-pill-dot mt-[5px] !h-[7px] !w-[7px]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[12px] text-sol-text">{words.title}</div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-sol-text-muted">{words.body}</div>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(shownRun)}
        className="shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px] text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text"
      >
        Got it
      </button>
    </div>
  );
}

/** The main window's notice: a toast for a run somebody else started in the
 *  room this person is in, or one already running when they walked in. The
 *  call window has its banner instead. Mounted with the app's call effects. */
export function useRecordingNoticeToast(): void {
  const roomKey = useInboxStore((s: any) => (s.call.phase === "connected" ? s.call.roomKey ?? null : null));
  const panel = isCallPanelWindow();
  const live = useRoomRecording(panel ? null : roomKey)?.live ?? null;
  const me = useMe();
  useWatchEffect(() => {
    if (!roomKey || !owesRecordingNotice(live, me)) return;
    noteRecordingNoticed(live.run_id);
    const words = noticeWords(live);
    toast(words.title, {
      id: `call-recording-${live.run_id}`,
      description: words.body,
      duration: 10_000,
      action: { label: "Stop it", onClick: () => setRoomRecording(roomKey, false) },
    });
  }, [roomKey, live?.run_id, live?.status, me]);
}
