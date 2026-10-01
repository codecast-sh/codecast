// The walkie's meters: how loudly somebody is talking, sampled per animation
// frame, so a key and a face can move with a voice.
//
// Its own module because it shares nothing with the state machine next door
// except the one question below — and its own subscription rather than a field
// on WalkieStatus, because `emit` wakes every subscriber of the walkie and a
// value that moves sixty times a second would wake all of them sixty times a
// second.
//
// Keyed, because both directions animate: no key is this client's own
// microphone while the key is held, and a participant identity is the teammate
// being heard.
import { getRoom } from "./callManager";

export type WalkieLevels = {
  /** This client's own microphone, 0 to 1. Zero when not holding the key. */
  local: number;
  /** Everyone audible in the room right now, by LiveKit participant identity. */
  remote: Record<string, number>;
};

const NO_LEVELS: WalkieLevels = { local: 0, remote: {} };
let levels: WalkieLevels = NO_LEVELS;
const levelSubscribers = new Set<() => void>();

export function subscribeWalkieLevel(cb: () => void): () => void {
  levelSubscribers.add(cb);
  return () => levelSubscribers.delete(cb);
}

export function getWalkieLevels(): WalkieLevels {
  return levels;
}

/** One number for one meter: the local mic, or one participant's voice. */
export function getWalkieLevel(participantId?: string): number {
  return participantId ? (levels.remote[participantId] ?? 0) : levels.local;
}

let meterCtx: AudioContext | null = null;
let meterAnalyser: AnalyserNode | null = null;
let meterBytes: Uint8Array<ArrayBuffer> | null = null;
let meterFrame: number | null = null;

function sameRemote(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && Math.abs(a[k] - b[k]) <= 0.02);
}

function publishLevels(local: number, remote: Record<string, number>) {
  if (Math.abs(local - levels.local) <= 0.02 && sameRemote(levels.remote, remote)) return;
  levels = { local, remote };
  for (const cb of levelSubscribers) cb();
}

// The curve (meterLevel, readMeterLevel) lives in its own leaf, meterCurve,
// so a page without the call manager (the guest's) meters through it too.
export { meterLevel, readMeterLevel } from "./meterCurve";
import { METER_GATE_RMS, meterLevel, readMeterLevel } from "./meterCurve";

function readLocalLevel(): number {
  if (!meterAnalyser || !meterBytes) return 0;
  return readMeterLevel(meterAnalyser, meterBytes);
}

/** Everyone else's voice, straight off LiveKit's own speaker measurements —
 *  no second analyser per remote track, and no work at all when nobody is
 *  being heard. Through the SAME curve as the local meter, so the strip reads
 *  the same whether the voice on it is yours or theirs. */
function readRemoteLevels(): Record<string, number> {
  const room = getRoom();
  if (!room || !hearing()) return {};
  const out: Record<string, number> = {};
  for (const p of room.remoteParticipants.values()) {
    // Gate on the raw measurement, before the curve lifts it into visibility.
    const raw = p.audioLevel ?? 0;
    if (raw > METER_GATE_RMS) out[p.identity] = meterLevel(raw);
  }
  return out;
}

/** Whether a teammate's burst is playing here, which is the only thing the
 *  meter needs from the state machine: it decides whether remote voices are
 *  worth sampling. Injected rather than imported, so this file has no opinion
 *  about what a walkie is. */
let hearing: () => boolean = () => false;

export function bindWalkieHearing(fn: () => boolean): void {
  hearing = fn;
}

export function pumpWalkieMeter() {
  if (meterFrame !== null || typeof requestAnimationFrame !== "function") return;
  const tick = () => {
    meterFrame = null;
    const wanted = !!meterAnalyser || hearing();
    if (!wanted) {
      publishLevels(0, {});
      return;
    }
    publishLevels(meterAnalyser ? readLocalLevel() : 0, readRemoteLevels());
    meterFrame = requestAnimationFrame(tick);
  };
  meterFrame = requestAnimationFrame(tick);
}

export function startLocalMeter(track: MediaStreamTrack) {
  stopLocalMeter();
  try {
    const ac = new AudioContext();
    meterCtx = ac;
    void Promise.resolve(ac.resume?.()).catch(() => {});
    const analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    ac.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    meterAnalyser = analyser;
    meterBytes = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  } catch {
    // No meter is a flat key, not a failed burst.
    meterAnalyser = null;
  }
  pumpWalkieMeter();
}

export function stopLocalMeter() {
  meterAnalyser = null;
  meterBytes = null;
  if (meterCtx) {
    void meterCtx.close().catch(() => {});
    meterCtx = null;
  }
  publishLevels(0, levels.remote);
}
