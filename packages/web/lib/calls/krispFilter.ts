// Enhanced (Krisp) noise cancellation for outbound huddle microphones.
//
// Why this lives here rather than in `RoomOptions.audioCaptureDefaults`:
// 1. `@livekit/krisp-noise-filter` ships ~6.3 MB of inline WASM, so it must
//    stay out of the boot bundle and load only when a call opens a microphone.
// 2. Most DM huddles adopt a prewarmed room (`roomPrewarm.ts`), a walkie burst
//    clone (`callManager.ts`), or a lobby preview track (`guestRoom.ts`), each
//    published through `publishTrack(rawMediaStreamTrack)`. That sets
//    `userProvidedTrack = true` in `livekit-client` and skips `createTracks()`
//    (and therefore `audioCaptureDefaults.processor`). Attaching to the live
//    `LocalAudioTrack` covers every join and device-switch path uniformly.
// 3. Exactly ONE noise suppressor may touch the track. Krisp's `init()` turns
//    off browser `noiseSuppression` and `voiceIsolation`, and we re-assert that
//    across `restartTrack` (where Krisp's `restart()` does not re-apply
//    constraints) and restore `{ noiseSuppression: true, voiceIsolation: false }`
//    whenever Krisp is turned off, unsupported, or refused by a non-Cloud SFU.
import { ConnectionState, Track, type LocalAudioTrack, type Room } from "livekit-client";

export const KRISP_PROCESSOR_NAME = "livekit-noise-filter";

export type KrispModule = {
  isKrispNoiseFilterSupported: () => boolean;
  KrispNoiseFilter: (opts?: { quality?: "low" | "medium" | "high"; useBVC?: boolean }) => {
    name: string;
    init: (opts: any) => Promise<void>;
    restart: (opts: any) => Promise<void>;
    destroy: () => Promise<void>;
    onPublish?: (room: Room) => Promise<void>;
    setEnabled?: (enable: boolean) => Promise<boolean | undefined>;
    isEnabled?: () => boolean;
    processedTrack?: MediaStreamTrack;
  };
};

type KrispProcessor = ReturnType<KrispModule["KrispNoiseFilter"]>;

let customLoader: (() => Promise<KrispModule | null>) | null = null;
let cachedModule: Promise<KrispModule | null> | null = null;

/** Test seam: stand in for the 6.3 MB WASM bundle without touching the network or AudioWorklet. */
export function __setKrispLoaderForTest(loader: (() => Promise<KrispModule | null>) | null): void {
  customLoader = loader;
  cachedModule = null;
}

function browserSupportsAudioWorklet(): boolean {
  if (customLoader) return true;
  return (
    typeof window !== "undefined" &&
    typeof AudioContext === "function" &&
    typeof AudioWorkletNode === "function"
  );
}

function loadKrisp(): Promise<KrispModule | null> {
  if (customLoader) return customLoader();
  if (!browserSupportsAudioWorklet()) return Promise.resolve(null);
  cachedModule ??= import("@livekit/krisp-noise-filter")
    .then((m) => m as unknown as KrispModule)
    .catch(() => null);
  return cachedModule;
}

function micTrackOf(room: Room | null): LocalAudioTrack | null {
  if (!room) return null;
  const pub: any = room.localParticipant?.getTrackPublication?.(Track.Source.Microphone);
  const track: any = pub?.audioTrack ?? pub?.track ?? null;
  // Duck-type `setProcessor` so plain FakeRoom stand-ins in seam tests no-op cleanly.
  if (!track || typeof track.setProcessor !== "function") return null;
  return track as LocalAudioTrack;
}

async function applyFallbackConstraints(track: LocalAudioTrack): Promise<void> {
  const raw: MediaStreamTrack | undefined = (track as any)._mediaStreamTrack ?? track.mediaStreamTrack;
  try {
    if (typeof track.applyConstraints === "function") {
      await track.applyConstraints({ noiseSuppression: true, voiceIsolation: false });
    } else {
      await raw?.applyConstraints?.({ noiseSuppression: true, voiceIsolation: false } as MediaTrackConstraints);
    }
  } catch {}
}

async function applyKrispRawConstraints(track: LocalAudioTrack): Promise<void> {
  // Krisp's `init()` turns off browser noiseSuppression, but `restart()` on a
  // mid-call mic switch does not re-apply constraints to the newly opened
  // MediaStreamTrack. Explicitly keep browser suppression off while Krisp runs.
  const raw: MediaStreamTrack | undefined = (track as any)._mediaStreamTrack;
  try {
    await raw?.applyConstraints?.({ noiseSuppression: false, voiceIsolation: false } as MediaTrackConstraints);
  } catch {}
}

