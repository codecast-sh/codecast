// ── shared AudioContext + AudioWorklet capture ────────────────────────────
//
// A scribed huddle taps every participant's track simultaneously. Opening a
// separate AudioContext + main-thread ScriptProcessorNode per participant put
// 6+ CoreAudio output graphs and synchronous DSP callbacks on the voice-host
// renderer's main thread alongside video, FaceDetector and WebRTC.
//
// All live ASR pipes now share ONE reference-counted AudioContext (closed the
// instant the last pipe lets go, so an idle tab holds zero hardware handles)
// and run capture off the main thread in an AudioWorkletNode where supported.
// While the worklet module loads on the first cold pipe (~5ms) — or in test/old
// environments without AudioWorklet — a ScriptProcessorNode captures from t=0
// and hands off seamlessly once the worklet is ready, so no first syllable is lost.

export const WORKLET_NAME = "codecast-asr-tap";
const WORKLET_SOURCE = `
class CodecastAsrTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    let offset = 0;
    while (offset < ch.length) {
      const space = this._buf.length - this._pos;
      const take = Math.min(space, ch.length - offset);
      this._buf.set(ch.subarray(offset, offset + take), this._pos);
      this._pos += take;
      offset += take;
      if (this._pos === this._buf.length) {
        const out = this._buf;
        this.port.postMessage(out, [out.buffer]);
        this._buf = new Float32Array(2048);
        this._pos = 0;
      }
    }
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", CodecastAsrTap);
`;

export type SharedCaptureContext = {
  ctx: AudioContext;
  ctor: unknown;
  refs: number;
  mute: GainNode;
  workletReady: boolean;
  workletLoading: Promise<boolean> | null;
};

let sharedCapture: SharedCaptureContext | null = null;
let workletBlobUrl: string | null = null;

function getWorkletBlobUrl(): string | null {
  if (workletBlobUrl) return workletBlobUrl;
  if (typeof Blob !== "function" || typeof URL?.createObjectURL !== "function") return null;
  try {
    workletBlobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    return workletBlobUrl;
  } catch {
    return null;
  }
}

export function acquireCaptureContext(): SharedCaptureContext {
  const Ctor = AudioContext;
  if (sharedCapture && sharedCapture.ctor === Ctor && (sharedCapture.ctx as any).state !== "closed" && !(sharedCapture.ctx as any).closed) {
    sharedCapture.refs += 1;
    void Promise.resolve(sharedCapture.ctx.resume?.()).catch(() => {});
    return sharedCapture;
  }
  const ctx = new Ctor();
  void Promise.resolve(ctx.resume?.()).catch(() => {});
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);
  sharedCapture = {
    ctx,
    ctor: Ctor,
    refs: 1,
    mute,
    workletReady: false,
    workletLoading: null,
  };
  return sharedCapture;
}

export function releaseCaptureContext(entry: SharedCaptureContext): void {
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  if (sharedCapture === entry) sharedCapture = null;
  try {
    entry.mute.disconnect();
  } catch {}
  try {
    void entry.ctx.close();
  } catch {}
}

export function ensureWorkletLoaded(entry: SharedCaptureContext): Promise<boolean> {
  if (entry.workletReady) return Promise.resolve(true);
  if (entry.workletLoading) return entry.workletLoading;
  if (typeof AudioWorkletNode !== "function" || typeof entry.ctx.audioWorklet?.addModule !== "function") {
    return Promise.resolve(false);
  }
  const url = getWorkletBlobUrl();
  if (!url) return Promise.resolve(false);
  entry.workletLoading = entry.ctx.audioWorklet.addModule(url).then(
    () => {
      entry.workletReady = true;
      return true;
    },
    () => false,
  );
  return entry.workletLoading;
}

export function __resetAsrCaptureForTest(): void {
  if (!sharedCapture) return;
  const entry = sharedCapture;
  sharedCapture = null;
  entry.refs = 0;
  try {
    entry.mute.disconnect();
  } catch {}
  try {
    void entry.ctx.close();
  } catch {}
}
