import { useState, useSyncExternalStore } from "react";
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
import { useInboxStore } from "../../store/inboxStore";
import { isParkedDispatchError, isRefusedDispatchError } from "../../store/mutativeMiddleware";
import type { RoomRecordingLive } from "./roomRecordingFields";

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

/** Press Record or Stop for the whole room. The mark moves at once (store
 *  setRoomRecording) and holds while the press is in flight. A press that
 *  does not land is undone and said through `onRefused`, whatever stopped
 *  it: the server refused it (with its reason), or it could not be reached
 *  (the queued copy is then abandoned, so it cannot start filming the room
 *  after the person was told it had not). Only a press parked for the next
 *  dispatch binding (boot, a hot reload) is left standing: it goes out in a
 *  moment, and is refused as stale if it does not (deadRecordingPress).
 *
 *  One press per room at a time: a second press while the first is in flight
 *  is dropped, from whichever surface it came (the button, the mark, the
 *  notice), so two answers can never cross. */
export function pressRoomRecording(roomKey: string, on: boolean, onRefused: (message: string) => void): Promise<void> {
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
        onRefused(
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
