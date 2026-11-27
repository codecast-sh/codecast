// The phone's microphone for dictation: the `open` half of the shared
// controller's host (shared/contracts/dictation). It asks for the microphone,
// then opens the live recognizer on it (lib/asrCapture, roomKey null, so the
// pipe mints a dictation key rather than a call's). Every refusal rejects with
// the one line the mic shows.

import type { ConvexReactClient } from 'convex/react';
import type { DictationHost } from '@codecast/shared/contracts';
import { micTapSupported, startAsrCapture } from './asrCapture';
import { getCallSnapshot } from './calls/callManager';
import { getRecorderSnapshot } from './recorder';
import { optionalNative } from './optionalNative';

export const DICTATION_NEEDS_UPDATE = 'Dictation needs a newer app version';
export const DICTATION_NEEDS_MIC = 'Codecast needs the microphone to dictate. Turn it on in Settings.';

// expo-audio only for the permission prompt and the audio session, loaded the
// way lib/recorder.ts does. Without it the recognizer's own getUserMedia asks.
let audio: typeof import('expo-audio') | null = null;
function getAudio() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (!audio) audio = optionalNative('ExpoAudio', () => require('expo-audio'));
  return audio;
}

/** Something else holds the microphone: a huddle, or the room recorder. */
function micBusy(): string | null {
  const call = getCallSnapshot().phase;
  if (call === 'connecting' || call === 'connected') return 'Leave the huddle first — a call is using the microphone.';
  const rec = getRecorderSnapshot().phase;
  if (rec === 'starting' || rec === 'recording' || rec === 'finishing') return 'Stop the recording first — it is using the microphone.';
  return null;
}

/** The audio session back to playback, so a reply's sound is not routed to
 *  the earpiece after a dictation (the recorder does the same on stop). */
function releaseAudioSession() {
  if (micBusy()) return;
  void getAudio()
    ?.setAudioModeAsync({ allowsRecording: false })
    .catch(() => {});
}

export function phoneDictationHost(convex: ConvexReactClient, languages: string[]): DictationHost {
  return {
    async open(events) {
      if (!micTapSupported()) throw new Error(DICTATION_NEEDS_UPDATE);
      const busy = micBusy();
      if (busy) throw new Error(busy);
      const a = getAudio();
      if (a) {
        let granted = false;
        try {
          granted =
            (await a.getRecordingPermissionsAsync()).granted ||
            (await a.requestRecordingPermissionsAsync()).granted;
        } catch {}
        if (!granted) throw new Error(DICTATION_NEEDS_MIC);
        try {
          await a.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        } catch {}
      }
      const startedAt = Date.now();
      const capture = await startAsrCapture({
        convex,
        roomKey: null,
        clock: () => Math.max(0, Date.now() - startedAt),
        languages,
        events: {
          onPartial: events.onPartial,
          onUtterance: events.onUtterance,
          onFailed: events.onFailed,
          onDropped: events.onDropped,
        },
      });
      if (!capture) {
        releaseAudioSession();
        // The binary can tap PCM (checked above), so the OS refused the
        // microphone this time: a denied prompt, or a pending interruption.
        throw new Error(a ? 'The microphone is not available right now. Try again.' : DICTATION_NEEDS_MIC);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseAudioSession();
      };
      return {
        async finish() {
          try {
            await capture.finish();
          } finally {
            release();
          }
        },
        close() {
          capture.close();
          release();
        },
      };
    },
  };
}
