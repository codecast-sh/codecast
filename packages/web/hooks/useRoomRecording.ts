import { useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { callRecordingUrlWindow, humanizeConvexError, type CallRecordingStopReason } from "@codecast/shared/contracts";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useFeederError } from "./useSyncCollection";
import { useConvexSync } from "./useConvexSync";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useCollectionRows } from "./useCollectionRows";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useNowWhen } from "./useCoarseNow";
import { subscribeWalkie, walkieCallState } from "../lib/calls/walkie";
import { syncTransaction } from "../store/syncTransaction";
import { isParkedDispatchError, isRefusedDispatchError } from "../store/mutativeMiddleware";
import { abandonRecordingPress } from "../lib/calls/recordingPress";
import { roomRecordingLive, roomRecordingOn, type RoomRecordingFields, type RoomRecordingLive } from "../lib/calls/roomRecordingFields";
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

/** How the room's last run ended (convex roomRecordingEnd): still being
 *  finished, finished, or failed, why, and who stopped it if somebody did.
 *  Absent on a server older than it. */
export type RoomRecordingEnd = {
  run_id: string;
  status: "stopping" | "ready" | "failed";
  stop_reason: CallRecordingStopReason | null;
  error: string | null;
  stopped_by: { id: string; name: string } | null;
  /** Where the video went: the call, its short id, and where in the call
   *  the file begins. Absent from a server older than them. */
  transcript_id?: string;
  short_id?: string | null;
  at_ms?: number | null;
};

const rowOf = (s: any, roomKey: string | null | undefined): RoomRecordingFields | undefined =>
  roomKey ? s.callRooms?.[roomKey] : undefined;

// Every recording field a surface paints, as one string: a room's row gets a
// new ref whenever any flag on it moves, and a mark must not re-render for a
// lock or a transcription switch.
const recordingSig = (row: RoomRecordingFields | undefined): string =>
  row
    ? `${row.recording ? 1 : 0}|${row.recording_status}|${row.recording_run_id}|${row.recording_by_id}|${row.recording_by_name}|${row.recording_requested_at}|${row.recording_started_at}|${row.recording_configured}|${row.recording_unavailable}|${row.recording_stop_requested_at}|${row.recording_video_shared ? 1 : 0}`
    : "";

