import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { callRecordingUrlWindow, humanizeConvexError } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useNowWhen } from "./useCoarseNow";
import { subscribeWalkie, walkieCallState } from "../lib/calls/walkie";

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

/** The room this person is seated in, from any window. On desktop the voice
 *  host window holds every call and this window's own call slice stays idle
 *  for as long as it does (lib/faces/faceRow), so the seat is read where the
 *  face row reads it: walkieCallState, the host's mirror in a remote window
 *  and this window's slice everywhere else. */
export function useSeatedRoomKey(): string | null {
  return useSyncExternalStore(subscribeSeat, readSeat, readSeat);
}
const readSeat = (): string | null => {
  const call = walkieCallState();
  return call.phase === "connected" ? call.roomKey : null;
};
function subscribeSeat(cb: () => void): () => void {
  const offs = [useInboxStore.subscribe(cb), subscribeWalkie(cb)];
  return () => offs.forEach((off) => off());
}

/** The room's recording in detail: undefined while loading, null when it
 *  cannot be known here (a server that predates recording, a room this
 *  viewer may not see). */
export function useRoomRecording(roomKey: string | null | undefined): RoomRecordingState | null | undefined {
  const { data, error } = useQueryNoThrow(api.callRecordings.getRoomRecording, roomKey ? { room_key: roomKey } : "skip");
  if (error) return null;
  return (data ?? undefined) as RoomRecordingState | undefined;
}

/** The red mark for a room, as recordingMarkStatus settles it, with the
 *  detail it was settled from (for the clock and who pressed). */
export function useRoomRecordingMark(roomKey: string | null | undefined): {
  status: RoomRecordingLive["status"] | null;
  live: RoomRecordingLive | null;
  state: RoomRecordingState | null | undefined;
} {
  const flag = useRoomRecordingOn(roomKey);
  const press = useRoomRecordingPress(roomKey);
  const state = useRoomRecording(roomKey);
  const live = state ? state.live : undefined;
  return { status: recordingMarkStatus({ press, flag, live }), live: live ?? null, state };
}

// ── Pressing ─────────────────────────────────────────────────────────────
//
// `recording` is the server's flag, not the presser's: a run can start and end
// between two pushes (LiveKit refuses it, somebody stops it a moment later),
// so the store paints the press at once and takes the server's word on every
// push (callRooms.unprotectedFields; a field lock would wait forever for a
// value the server may never send). What carries the press across the round
// trip is the press itself, in flight: this window's own Record or Stop,
// from the tap until the server has answered it. It is not a copy of the flag
// and never outlives the dispatch.

const presses = new Map<string, boolean>();
const pressListeners = new Set<() => void>();
const notePress = (roomKey: string, on: boolean | null) => {
  if (on === null) presses.delete(roomKey);
  else presses.set(roomKey, on);
  pressListeners.forEach((fn) => fn());
};
const subscribePresses = (fn: () => void) => {
  pressListeners.add(fn);
  return () => void pressListeners.delete(fn);
};

// When this window last pressed Stop on a room: the person who stopped a
// recording is not told that it stopped.
const stops = new Map<string, number>();
const STOPPED_HERE_MS = 30_000;

/** Did this window stop the room's recording a moment ago? */
export function stoppedHere(roomKey: string): boolean {
  return Date.now() - (stops.get(roomKey) ?? 0) < STOPPED_HERE_MS;
}

/** This window's press on the room still in flight: true for Record, false
 *  for Stop, null when there is none. */
export function useRoomRecordingPress(roomKey: string | null | undefined): boolean | null {
  const read = () => (roomKey ? (presses.get(roomKey) ?? null) : null);
  return useSyncExternalStore(subscribePresses, read, read);
}

/** Press Record or Stop for the whole room. The mark moves at once (store
 *  setRoomRecording) and holds while the press is in flight; a refused press
 *  rolls it back and says why. */
export function setRoomRecording(roomKey: string, on: boolean): Promise<void> {
  notePress(roomKey, on);
  if (!on) stops.set(roomKey, Date.now());
  return useInboxStore
    .getState()
    .setRoomRecording(roomKey, on)
    .then(
      () => undefined,
      (err: unknown) => {
        useInboxStore.getState().undoRoomRecordingPress(roomKey, on);
        toast.error(humanizeConvexError(err));
      },
    )
    .finally(() => notePress(roomKey, null));
}

/**
 * What the red mark says, from the three things a window knows: its own
 * press in flight, the room's flag (store, fed by getLiveRooms), and the
 * detail (getRoomRecording, null when nothing runs, undefined when unknown).
 * The two server reads arrive by different roads and either can lag the
 * other, so neither is decisive alone: a press in flight is, then the detail
 * whenever it is known, and the flag only on a server too old to give the
 * detail. Null: no mark.
 */
export function recordingMarkStatus(input: {
  press: boolean | null;
  flag: boolean;
  live: RoomRecordingLive | null | undefined;
}): RoomRecordingLive["status"] | null {
  const { press, flag, live } = input;
  if (press === true) return live?.status === "recording" ? "recording" : "starting";
  if (press === false) return live ? "stopping" : null;
  if (live !== undefined) return live?.status ?? null;
  return flag ? "recording" : null;
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

// One entry holding the last runs told, newest last: a key per run would
// pile up for ever.
const NOTICED_KEY = "codecast.callRecord.noticed";
const NOTICED_KEEP = 50;

function noticedRuns(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(NOTICED_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function recordingNoticed(runId: string): boolean {
  return noticedRuns().includes(runId);
}

export function noteRecordingNoticed(runId: string): void {
  try {
    const list = noticedRuns().filter((id) => id !== runId);
    localStorage.setItem(NOTICED_KEY, JSON.stringify([...list, runId].slice(-NOTICED_KEEP)));
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

/** A call's recordings (`cl-42` or a full id): undefined while loading, null
 *  when there is nothing to show (no such call for this viewer, or a server
 *  without callRecordings, whose error degrades to "no video" rather than a
 *  surface that waits forever). */
export function useCallRecordings(call: string | null | undefined): CallRecordings | null | undefined {
  const urlWindow = useCallRecordingUrlWindow();
  // The window rolling over is a refresh, not a new question: the last answer
  // stands while the next loads, so the player on screen is never unmounted.
  const { data, error } = useQueryNoThrow(api.callRecordings.webCallRecordings, call ? { call, url_window: urlWindow } : "skip", {
    keepPrevious: call ?? undefined,
  });
  if (error) return null;
  return data as CallRecordings | null | undefined;
}

/** A row as the player and the frame embed read it (lib/calls/callVideo). */
export function toVideoFile(r: CallRecordingRow) {
  return { ...r, id: r._id };
}
