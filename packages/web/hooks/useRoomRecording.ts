import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { callRecordingUrlWindow, humanizeConvexError } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useNowWhen } from "./useCoarseNow";

// A huddle's video recording, as the room's people see it (convex
// callRecordings). Two reads, on purpose:
//
//   useRoomRecordingOn   the one bit every call surface paints (the red mark
//                        on the stage, the face row's card, the live room
//                        list): the `recording` flag on the room's callRooms
//                        row, fed by calls.getLiveRooms. Store only, so a
//                        surface that is always mounted costs no subscription.
//   useRoomRecording     the detail the stage and the notice need: whether a
//                        press could work at all on this server, who pressed,
//                        and when the room began to be filmed (the clock).
//                        Enrichment, so useQueryNoThrow: a server without
//                        callRecordings degrades to no Record button.

export type RoomRecordingLive = {
  status: "starting" | "recording" | "stopping";
  run_id: string;
  transcript_id: string;
  call_short_id: string | null;
  started_by: { id: string; name: string };
  requested_at: number;
  /** The file's time 0: when the room began to be filmed. Null while starting. */
  started_at: number | null;
};

export type RoomRecordingState = { configured: boolean; live: RoomRecordingLive | null };

/** Is the room being recorded right now (a run starting or filming)? */
export function useRoomRecordingOn(roomKey: string | null | undefined): boolean {
  return useInboxStore((s: any) => !!roomKey && !!s.callRooms?.[roomKey]?.recording);
}

/** The room's recording in detail, or undefined while unknown (loading, or a
 *  server that predates recording, or a room this viewer may not see). */
export function useRoomRecording(roomKey: string | null | undefined): RoomRecordingState | undefined {
  const { data } = useQueryNoThrow(api.callRecordings.getRoomRecording, roomKey ? { room_key: roomKey } : "skip");
  return (data ?? undefined) as RoomRecordingState | undefined;
}

/** Press Record or Stop for the whole room. The mark moves at once (store
 *  setRoomRecording); a refused press rolls it back and says why. */
export function setRoomRecording(roomKey: string, on: boolean): void {
  void useInboxStore
    .getState()
    .setRoomRecording(roomKey, on)
    .catch((err: unknown) => toast.error(humanizeConvexError(err)));
}

// ── The first-press confirmation ─────────────────────────────────────────
//
// Recording other people is a thing to do knowingly once. After the first
// confirmed press the button just records: the room is told every time
// regardless, so asking again would only slow the person who already knows.

const CONFIRMED_KEY = "codecast.callRecord.confirmed";

export function recordConfirmed(): boolean {
  try {
    return localStorage.getItem(CONFIRMED_KEY) === "1";
  } catch {
    return false;
  }
}

export function noteRecordConfirmed(): void {
  try {
    localStorage.setItem(CONFIRMED_KEY, "1");
  } catch {}
}

// ── The once-per-run notice ──────────────────────────────────────────────
//
// Everyone in the room is told a recording is running: those present when
// somebody else pressed, and anyone who walks in while it runs. Told ONCE per
// run, whichever surface says it first (a toast in the main window, the
// banner on a stage), so a person with the stage open and the app behind it
// is not told twice. Keyed in localStorage because every window of the app
// shares it.

const NOTICED_PREFIX = "codecast.callRecord.noticed.";

export function recordingNoticed(runId: string): boolean {
  try {
    return localStorage.getItem(NOTICED_PREFIX + runId) === "1";
  } catch {
    return false;
  }
}

export function noteRecordingNoticed(runId: string): void {
  try {
    localStorage.setItem(NOTICED_PREFIX + runId, "1");
  } catch {}
}

/** Who should be told about this run: everyone but the person who pressed
 *  (they confirmed it themselves), once. */
export function owesRecordingNotice(live: RoomRecordingLive | null | undefined, me: string | null): live is RoomRecordingLive {
  if (!live || live.status === "stopping") return false;
  if (me && live.started_by.id === me) return false;
  return !recordingNoticed(live.run_id);
}

// ── A call's files ───────────────────────────────────────────────────────

export type CallRecordingRow = {
  _id: string;
  run_id: string;
  kind: "composite" | "screen";
  status: "starting" | "recording" | "stopping" | "ready" | "failed";
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
  participant_identity: string | null;
  participant_name: string | null;
  started_by: string;
  started_by_name: string;
  requested_at: number;
  stop_reason: string | null;
  error: string | null;
  url: string | null;
  url_expires_at: number | null;
  can_delete: boolean;
};

export type CallRecordings = {
  transcript_id: string;
  short_id: string | null;
  call_started_at: number;
  call_ended_at: number | null;
  configured: boolean;
  share_link: boolean;
  video_shared: boolean;
  recordings: CallRecordingRow[];
};

/** The presigning window a page is in, moving only when it rolls over (four
 *  times an hour), so the recordings query is re-asked then and not on every
 *  tick (shared callRecordingUrlWindow). */
export function useCallRecordingUrlWindow(): number {
  const now = useNowWhen((t) => String(callRecordingUrlWindow(t)), 30_000);
  return callRecordingUrlWindow(now);
}

/** A call's recordings (`cl-42` or a full id), or undefined while unknown.
 *  Enrichment: a server without callRecordings answers nothing and the call
 *  reads as it always did. */
export function useCallRecordings(call: string | null | undefined): CallRecordings | null | undefined {
  const urlWindow = useCallRecordingUrlWindow();
  const { data } = useQueryNoThrow(api.callRecordings.webCallRecordings, call ? { call, url_window: urlWindow } : "skip");
  return data as CallRecordings | null | undefined;
}

/** A row as the player and the frame embed read it (lib/calls/callVideo). */
export function toVideoFile(r: CallRecordingRow) {
  return { ...r, id: r._id };
}