/** Is the room being recorded right now (a run starting or filming)? */
export function useRoomRecordingOn(roomKey: string | null | undefined): boolean {
  return useInboxStore((s: any) => roomRecordingOn(s, roomKey));
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

/** How the room's last run ended, for the notice that says so: undefined
 *  while loading, null when it cannot be known here. Its own narrow query
 *  (callRecordings.getRoomRecordingEnd), whose read set is the room's ended
 *  runs alone: it is mounted in every window of everyone seated, for the
 *  whole huddle, and re-runs only as a run ends. */
export function useRoomRecordingEnded(roomKey: string | null | undefined): RoomRecordingEnd | null | undefined {
  const { data, error } = useQueryNoThrow(api.callRecordings.getRoomRecordingEnd, roomKey ? { room_key: roomKey } : "skip");
  if (error || data === null) return null;
  return data === undefined ? undefined : (data as RoomRecordingEnd);
}

/** The red mark for a room, as recordingMarkStatus settles it, with the run
 *  it was settled from (the clock, who pressed), whether a press could work
 *  on this server (undefined until the room's row says), and why it cannot
 *  right now when the server is set up but LiveKit is refusing (null when it
 *  can). */
export function useRoomRecordingMark(roomKey: string | null | undefined): {
  status: RoomRecordingLive["status"] | null;
  live: RoomRecordingLive | null;
  configured: boolean | undefined;
  unavailable: string | null;
} {
  const sig = useInboxStore((s: any) => recordingSig(rowOf(s, roomKey)));
  const press = useRoomRecordingPress(roomKey);
  return useMemo(() => {
    const row = rowOf(useInboxStore.getState(), roomKey);
    const live = roomRecordingLive(row);
    return {
      status: recordingMarkStatus({ press, flag: !!row?.recording, live }),
      live: live ?? null,
      configured: row?.recording_configured ?? undefined,
      unavailable: row?.recording_unavailable ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the row is read through its signature
  }, [roomKey, sig, press]);
}

// ── Pressing ─────────────────────────────────────────────────────────────
//
// The row's recording fields are the server's, not the presser's: a run can
// start and end between two pushes (LiveKit refuses it, somebody stops it a
// moment later), so the store paints the press at once and takes the server's
// word on every push (callRooms.unprotectedFields; a field lock would wait
// forever for a value the server may never send). What carries the press
// across the round trip is the press itself, in flight: this window's own
// Record or Stop, from the tap until the server has answered it. It is the
// dispatch's own state, not a copy of the row, and never outlives the
// dispatch.

type Press = { on: boolean; at: number };
const presses = new Map<string, Press>();
const pressListeners = new Set<() => void>();
const notePress = (roomKey: string, press: Press | null) => {
  if (press === null) presses.delete(roomKey);
  else presses.set(roomKey, press);
  pressListeners.forEach((fn) => fn());
};
const subscribePresses = (fn: () => void) => {
  pressListeners.add(fn);
  return () => void pressListeners.delete(fn);
};

// The run this window's last Record press made in each room (the press's
// answer, startRecording's recording_id). A run LiveKit refuses can begin and
// fail between two pushes, so the room's row may never show it live; the
// presser is still told why, by matching the room's end to this run
// (useRecordingNotices).
const pressedRuns = new Map<string, string>();

/** The run this window's last Record press in the room made, if any. */
export function pressedRunOf(roomKey: string): string | null {
  return pressedRuns.get(roomKey) ?? null;
}

/** Note the run a press made (exported for the hook's test). */
export function notePressedRun(roomKey: string, runId: string): void {
  pressedRuns.set(roomKey, runId);
}

/** This window's press on the room still in flight: true for Record, false
 *  for Stop, null when there is none. */
export function useRoomRecordingPress(roomKey: string | null | undefined): boolean | null {
  const read = () => (roomKey ? (presses.get(roomKey)?.on ?? null) : null);
  return useSyncExternalStore(subscribePresses, read, read);
}

/** Press Record or Stop for the whole room. The mark moves at once (store
 *  setRoomRecording) and holds while the press is in flight. A press that
 *  does not land is undone and said, whatever stopped it: the server refused
 *  it (with its reason), or it could not be reached (the queued copy is then
 *  abandoned, so it cannot start filming the room after the person was told
 *  it had not). Only a press parked for the next dispatch binding (boot, a
 *  hot reload) is left standing: it goes out in a moment, and is refused as
 *  stale if it does not (lib/calls/recordingPress).
 *
 *  One press per room at a time: a second press while the first is in flight
 *  is dropped, from whichever surface it came (the button, the mark, the
 *  notice), so two answers can never cross. */
export function setRoomRecording(roomKey: string, on: boolean): Promise<void> {
  if (presses.has(roomKey)) return Promise.resolve();
  const press: Press = { on, at: Date.now() };
  notePress(roomKey, press);
  return useInboxStore
    .getState()
    .setRoomRecording(roomKey, on, press.at)
    .then(
      (res: unknown) => {
        const made = on && res && typeof res === "object" ? (res as { recording_id?: unknown; existing?: unknown }) : null;
        if (made && typeof made.recording_id === "string" && !made.existing) notePressedRun(roomKey, made.recording_id);
      },
      (err: unknown) => {
        if (isParkedDispatchError(err)) return;
        const refused = isRefusedDispatchError(err);
        if (!refused) abandonRecordingPress(press.at);
        useInboxStore.getState().undoRoomRecordingPress(roomKey, on);
        toast.error(
          refused
            ? humanizeConvexError(err)
            : on
              ? "Could not reach the server. Recording did not start."
              : "Could not reach the server. The recording is still running.",
        );
      },
    )
    .finally(() => {
      // Only the press this call made: never one made since.
      if (presses.get(roomKey) === press) notePress(roomKey, null);
    });
}

/**
 * What the red mark says, from what a window knows: its own press in flight,
 * and the room's row (the flag, and the run behind it when the server sends
 * one). A press in flight decides; then the run, whenever the row carries
 * it; and the flag alone only on a server too old to send the run. Null: no
 * mark.
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
  /** Room videos finished after the video was put on the link, which the
   *  link does not show until somebody includes them again. */
  video_later?: number;
  /** Whether this viewer may put the video on the link (the presser of every
   *  room video, or a team admin); taking it off is anyone's. */
  can_share_video?: boolean;
  /** This window deleted a run of the call, at this time (store
   *  deleteCallRecording); the thread's line says so for everyone else. */
  deleted_here_at?: number;
  /** The rows' URLs are past their window and the next answer is on its way
   *  (the tab slept through a rollover): a player already on screen keeps its
   *  place and says it is refreshing, rather than that the video is gone. */
  refreshing?: boolean;
  recordings: CallRecordingRow[];
};

/** The presigning window a page is in, moving only when it rolls over (four
 *  times an hour), so the recordings query is re-asked then and not on every
 *  tick (shared callRecordingUrlWindow). */
export function useCallRecordingUrlWindow(): number {
  const now = useNowWhen((t) => String(callRecordingUrlWindow(t)), 30_000);
  return callRecordingUrlWindow(now);
}

// A call's video lives in the store (registry callRecordings and
// callRecordingCalls), fed by whatever shows it. Every caller mounts the
// feeder and asks by the call's full id: the call page, its share popover and
// each frame embed of the call ask the same question, so Convex holds one
// subscription between them, and a surface that mounts later paints from what
// the store already holds. One
// answer feeds both collections in one store transaction (syncTransaction),
// so no render sees a call's files without its facts. The window rolling
// over is a new question with the same rows: the store keeps the last answer
// while the next loads, so the player on screen is never unmounted. Its
// URLs are signed for a window, though, so an answer held past them is not
// painted (useCallRecordings).

const CALL_FACTS = ["short_id", "call_started_at", "call_ended_at", "configured", "share_link", "video_shared", "video_later", "can_share_video"] as const;
type CallRecordingFacts = Omit<CallRecordings, "recordings" | "transcript_id"> & { _id: string };
type StoredRecordingRow = CallRecordingRow & { transcript_id: string };

// Which file ids each call's answers have carried in this tab, so a push
// releases only its own call's tombstones: a frame of another call open
// beside the page answers nothing about this one's delete in flight.
const seenFiles = new Map<string, Set<string>>();

/** The tombstones an answer has settled: files of this call it no longer
 *  sends, and any whose call this tab never saw (planted in an earlier life
 *  of the tab, so nothing here holds them out any more). */
export function releasedRecordingTombstones(
  pending: Record<string, { type?: string } | undefined>,
  transcriptId: string,
  present: string[],
  seen: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const here = new Set(present);
  const mine = seen.get(transcriptId);
  const released: string[] = [];
  for (const [key, entry] of Object.entries(pending)) {
    if (entry?.type !== "exclude" || !key.startsWith("callRecordings:")) continue;
    const id = key.slice("callRecordings:".length);
    if (here.has(id)) continue;
    if (mine?.has(id) || ![...seen.values()].some((ids) => ids.has(id))) released.push(id);
  }
  return released;
}

function applyCallRecordings(data: CallRecordings | null | undefined): void {
  if (!data) return;
  const st = useInboxStore.getState() as any;
  const rows = data.recordings.map((r) => ({ ...r, transcript_id: data.transcript_id }));
  const present = rows.map((r) => r._id);
  const released = releasedRecordingTombstones(st.pending ?? {}, data.transcript_id, present, seenFiles);
  const seen = seenFiles.get(data.transcript_id) ?? new Set<string>();
  for (const id of present) seen.add(id);
  for (const id of released) seen.delete(id);
  seenFiles.set(data.transcript_id, seen);
  syncTransaction(() => {
    st.syncTable("callRecordingCalls", [
      { _id: data.transcript_id, ...Object.fromEntries(CALL_FACTS.map((k) => [k, data[k]])) } as CallRecordingFacts,
    ]);
    // Each answer is the call's complete set of files: a run deleted from
    // another window leaves this one too.
    st.syncTable("callRecordings", rows, {
      isDelta: true,
      pruneAbsentScope: (r: any) => r.transcript_id === data.transcript_id,
    });
    if (released.length) st.settleCallRecordingTombstones(released);
  });
}

/** The server answered null for a call the store may hold: the viewer can no
 *  longer read it (removed from the team, the session made private, calls
 *  switched off), or it is gone. Its files and facts leave the store at once,
 *  so no player or frame embed keeps playing a signed URL until it lapses.
 *  Keyed by the full id every caller asks under, the id the facts row and
 *  the files' transcript_id carry. */
export function forgetCallRecordings(call: string): void {
  const st = useInboxStore.getState() as any;
  if (!callFactsOf(st, call) && !Object.values(st.callRecordings ?? {}).some((r: any) => r.transcript_id === call)) return;
  seenFiles.delete(call);
  syncTransaction(() => {
    st.syncTable("callRecordings", [], { isDelta: true, pruneAbsentScope: (r: any) => r.transcript_id === call });
    st.syncTable("callRecordingCalls", [], { isDelta: true, pruneAbsentScope: (r: any) => r._id === call });
  });
}

// Every field a reader paints: the player and the notices (status, clock,
// URL, who started it, whose screen), the chips (grouped by identity) and
// the sort (requested_at). The rest of a row never changes after insert.
const rowSig = (r: StoredRecordingRow) =>
  `${r.status}|${r.started_at}|${r.ended_at}|${r.duration_ms}|${r.size_bytes}|${r.url}|${r.url_expires_at}|${r.error}|${r.stop_reason}|${r.can_delete ? 1 : 0}|${r.participant_identity}|${r.participant_name}|${r.started_by_name}|${r.requested_at}`;
const byRequestThenStart = (a: StoredRecordingRow, b: StoredRecordingRow) =>
  a.requested_at - b.requested_at || (a.started_at ?? 0) - (b.started_at ?? 0);
const NO_ROWS: StoredRecordingRow[] = [];
const FACTS_SIG_FIELDS = [...CALL_FACTS, "deleted_here_at"] as const;

/** The call's facts in the store, by the call's full id (what every caller
 *  asks under, and what the feeder keys them by). */
function callFactsOf(st: any, call: string | null | undefined): CallRecordingFacts | undefined {
  return call ? ((st.callRecordingCalls ?? {}) as Record<string, CallRecordingFacts>)[call] : undefined;
}

/** What a caller does with stored rows whose URLs are past their window
 *  while the next answer loads: `hold` them back on a first mount (the page
 *  keeps the player's place), keep them `refreshing` under a player already
 *  on screen, and `paint` when nothing has lapsed. */
export function lapsedRowsVerdict(lapsed: boolean, hadAnswer: boolean): "paint" | "hold" | "refreshing" {
  if (!lapsed) return "paint";
  return hadAnswer ? "refreshing" : "hold";
}

/** A signed URL past its window: an element handed it would be refused. */
const urlLapsed = (r: CallRecordingRow, now: number) => !!r.url && r.url_expires_at !== null && r.url_expires_at <= now;

/** A call's recordings, by the call's full id: undefined while loading, null
 *  when there is nothing to show (no such call for this viewer, or a server
 *  without callRecordings, whose error degrades to "no video" rather than a
 *  surface that waits forever). */
export function useCallRecordings(call: string | null | undefined): CallRecordings | null | undefined {
  const urlWindow = useCallRecordingUrlWindow();
  const authSettled = useServerAuthSettled();
  const args = call && authSettled ? { call, url_window: urlWindow } : ("skip" as const);
  const { data, error } = useQueryNoThrow(api.callRecordings.webCallRecordings, args);
  useFeederError("callRecordings.webCallRecordings", error);
  useConvexSync(data as CallRecordings | null | undefined, (answer) => (answer ? applyCallRecordings(answer) : call && forgetCallRecordings(call)));

  const factsSig = useMemo(
    () =>
      Object.assign(
        (st: any) => {
          const row = callFactsOf(st, call) as any;
          return row ? `${row._id}|${FACTS_SIG_FIELDS.map((k) => row[k]).join("|")}` : "";
        },
        { label: "callRecordingFacts" },
      ),
    [call],
  );
  const s = useTrackedStore([factsSig]);
  const factsKey = factsSig(s);
  const facts = callFactsOf(s, call);
  const transcriptId = facts?._id ?? null;
  const where = useMemo(() => (r: StoredRecordingRow) => r.transcript_id === transcriptId, [transcriptId]);
  const rows = useCollectionRows<StoredRecordingRow>("callRecordings", { where, sig: rowSig, sort: byRequestThenStart });
  const recordings = transcriptId ? rows : NO_ROWS;
  // The store holds a call's rows for the life of the tab, and their URLs
  // for one window. Until this window's answer lands, rows signed for an
  // earlier one are not an answer: painted, the element would be refused
  // and the surface would say the video could not load. A surface mounting
  // onto them holds the player's place (the frame its pulse) instead. Only
  // a FIRST mount, though: once this caller has had an answer its player is
  // on screen, and taking the rows away (the tab slept through a rollover,
  // the next answer a moment off) would unmount it and lose the person's
  // place. Then the rows stay, marked `refreshing`, and the element that is
  // refused takes the next URL where it was (useStableMediaSrcs).
  const answered = data !== undefined;
  const answeredFor = useRef<string | null>(null);
  if (answered && call) answeredFor.current = call;
  const verdict = lapsedRowsVerdict(
    !answered && recordings.some((r) => urlLapsed(r, Date.now())),
    !!call && answeredFor.current === call,
  );

  return useMemo(() => {
    if (!call || data === null) return null;
    if (!facts) return error ? null : undefined;
    if (verdict === "hold") return undefined;
    const { _id, ...rest } = facts;
    return { ...rest, transcript_id: _id, recordings, ...(verdict === "refreshing" ? { refreshing: true } : {}) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- facts is read through its signature
  }, [call, data === null, !!error, factsKey, recordings, verdict]);
}

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
