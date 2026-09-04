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

// The meter is calibrated in decibels, the way meters are.
//
// `min(1, rms * 4)` was linear in amplitude, which spends nearly all of a
// meter's travel doing nothing: the dips between syllables sit at 0.005 to
// 0.0125 RMS, which that scale drew as seven to eighteen degrees of a ring. A
// quiet talker looked at a dead ring, which reads as "the microphone is not
// working" — this feature's original complaint in a different hat.
//
// -50 dBFS is the bottom and -6 the top. The floor sits just under a typical
// microphone's noise floor, so a silent room still reads zero and the ring
// never claims a voice that is not there; only a shout pegs the ceiling.
const METER_FLOOR_DB = -50;
const METER_CEIL_DB = -6;
/** Below this a measurement is a room, not a voice. The value the old linear
 *  scale gated remote speakers at (`rms * 4 > 0.02`), kept exactly. */
const METER_GATE_RMS = 0.005;

/** RMS amplitude (0..1) to meter travel (0..1). Exported for its test. */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB)));
}

function readLocalLevel(): number {
  if (!meterAnalyser || !meterBytes) return 0;
  return readMeterLevel(meterAnalyser, meterBytes);
}

export function readMeterLevel(analyser: Pick<AnalyserNode, "getByteTimeDomainData">, bytes: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(bytes);
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return meterLevel(Math.sqrt(sum / bytes.length));
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
