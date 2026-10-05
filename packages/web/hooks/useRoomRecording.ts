import { useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { useCollectionRows } from "./useCollectionRows";
import { subscribeWalkie, walkieCallState } from "../lib/calls/walkie";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
import { pressRoomRecording } from "../lib/calls/recordingPress";
import { sayRefusal } from "../lib/calls/sayRefusal";
export { useRoomRecordingMark, useRoomRecordingOn } from "../lib/calls/recordingPress";
export { roomRecordingFields, roomRecordingLive, roomRecordingOn, type RoomRecordingFields, type RoomRecordingLive } from "../lib/calls/roomRecordingFields";

// A huddle's video recording, as the room's people see it (convex
// callRecordings).
//
// ONE HOME. Whether a room is being recorded, by whom, since when, and
// whether a press could work at all, live on the room's callRooms row, fed by
// calls.getLiveRooms (hooks/useCallSync) with the room's other flags. Every
// surface reads that row: the red mark on the stage, the face row's card, the
// live room list, the Record button, the notice. No surface subscribes to a
// query of its own for it, so an always-mounted mark costs nothing and no two
// of them can disagree about whether the room is being filmed.
//
// The one thing the row does not hold is how the LAST run ended (who stopped
// it, or why it stopped itself), which only the notice says:
// useRoomRecordingEnded, an enrichment query, so a server without it degrades
// to "Recording stopped".

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

// ── Pressing ─────────────────────────────────────────────────────────────

/** Press Record or Stop for the whole room, from any web surface (the
 *  shared press, lib/calls/recordingPress): a press that does not land is
 *  said in a toast, or, on the desktop float, which has none and whose REC
 *  mark is a Stop, in a system banner (lib/calls/sayRefusal). */
export function setRoomRecording(roomKey: string, on: boolean): Promise<void> {
  return pressRoomRecording(roomKey, on, sayRefusal(on ? "Could not start recording" : "Could not stop the recording"));
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


// ── A call's files ───────────────────────────────────────────────────────
//
// Fed and read through lib/calls/callRecordingsFeed (Metro-safe, so the
// phone reads the same rows); re-exported here for web callers.

export {
  forgetCallRecordings,
  lapsedRowsVerdict,
  releasedRecordingTombstones,
  useCallRecordings,
  useCallRecordingUrlWindow,
  type CallFrameShare,
  type CallRecordingRow,
  type CallRecordings,
} from "../lib/calls/callRecordingsFeed";
import type { CallFrameShare, CallRecordingRow, StoredFrameShare } from "../lib/calls/callRecordingsFeed";

/** Delete a recording run from the call page: it leaves at once (store
 *  deleteCallRecording). A refusal has already put it back by the time the
 *  promise rejects (the receipt's rollback), so only the reason is left to
 *  say. A failure that is not a refusal stays queued and lands later. */
export function deleteRecordingRun(recordingId: string): void {
  void useInboxStore
    .getState()
    .deleteCallRecording(recordingId)
    .catch((err: unknown) => {
      if (isRefusedDispatchError(err)) toast.error(humanizeConvexError(err));
    });
}

/** The pictures of a call on public links, newest first, from the store
 *  (fed with the call's files by useCallRecordings, which the page mounts). */
export function useCallFrameShares(transcriptId: string | null | undefined): CallFrameShare[] {
  const where = useMemo(() => (r: StoredFrameShare) => r.transcript_id === transcriptId, [transcriptId]);
  const rows = useCollectionRows<StoredFrameShare>("callFrameShares", { where, sig: shareSig, sort: newestShareFirst });
  return transcriptId ? rows : NO_SHARES;
}
const shareSig = (r: StoredFrameShare) => `${r.url}|${r.at_ms}|${r.kind}|${r.participant_name}|${r.shared_by_name}|${r.created_at}`;
const newestShareFirst = (a: StoredFrameShare, b: StoredFrameShare) => b.created_at - a.created_at;
const NO_SHARES: StoredFrameShare[] = [];

/** Take a picture off its public link (store deleteCallFrameShare): it
 *  leaves the list on the press. Any failure that is not a refusal stays
 *  queued and lands later. */
export function takeDownFrameShare(shareId: string): void {
  void useInboxStore
    .getState()
    .deleteCallFrameShare(shareId)
    .catch((err: unknown) => {
      if (isRefusedDispatchError(err)) toast.error(humanizeConvexError(err));
    });
}

/** Turn the call's video on or off for its share link (store
 *  setCallShareVideo). A refusal lifts the switch's lock, so it falls back
 *  to what the server holds, and says why; any other failure stays queued. */
export function setCallVideoShared(transcriptId: string, include: boolean): void {
  void useInboxStore
    .getState()
    .setCallShareVideo(transcriptId, include)
    .catch((err: unknown) => {
      if (isRefusedDispatchError(err)) toast.error(humanizeConvexError(err));
    });
}

/** A row as the player and the frame embed read it (lib/calls/callVideo). */
export function toVideoFile(r: CallRecordingRow) {
  return { ...r, id: r._id };
}
