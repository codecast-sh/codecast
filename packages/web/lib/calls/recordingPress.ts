import { CommandReceiptRejectedError } from "@platform/engine";
import { recordingPressStale, recordingPressStaleWords } from "@codecast/shared/contracts";

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
