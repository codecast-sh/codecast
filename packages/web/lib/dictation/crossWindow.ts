// One recording at a time across this browser's windows, and a call in any of
// them stops dictation in all. Inside one window the shared controller holds
// both rules (finishRunningDictation); this carries them to the other windows
// over a BroadcastChannel. Where there is none, each window keeps its own.
import { finishRunningDictation } from "@codecast/shared/contracts/dictation";

let channel: BroadcastChannel | null | undefined;

function open(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = new BroadcastChannel("codecast.dictation");
    // Another window took the microphone: the recording here keeps its words
    // and stops.
    channel.onmessage = () => {
      void finishRunningDictation();
    };
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

/** Finish the recording in this window and in every other one. */
export function finishDictationEverywhere(): Promise<void> {
  claimMicrophoneAcrossWindows();
  return finishRunningDictation();
}

/** For tests: drop the channel so the next claim opens a fresh one. */
export function _resetCrossWindowForTests(): void {
  try {
    channel?.close();
  } catch {}
  channel = undefined;
}
