// How loudly one microphone is hearing, for a meter.
//
// The recorder's pill has one job the words cannot do: say that the microphone
// is actually picking the room up. A transcript that has not caught up yet and
// a microphone that is muted at the operating system look identical in text,
// and only a live meter tells them apart.
//
// The CURVE is the walkie's, imported rather than re-derived: `meterLevel` is
// calibrated in decibels from -50 to -6 dBFS, with a floor just under a typical
// microphone's noise floor so a silent room reads zero. That calibration was
// measured against real speech, and a second copy of it would be a second
// thing to tune.
//
// Deliberately its own subscription, never React state or the store: this value
// moves sixty times a second, and anything that woke a component per frame
// would be the jank the wake signatures exist to prevent. The pill writes it to
// a CSS variable and the browser animates from there.
import { meterLevel } from "./walkie";

export type MicMeter = {
  /** 0 to 1. Zero once stopped, and zero in a room nobody is talking in. */
  level(): number;
  subscribe(cb: () => void): () => void;
  stop(): void;
};

/** Only wake subscribers when the number really moved — the same threshold the
 *  walkie's meter publishes on. */
const STEP = 0.02;

export function createMicMeter(track: MediaStreamTrack): MicMeter {
  let level = 0;
  let stopped = false;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  let frame: number | null = null;
  const subscribers = new Set<() => void>();

  function publish(next: number) {
    if (Math.abs(next - level) <= STEP) return;
    level = next;
    for (const cb of subscribers) cb();
  }

  function read(): number {
    if (!analyser || !bytes) return 0;
    analyser.getByteTimeDomainData(bytes);
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
      const v = (bytes[i] - 128) / 128;
      sum += v * v;
    }
    return meterLevel(Math.sqrt(sum / bytes.length));
  }

  function pump() {
    if (stopped || typeof requestAnimationFrame !== "function") return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (stopped) return;
      publish(read());
      pump();
    });
  }

  try {
    const ac = new AudioContext();
    ctx = ac;
    void Promise.resolve(ac.resume?.()).catch(() => {});
    const node = ac.createAnalyser();
    node.fftSize = 256;
    node.smoothingTimeConstant = 0.6;
    ac.createMediaStreamSource(new MediaStream([track])).connect(node);
    analyser = node;
    bytes = new Uint8Array(new ArrayBuffer(node.fftSize));
    pump();
  } catch {
    // No meter is a flat bar, never a failed recording. The words are the
    // artifact and they do not come through here.
    analyser = null;
  }

  return {
    level: () => level,
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      analyser = null;
      bytes = null;
      if (ctx) {
        void ctx.close().catch(() => {});
        ctx = null;
      }
      publish(0);
      subscribers.clear();
    },
  };
}
