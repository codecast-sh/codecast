// One recording at a time across this browser's windows, and a call in any of
// them stops dictation in all. Inside one window the shared controller holds
// both rules (finishRunningDictation); this carries them to the other windows
// over a BroadcastChannel. Where there is none, each window keeps its own.
import { DICTATION_CALL_BUSY, DICTATION_RECORDING_BUSY, finishRunningDictation } from "@codecast/shared/contracts/dictation";
import { useInboxStore } from "../../store/inboxStore";

/** What the mic says while a huddle or a recording holds the microphone, in
 *  this window or another. A muted call seat is not using it: unmuting
 *  finishes the recording (callManager.setMuted). */
export { DICTATION_CALL_BUSY, DICTATION_RECORDING_BUSY };

/** What else in this window may hold the microphone, each saying why while it
 *  does. The room recorder registers itself; a call is read off the store. */
const holders = new Set<() => string | null>();

export function holdsMicrophoneWhile(reason: () => string | null): void {
  holders.add(reason);
}

type CallSeat = { phase: string; muted: boolean };

/** Why this window's microphone is taken, or null. `call` is where the call
 *  is as this window sees it (the voice host's, mirrored, in a remote). */
export function microphoneBusyHere(call: CallSeat = useInboxStore.getState().call): string | null {
  if ((call.phase === "connecting" || call.phase === "connected") && !call.muted) return DICTATION_CALL_BUSY;
  for (const reason of holders) {
    const why = reason();
    if (why) return why;
  }
  return null;
}

let channel: BroadcastChannel | null | undefined;
/** The asks this window is waiting on, by id. */
const asks = new Map<string, (why: string | null) => void>();

function open(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    const ch = new BroadcastChannel("codecast.dictation");
    ch.onmessage = (e) => {
      const m = e.data;
      if (m && typeof m === "object") {
        // Another window is about to dictate: a call or recording here says no.
        if (typeof m.ask === "string") {
          const why = microphoneBusyHere();
          if (why) ch.postMessage({ answer: m.ask, busy: why });
        } else if (typeof m.answer === "string") asks.get(m.answer)?.(String(m.busy));
        return;
      }
      // Another window took the microphone: the recording here keeps its words
      // and stops.
      void finishRunningDictation();
    };
    channel = ch;
  } catch {
    channel = null;
  }
  return channel;
}

/** This window takes the microphone (a recording starting, a call, a voice
 *  message): the other windows' recordings finish, words kept. */
export function claimMicrophoneAcrossWindows(): void {
  try {
    open()?.postMessage("finish");
  } catch {}
}

/** How long a start waits for another window to say its call or recording
 *  holds the microphone. It runs while this one opens the microphone. */
let askWaitMs = 150;

/** Why another window's microphone is taken (a huddle or a room recording in
 *  another tab or the desktop's call panel), or null when none answers. */
export function microphoneBusyElsewhere(): Promise<string | null> {
  const ch = open();
  if (!ch || askWaitMs <= 0) return Promise.resolve(null);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const done = (why: string | null) => {
      clearTimeout(timer);
      asks.delete(id);
      resolve(why);
    };
    const timer = setTimeout(() => done(null), askWaitMs);
    asks.set(id, done);
    try {
      ch.postMessage({ ask: id });
    } catch {
      done(null);
    }
  });
}

/** Finish the recording in this window and in every other one. */
export function finishDictationEverywhere(): Promise<void> {
  claimMicrophoneAcrossWindows();
  return finishRunningDictation();
}

/** For tests: drop the channel so the next claim opens a fresh one, and set
 *  how long a start asks the other windows (0: it does not ask). */
export function _resetCrossWindowForTests(waitMs = 150): void {
  try {
    channel?.close();
  } catch {}
  channel = undefined;
  askWaitMs = waitMs;
}
