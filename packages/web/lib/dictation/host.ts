// Where dictation's words come from on the web: the microphone, through the
// same recognizer pipe calls use (lib/calls/asrPipe), minted for dictation
// rather than a room. The behaviour around it (where words go, when it stops)
// is the shared controller's (@codecast/shared/contracts/dictation).
import { dictationLanguages, type DictationHost, type DictationPipe, type DictationPipeEvents } from "@codecast/shared/contracts/dictation";
import { walkieCallState } from "../calls/walkie";
import { claimMicrophoneAcrossWindows, microphoneBusyElsewhere, microphoneBusyHere } from "./crossWindow";

export { DICTATION_CALL_BUSY, DICTATION_RECORDING_BUSY } from "./crossWindow";

type ConvexAction = { action: (fn: any, args: any) => Promise<any> };

/** The caret menu's choice on this device; null is Auto. */
const LANGUAGE_KEY = "codecast.dictation.language";

export function readDictationLanguage(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function writeDictationLanguage(code: string | null): void {
  try {
    if (code) window.localStorage.setItem(LANGUAGE_KEY, code);
    else window.localStorage.removeItem(LANGUAGE_KEY);
  } catch {}
}

declare global {
  interface Window {
    /** Dev and test seam: a host that stands in for the microphone, so every
     *  state can be driven without one (screenshots, mount tests, e2e). */
    __dictationTestHost?: DictationHost;
  }
}

const testHost = (): DictationHost | undefined => (typeof window !== "undefined" ? window.__dictationTestHost : undefined);

/** What a start nobody wants any more rejects with (the controller ignores it). */
export const DICTATION_ABANDONED = "Dictation was cancelled";

/** `busyYet` is another window's answer if it has come in: a refusal heard
 *  while the browser asked for the microphone stops here, before a key is
 *  minted. One still on its way is waited for after the pipe opens (open). */
async function openMicrophone(convex: ConvexAction | null, busyYet: () => string | null, events: DictationPipeEvents, signal: { readonly aborted: boolean }): Promise<DictationPipe> {
  if (!convex) throw new Error("Dictation is not connected");
  // Loaded on the first press, not with every composer.
  const pipeModule = import("../calls/asrPipe");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    const { mediaFailureReason } = await import("../calls/callMedia");
    throw new Error(await mediaFailureReason("microphone", err));
  }
  const stopTracks = () => {
    for (const t of stream.getTracks()) t.stop();
  };
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopTracks();
    throw new Error("No microphone found");
  }
  try {
    // A call or recording in another window said no while the browser asked.
    const busy = busyYet();
    if (busy) throw new Error(busy);
    const { openAsrPipe } = await pipeModule;
    // Cancelled (or taken over) while the browser asked for the microphone:
    // let it go here, before the pipe mints a key nobody will use.
    if (signal.aborted) throw new Error(DICTATION_ABANDONED);
    const t0 = Date.now();
    // Opened at once, without waiting for the other windows' answer: the
    // pipe buffers the track from here, so the first words are never lost.
    const pipe = openAsrPipe({
      convex,
      roomKey: null,
      track,
      clock: () => Date.now() - t0,
      languages: dictationLanguages(readDictationLanguage()),
      events: {
        onPartial: events.onPartial,
        onUtterance: events.onUtterance,
        onFailed: events.onFailed,
        onDropped: events.onDropped,
      },
    });
    return {
      // The pipe stops reading the track the moment finish starts, so the
      // microphone (and the browser's indicator) goes off at the press.
      finish: () => {
        const done = pipe.finish();
        stopTracks();
        return done;
      },
      close: () => {
        pipe.close();
        stopTracks();
      },
    };
  } catch (err) {
    stopTracks();
    throw err;
  }
}

/** The host a composer's dictation opens: the test seam when one is set (read
 *  at each press), else the microphone. */
export function dictationHost(convex: () => ConvexAction | null): DictationHost {
  return {
    open: (events, signal) => {
      // A call (the voice host's, where it holds the microphone) or a room
      // recording in this window refuses at once.
      const here = microphoneBusyHere(walkieCallState());
      if (here) return Promise.reject(new Error(here));
      // One in another window is asked while this one opens the microphone
      // and its recognizer, so the ask never delays the first words. A no
      // that comes in closes what opened (in that rare case a key was minted
      // for nothing).
      let answer: string | null = null;
      const elsewhere = microphoneBusyElsewhere().then((why) => (answer = why));
      const t = testHost();
      const opening = t ? t.open(events, signal) : openMicrophone(convex(), () => answer, events, signal);
      return opening.then(async (pipe) => {
        const busy = await elsewhere;
        if (busy) {
          pipe.close();
          throw new Error(busy);
        }
        // One recording at a time across windows: theirs finish once this one
        // is sure to start, so a refused start never ends a third window's.
        claimMicrophoneAcrossWindows();
        return pipe;
      });
    },
    now: () => (testHost()?.now ?? Date.now)(),
    setTimer: (fn, ms) => {
      const t = testHost();
      return t?.setTimer ? t.setTimer(fn, ms) : setTimeout(fn, ms);
    },
    clearTimer: (h) => {
      const t = testHost();
      if (t?.clearTimer) t.clearTimer(h);
      else clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  };
}