async function ensureRunningAudioContext(room: Room, track: LocalAudioTrack): Promise<boolean> {
  let ctx: AudioContext | undefined = (track as any).audioContext ?? (room as any).audioContext;
  if (!ctx && typeof AudioContext === "function") {
    try {
      ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
      (room as any).audioContext = ctx;
    } catch {
      return false;
    }
  }
  if (!ctx) return false;
  if (!(track as any).audioContext) {
    track.setAudioContext?.(ctx);
  }
  // On Electron desktop the voice-host window receives join commands over IPC
  // without a local DOM click, so its AudioContext can start suspended.
  if (ctx.state === "suspended") {
    await Promise.resolve(ctx.resume?.()).catch(() => {});
  }
  return ctx.state !== "closed";
}

// Krisp's `onPublish` (which livekit-client's Room calls on every processor
// update) fires `this.setEnabled(true)` without awaiting it, so any failure in
// there (a server that refuses enhanced noise cancellation, a dispose mid-wait)
// is an unhandled rejection. Shadow `setEnabled` on the instance so every call,
// ours or the package's, settles to `false` instead of throwing.
function settleEnable(processor: KrispProcessor): KrispProcessor {
  const setEnabled = processor.setEnabled?.bind(processor);
  if (setEnabled) processor.setEnabled = (enable) => setEnabled(enable).catch(() => false);
  return processor;
}

// Serialize attach/detach per LocalAudioTrack so a join and a LocalTrackPublished
// event arriving in the same turn never instantiate two processors on one mic.
const inFlight = new WeakMap<object, Promise<boolean>>();

/**
 * Reconcile the room's published microphone with the user's noise-cancellation
 * preference. Resolves `true` when Krisp is actively filtering the mic, `false`
 * when browser `noiseSuppression` stands in instead.
 */
export function syncRoomNoiseCancellation(room: Room | null, enabled: boolean): Promise<boolean> {
  const track = micTrackOf(room);
  if (!room || !track) return Promise.resolve(false);
  const prev = inFlight.get(track) ?? Promise.resolve(false);
  const next = prev.then(
    () => reconcileTrack(room, track, enabled),
    () => reconcileTrack(room, track, enabled),
  );
  inFlight.set(track, next);
  return next;
}

async function reconcileTrack(room: Room, track: LocalAudioTrack, enabled: boolean): Promise<boolean> {
  const existing = track.getProcessor?.() as any;
  const hasKrisp = existing?.name === KRISP_PROCESSOR_NAME;

  if (!enabled) {
    if (hasKrisp) {
      try {
        await existing.setEnabled?.(false);
      } catch {}
      try {
        await track.stopProcessor?.();
      } catch {}
    }
    await applyFallbackConstraints(track);
    return false;
  }

  if (hasKrisp) {
    if (existing.isEnabled?.()) {
      await applyKrispRawConstraints(track);
      return true;
    }
    // Attached but not filtering means the track went through `restartTrack`
    // (mic switch, unmute after a stopped mic). Krisp's `restart()` builds a new
    // WASM filter node but keeps the "ready" flag of the old one, so enabling it
    // throws WASM_OR_WORKER_NOT_READY. A fresh processor waits for its own node.
    try {
      await track.stopProcessor?.();
    } catch {}
  }

  const mod = await loadKrisp();
  if (!mod || !mod.isKrispNoiseFilterSupported()) {
    await applyFallbackConstraints(track);
    return false;
  }

  if (!(await ensureRunningAudioContext(room, track))) {
    await applyFallbackConstraints(track);
    return false;
  }

  const processor = settleEnable(mod.KrispNoiseFilter({ quality: "high" }));
  try {
    await track.setProcessor(processor as any);
    // If the track was already published before setProcessor ran, Room's
    // TrackProcessorUpdate listener calls `processor.onPublish(room)`. When the
    // processor attached ahead of publish or on a minimal Room stand-in, ensure
    // it binds and enables once connected.
    if (room.state === ConnectionState.Connected && !processor.isEnabled?.()) {
      await processor.onPublish?.(room);
      const ok = await processor.setEnabled?.(true);
      if (ok === false) throw new Error("Krisp not authorized on this server");
    }
    await applyKrispRawConstraints(track);
    return true;
  } catch {
    try {
      await track.stopProcessor?.();
    } catch {}
    await applyFallbackConstraints(track);
    return false;
  }
}

/** True when Krisp is currently attached and enabled on the room's microphone. */
export function isKrispActiveOnRoom(room: Room | null): boolean {
  const track = micTrackOf(room);
  if (!track) return false;
  if ((track as any).enhancedNoiseCancellation) return true;
  const proc = track.getProcessor?.() as any;
  return proc?.name === KRISP_PROCESSOR_NAME && (proc.isEnabled ? !!proc.isEnabled() : true);
}
