// Live words from the phone's microphone, using the same recognizer the
// browser recorder uses.
//
// React Native has no AudioContext, so it cannot tap an expo-audio recorder
// as PCM. LiveKit's native audio sink already can: a local getUserMedia track
// plus `createAudioSinkListener` emits int16 buffers, and those go into
// `openAsrPcmSession` — the socket half of web/lib/calls/asrPipe. Attribution
// and reconnect stay here; the pump is shared.
//
// Best effort. The m4a file is the recording. If WebRTC cannot share the
// microphone with expo-audio, this returns a no-op and the file still
// transcribes after stop.

import { NativeEventEmitter, NativeModules } from "react-native";
import type { ConvexReactClient } from "convex/react";
import { openAsrPcmSession, type AsrPcmSession } from "@codecast/web/lib/calls/asrPipe";
import { callsNativeAvailable } from "./calls/livekitNative";

export type AsrCapture = {
  finish(): Promise<void>;
  close(): void;
};

export type AsrCaptureEvents = {
  onUtterance?: (u: { text: string; t0: number; t1: number }) => void;
  onPartial?: (text: string) => void;
  /** The recognizer never opened (the server refused). Given, the caller hears
   *  why and the capture closes; left out, the capture just closes (the
   *  recorder's file still transcribes after stop). */
  onFailed?: (message: string) => void;
  /** The socket closed while still wanted. Given, the caller decides what
   *  happens next (dictation stops and keeps its words); left out, the capture
   *  opens a fresh recognizer on the same tap a second later. */
  onDropped?: () => void;
};

function b64ToInt16(b64: string): Int16Array {
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

/** The microphone as PCM, from LiveKit's native audio sink. The sink for a
 *  local track (pcId -1) is not per track: it hangs off the audio device's
 *  capture path (iOS: the capture post-processing adapter; Android: the
 *  record samples dispatcher), so it hears exactly what a published huddle
 *  mic sends, muted or not. The track opened here only anchors the listener's
 *  attach and detach, which look a local track up by id. */
export type MicTap = {
  /** Where the samples go; null drops them. Replaceable, so a reopened
   *  recognizer takes over the same tap. */
  setSink(sink: ((samples: Int16Array, sampleRate: number) => void) | null): void;
  close(): void;
};

/** A tap, or why there is none: `permanent` when this binary cannot tap PCM
 *  (old app, no LiveKit sink), `transient` when the OS refused the mic this
 *  time (backgrounded, an interruption, a pending permission). */
export type MicTapOpen = { tap: MicTap } | { unavailable: "permanent" | "transient" };

const PERMANENT: MicTapOpen = { unavailable: "permanent" };
const TRANSIENT: MicTapOpen = { unavailable: "transient" };

/** Whether this binary can tap the microphone as PCM at all (LiveKit's native
 *  module with its audio sink). False means an app update, not a retry. */
export function micTapSupported(): boolean {
  return callsNativeAvailable() && !!NativeModules.LivekitReactNativeModule?.createAudioSinkListener;
}

export async function openMicTap(): Promise<MicTapOpen> {
  if (!callsNativeAvailable()) return PERMANENT;
  let webrtc: typeof import("@livekit/react-native-webrtc");
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    webrtc = require("@livekit/react-native-webrtc");
  } catch {
    return PERMANENT;
  }
  const LiveKitModule = NativeModules.LivekitReactNativeModule;
  if (!LiveKitModule?.createAudioSinkListener) return PERMANENT;

  let stream: { getAudioTracks(): any[]; getTracks(): { stop(): void }[] } | null = null;
  try {
    stream = await webrtc.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    return TRANSIENT;
  }
  const stopStream = () => {
    try {
      stream?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    stream = null;
  };
  const track = stream?.getAudioTracks?.()[0];
  if (!track) {
    stopStream();
    return TRANSIENT;
  }

  let sink: ((samples: Int16Array, sampleRate: number) => void) | null = null;
  let tag: string | null = null;
  let sub: { remove(): void } | null = null;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    sink = null;
    try {
      sub?.remove();
    } catch {}
    sub = null;
    if (tag) {
      try {
        LiveKitModule.deleteAudioSinkListener(tag, track._peerConnectionId ?? -1, track.id);
      } catch {}
      tag = null;
    }
    stopStream();
  }
  try {
    const emitter = new NativeEventEmitter(LiveKitModule);
    sub = emitter.addListener("LK_AUDIO_DATA", (event: { id?: string; data?: string }) => {
      if (closed || !sink || !tag || event?.id !== tag || typeof event.data !== "string") return;
      const samples = b64ToInt16(event.data);
      if (!samples.length) return;
      // WebRTC audio processing delivers 10 ms frames, so N samples × 100 is
      // the capture rate. See LKAudioProcessingAdapter.toPCMBuffer.
      sink(samples, samples.length * 100);
    });
    tag = LiveKitModule.createAudioSinkListener(track._peerConnectionId ?? -1, track.id);
  } catch {
    close();
    return TRANSIENT;
  }
  return {
    tap: {
      setSink(next) {
        if (!closed) sink = next;
      },
      close,
    },
  };
}

/**
 * Start a live recognizer on the microphone. Resolves to a handle, or null
 * when this binary cannot tap PCM (old app, no LiveKit, getUserMedia refused).
 */
export async function startAsrCapture(opts: {
  convex: ConvexReactClient;
  /** The call room the key is minted against, or null for dictation (asrPipe
   *  mints a dictation key then). */
  roomKey: string | null;
  clock: () => number;
  events?: AsrCaptureEvents;
  /** The recognizer's language allowlist; the device's languages when left out. */
  languages?: string[];
}): Promise<AsrCapture | null> {
  const opened = await openMicTap();
  if (!("tap" in opened)) return null;
  const tap = opened.tap;

  let session: AsrPcmSession | null = null;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    tap.close();
    try {
      session?.close();
    } catch {}
    session = null;
  }

  function attachSession() {
    if (closed) return;
    session = openAsrPcmSession({
      convex: opts.convex,
      roomKey: opts.roomKey,
      clock: opts.clock,
      ...(opts.languages ? { languages: opts.languages } : {}),
      events: {
        onUtterance: opts.events?.onUtterance,
        onPartial: opts.events?.onPartial,
        onDropped: () => {
          if (closed) return;
          if (opts.events?.onDropped) {
            opts.events.onDropped();
            return;
          }
          try {
            session?.close();
          } catch {}
          session = null;
          setTimeout(() => {
            if (!closed) attachSession();
          }, 1000);
        },
        onFailed: (message) => {
          // Live words are extra for the recorder: its file still transcribes
          // after stop. Dictation has nothing else, so it hears why.
          close();
          opts.events?.onFailed?.(message);
        },
      },
    });
  }

  tap.setSink((samples, rate) => session?.feedInt16(samples, rate));
  attachSession();

  return {
    async finish() {
      try {
        await session?.finish();
      } catch {}
      close();
    },
    close,
  };
}
