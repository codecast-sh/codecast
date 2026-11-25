// ct-101491 (eg-5507): WASM_OR_WORKER_NOT_READY escaped as an unhandled rejection
// from /call-panel. The real `@livekit/krisp-noise-filter` 0.4.6 processor's
// `onPublish` is `async onPublish(r) { this.#A.onPublish(r), this.setEnabled(true) }`:
// it fires `setEnabled(true)` without awaiting it, and `setEnabled` rejects with
// WASM_OR_WORKER_NOT_READY while the WASM/worker is still loading. Attaching Krisp
// must never leave that rejection unhandled; the mic falls back to browser
// noiseSuppression instead.
import { afterEach, expect, test } from "bun:test";
import { ConnectionState, Track } from "livekit-client";
import { __setKrispLoaderForTest, KRISP_PROCESSOR_NAME, syncRoomNoiseCancellation } from "../calls/krispFilter";

afterEach(() => __setKrispLoaderForTest(null));

function notReadyKrispRoom() {
  let currentProcessor: any;
  const appliedTrack: any[] = [];
  const raw = { applyConstraints: async () => {} };
  const ctx: any = { state: "running", resume: async () => {} };
  const track: any = {
    _mediaStreamTrack: raw,
    mediaStreamTrack: raw,
    audioContext: ctx,
    setAudioContext() {},
    getProcessor: () => currentProcessor,
    setProcessor: async (p: any) => {
      currentProcessor = p;
    },
    stopProcessor: async () => {
      currentProcessor = undefined;
    },
    applyConstraints: async (c: any) => {
      appliedTrack.push(c);
    },
  };
  const room: any = {
    state: ConnectionState.Connected,
    audioContext: ctx,
    localParticipant: {
      getTrackPublication: (s: unknown) =>
        s === Track.Source.Microphone ? { audioTrack: track, track } : undefined,
    },
  };
  __setKrispLoaderForTest(async () => ({
    isKrispNoiseFilterSupported: () => true,
    KrispNoiseFilter: () => {
      const proc: any = {
        name: KRISP_PROCESSOR_NAME,
        init: async () => {},
        restart: async () => {},
        destroy: async () => {},
        isEnabled: () => false,
        // Mirrors the SDK: the filter node's checkReadiness throws until the worker reports ready.
        setEnabled: async (_on: boolean) => {
          throw new Error("WASM_OR_WORKER_NOT_READY");
        },
        // Mirrors krisp-noise-filter 0.4.6 exactly: setEnabled is fired, not awaited.
        async onPublish(_room: any) {
          proc.setEnabled(true);
        },
      };
      return proc;
    },
  }));
  return { room, appliedTrack };
}

test("a not-ready Krisp filter never leaks WASM_OR_WORKER_NOT_READY as an unhandled rejection", async () => {
  const leaked: unknown[] = [];
  const onUnhandled = (reason: unknown) => leaked.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const env = notReadyKrispRoom();
    const active = await syncRoomNoiseCancellation(env.room, true);
    // Let any fire-and-forget rejection surface.
    await new Promise((r) => setTimeout(r, 20));
    expect(leaked.map((e) => String((e as Error)?.message ?? e))).toEqual([]);
    expect(active).toBe(false);
    expect(env.appliedTrack.at(-1)).toEqual({ noiseSuppression: true, voiceIsolation: false });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
