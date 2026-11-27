// Where dictation's words come from on the web: the microphone, through the
// same recognizer pipe calls use (lib/calls/asrPipe), minted for dictation
// rather than a room. The behaviour around it (where words go, when it stops)
// is the shared controller's (@codecast/shared/contracts/dictation).
import { dictationLanguages, type DictationHost, type DictationPipe, type DictationPipeEvents } from "@codecast/shared/contracts/dictation";

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

async function openMicrophone(convex: ConvexAction | null, events: DictationPipeEvents, signal: { readonly aborted: boolean }): Promise<DictationPipe> {
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
    const { openAsrPipe } = await pipeModule;
    // Cancelled (or taken over) while the browser asked for the microphone:
    // let it go here, before the pipe mints a key nobody will use.
    if (signal.aborted) throw new Error(DICTATION_ABANDONED);
    const t0 = Date.now();
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
      const t = testHost();
      return t ? t.open(events, signal) : openMicrophone(convex(), events, signal);
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
