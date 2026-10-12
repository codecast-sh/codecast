// The replay clock inside the player (docs/architecture/external-data.md X5,
// "The replay clock"). rrweb counts in offsets from the capture's first
// event; everything the player shows or says counts on the replay's clock:
// ms since the semantic stream's t = 0 (the manifest's t0), ending at the
// replay row's duration, the same numbers the text timeline prints. A capture
// may start after t0 (lead > 0) and may run past the stream's end (a page
// that kept mutating after the last thing the person did): the clock still
// ends at the row's duration, and playback stops there.

export interface ReplayClock {
  /** The replay's length on its clock: the row's duration, else where the capture ends. */
  duration: number;
  /** rrweb offset of the replay clock's zero, negated: clock = offset + lead. */
  lead: number;
  /** The rrweb offset that draws replay time t (clamped to the replay and the capture). */
  toOffset: (t: number) => number;
  /** The replay time at an rrweb offset (clamped to [0, duration]). */
  toClock: (offset: number) => number;
  /** The rrweb offset where the replay ends: playback stops here. */
  endOffset: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), Math.max(lo, hi));

export function replayClock(
  manifest: { t0: number; replay: { duration_ms: number | null } },
  capture: { startTime: number; totalTime: number },
): ReplayClock {
  const lead = capture.startTime - manifest.t0;
  const captureEnd = Math.max(0, capture.totalTime + lead);
  const row = manifest.replay.duration_ms;
  const duration = typeof row === "number" && row > 0 ? row : captureEnd;
  const toOffset = (t: number) => clamp(clamp(t, 0, duration) - lead, 0, capture.totalTime);
  const toClock = (offset: number) => clamp(offset + lead, 0, duration);
  return { duration, lead, toOffset, toClock, endOffset: toOffset(duration) };
}
