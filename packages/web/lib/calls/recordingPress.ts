import { useMemo, useState, useSyncExternalStore } from "react";
import { CommandReceiptRejectedError } from "@platform/engine";
import {
  humanizeConvexError,
  RECORDING_RESTART_COOLDOWN_MS,
  recordingCooling,
  recordingPressStale,
  recordingPressStaleWords,
  type CallRecordingStatus,
} from "@codecast/shared/contracts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { myUserId, useInboxStore } from "../../store/inboxStore";
import { isParkedDispatchError, isRefusedDispatchError } from "../../store/mutativeMiddleware";
import { roomRecordingLive, roomRecordingOn, type RoomRecordingFields, type RoomRecordingLive } from "./roomRecordingFields";

// Pressing Record or Stop for a room, on every platform that sits in a
// huddle: the web's stage, notice and toast, and the phone's call screen all
// press through pressRoomRecording, so the mark moves in the same frame
// everywhere, one press per room is in flight at a time, and a press that
// does not land is undone and said the same way. Only how it is said differs
// (a toast, an alert), which the caller passes in.
//
// Kept free of the web call engine and of the `@/` alias: Metro reads this
// file for the phone, where `@/` means the mobile app.

// A Record or Stop press is a moment, and the store's writes ride a durable
// outbox (shared contracts/callRecordings, "A press is a moment"). This is the
// client's half of the rule: the dispatch binding asks here before a
// setRoomRecording leaves the browser, on the first send, on every retry and
// on a replay after a reload alike, and a press that is no longer a moment is
// refused as final, which drops its outbox row. The server refuses the same
// press by the same rule (convex dispatch setRoomRecording), for a client
// that did not ask.
//
// A press is also dead once its person was told it did not happen: a send
// that ran out of retries says "could not reach the server", and the row it
// left queued must not then start filming the room behind that sentence.

/** Presses given up on in this tab, by the stamp they were made at. */
const abandoned = new Set<number>();

/** The person was told this press did not happen: it must never land. */
export function abandonRecordingPress(pressedAt: number): void {
  abandoned.add(pressedAt);
}

/** The refusal for a setRoomRecording that must not be sent, or null when it
 *  may go. `args` are the action's: [roomKey, on, pressedAt]. */
export function deadRecordingPress(action: string, args: unknown, now: number = Date.now()): Error | null {
  if (action !== "setRoomRecording" || !Array.isArray(args)) return null;
  const [, on, pressedAt] = args as [unknown, unknown, unknown];
  const dead = recordingPressStale(pressedAt, now) || (typeof pressedAt === "number" && abandoned.has(pressedAt));
  return dead ? new CommandReceiptRejectedError({ code: "RECORDING_PRESS_STALE", message: recordingPressStaleWords(!!on) }) : null;
}

// ── Pressing ─────────────────────────────────────────────────────────────
//
// The room row's recording fields are the server's, not the presser's: a run
// can start and end between two pushes (LiveKit refuses it, somebody stops it
// a moment later), so the store paints the press at once and takes the
// server's word on every push (callRooms.unprotectedFields; a field lock
// would wait forever for a value the server may never send). What carries
// the press across the round trip is the press itself, in flight: this
// screen's own Record or Stop, from the tap until the server has answered
// it. It is the dispatch's own state, not a copy of the row, and never
// outlives the dispatch.

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

// The run this screen's last Record press made in each room (the press's
// answer, startRecording's recording_id). A run LiveKit refuses can begin and
// fail between two pushes, so the room's row may never show it live; the
// presser is still told why, by matching the room's end to this run
// (roomRecordingEnd watchRoomRun).
const pressedRuns = new Map<string, string>();

/** The run this screen's last Record press in the room made, if any. */
export function pressedRunOf(roomKey: string): string | null {
  return pressedRuns.get(roomKey) ?? null;
}

/** Note the run a press made (exported for the press's test). */
export function notePressedRun(roomKey: string, runId: string): void {
  pressedRuns.set(roomKey, runId);
}

/** This screen's press on the room still in flight: true for Record, false
 *  for Stop, null when there is none. */
export function useRoomRecordingPress(roomKey: string | null | undefined): boolean | null {
  const read = () => (roomKey ? (presses.get(roomKey)?.on ?? null) : null);
  return useSyncExternalStore(subscribePresses, read, read);
}

/** How long a press whose send failed waits for the room's row to say what
 *  the server did, before the presser is told it could not be confirmed. */
export const PRESS_SETTLE_MS = 8_000;

/** A press that failed to send and that the row never confirmed. It names
 *  what the person can see for themselves, the red mark, rather than claim
 *  an outcome nobody here knows. */
export function pressUnconfirmedWords(on: boolean): string {
  return on
    ? "Could not confirm with the server. If the red mark stays, the room is being recorded; otherwise press Record again."
    : "Could not confirm with the server. If the red mark stays, the recording is still running; press Stop again.";
}

/** Does the room's row show the press landed? For Record, the live run
 *  this person asked for at about the press (a few seconds of clock skew
 *  between this device and the server allowed); its id. For Stop, the run
 *  gone or saving. False while the row does not say so. */
