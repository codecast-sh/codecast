// The transcript's position bar is a fill inside a short track. Its height is
// a percentage, which only JavaScript can animate, so every write is a props
// update on the JS thread: written on each scroll event, it was 257 ms of a
// 3.2 s fling. The fill can only land on a whole device pixel of the track,
// so a scroll that would not move it by one writes nothing.

/** The fill's position in whole device pixels of a track `trackPx` tall. */
export function progressStep(progress: number, trackPx: number): number {
  if (!(trackPx > 0) || !Number.isFinite(progress)) return 0;
  return Math.round(Math.min(1, Math.max(0, progress)) * trackPx);
}

/**
 * The value to write for this scroll position, or null when the fill would not
 * move: the bar is not on screen, or it stays on the pixel it is on.
 */
export function progressWrite(shown: boolean, progress: number, trackPx: number, lastStep: number): { step: number; value: number } | null {
  if (!shown || !(trackPx > 0)) return null;
  const step = progressStep(progress, trackPx);
  return step === lastStep ? null : { step, value: step / trackPx };
}
