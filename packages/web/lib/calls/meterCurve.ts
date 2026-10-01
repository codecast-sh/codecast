// How loud a microphone is, as meter travel: the one curve every meter in
// the product draws through (the walkie's rings, the dock's level, the
// recorder's pill, a guest's preview). Pure and dependency free, so any page
// can meter a voice the same way without loading the call machinery.

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
export const METER_GATE_RMS = 0.005;

/** RMS amplitude (0..1) to meter travel (0..1). Exported for its test. */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB)));
}

/** One reading of an analyser, through the curve. */
export function readMeterLevel(analyser: Pick<AnalyserNode, "getByteTimeDomainData">, bytes: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(bytes);
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return meterLevel(Math.sqrt(sum / bytes.length));
}