export function pressConfirmedBy(
  row: RoomRecordingFields | null | undefined,
  on: boolean,
  pressedAt: number,
  meId: string | null,
): string | true | false {
  const live = roomRecordingLive(row);
  if (on) {
    if (!live || !meId || live.started_by.id !== meId || live.requested_at < pressedAt - 2_000) return false;
    return live.run_id;
  }
  return live === null || live?.status === "stopping" ? true : false;
}

/** Wait (up to PRESS_SETTLE_MS) for the room's row to confirm a press whose
 *  send failed: the run id or true when it does, false when it never does. */
function settlePress(roomKey: string, on: boolean, pressedAt: number): Promise<string | true | false> {
  const read = (st: any) =>
    pressConfirmedBy(st.callRooms?.[roomKey], on, pressedAt, myUserId(st));
  const now = read(useInboxStore.getState());
  if (now !== false) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | true | false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = useInboxStore.subscribe((st: any) => {
      const seen = read(st);
      if (seen !== false) finish(seen);
    });
    const timer = setTimeout(() => finish(false), PRESS_SETTLE_MS);
  });
}

/** Press Record or Stop for the whole room. The mark moves at once (store
 *  setRoomRecording) and holds while the press is in flight. A press that
 *  does not land is undone and said through `onRefused`: the server refused
 *  it (with its reason), or its send failed and the room's row never showed
 *  it landing within PRESS_SETTLE_MS (the queued copy is abandoned either
 *  way, so it cannot start filming the room after the person was told it
 *  had not). A send that failed but whose run the row shows is a press that
 *  worked, and is said as nothing. Only a press parked for the next
 *  dispatch binding (boot, a hot reload) is left standing: it goes out in a
 *  moment, and is refused as stale if it does not (deadRecordingPress).
 *
 *  One press per room at a time: a second press while the first is in flight
 *  is dropped, from whichever surface it came (the button, the mark, the
 *  notice), so two answers can never cross. */
export function pressRoomRecording(roomKey: string, on: boolean, onRefused: (message: string) => void): Promise<void> {
  if (presses.has(roomKey)) return Promise.resolve();
  const press: Press = { on, at: Date.now() };
  // A Stop ends the run the mark showed and nothing newer: it rides a
  // durable outbox, and a retry landing after somebody pressed Record again
  // must leave their run filming.
  const runId = on ? undefined : roomRecordingLive(useInboxStore.getState().callRooms?.[roomKey])?.run_id;
  notePress(roomKey, press);
  const store = useInboxStore.getState();
  return (runId ? store.setRoomRecording(roomKey, on, press.at, runId) : store.setRoomRecording(roomKey, on, press.at))
    .then(
      (res: unknown) => {
        const made = on && res && typeof res === "object" ? (res as { recording_id?: unknown; existing?: unknown }) : null;
        if (made && typeof made.recording_id === "string" && !made.existing) notePressedRun(roomKey, made.recording_id);
      },
      async (err: unknown) => {
        if (isParkedDispatchError(err)) return;
        if (isRefusedDispatchError(err)) {
          useInboxStore.getState().undoRoomRecordingPress(roomKey, on);
          onRefused(humanizeConvexError(err));
          return;
        }
        // Neither refused nor parked: the send failed on this side, which
        // says nothing about the server. Under load a mutation that already
        // ran can still answer with a dropped socket or a late receipt, and
        // the room's consent rides on what the presser is told, so the
        // outcome is read off the room's row rather than guessed. The queued
        // copy is dead either way: the press reached the server or it did not.
        abandonRecordingPress(press.at);
        const run = await settlePress(roomKey, on, press.at);
        if (run !== false) {
          if (typeof run === "string") notePressedRun(roomKey, run);
          return;
        }
        useInboxStore.getState().undoRoomRecordingPress(roomKey, on);
        onRefused(pressUnconfirmedWords(on));
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

// ── Reading the mark ─────────────────────────────────────────────────────
//
// Every surface on every platform reads the room's recording off its
// callRooms row through these two hooks: the web's stage, face card and
// Record button, and the phone's badge, pill and notice. Here rather than in
// the web's hooks/useRoomRecording (which re-exports them), so Metro can read
// them too and the phone never rebuilds the rule.

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

/** A run that was stopped is still being written; a new press waits the
 *  server's short cooldown after the stop (recordingCooling, counted from
 *  the stop, never from LiveKit's upload), then may record while the last
 *  file is still saving. True while it waits. One timer, set to the moment
 *  the wait ends, re-renders the caller then; nothing ticks in between. The
 *  web's Record button and the phone's call screen both wait through here. */
export function useRecordingCooling(status: CallRecordingStatus | null | undefined, stopAt: number | null | undefined): boolean {
  const [, woke] = useState(0);
  const cooling = recordingCooling(status, stopAt, Date.now());
  const until = cooling && stopAt != null ? stopAt + RECORDING_RESTART_COOLDOWN_MS : null;
  useWatchEffect(() => {
    if (until === null) return;
    const timer = setTimeout(() => woke((n) => n + 1), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [until]);
  return cooling;
}
