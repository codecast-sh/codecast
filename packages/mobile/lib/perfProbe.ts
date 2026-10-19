// Tap latency probe for perf runs (EXPO_PUBLIC_PERF_PROBE=1 at export time).
// Every touch-up logs, relative to the native touch timestamp (same monotonic
// clock as performance.now() on iOS Hermes):
//   lag    when JS first saw the touch (a busy JS thread shows here)
//   first  the first frame after the handler ran
//   settle when frames came back to a steady cadence (the screen is done)
//   gap    the longest frame gap in between (a visible hitch)
// and the store's live subscriber count: every one runs its selector on every
// store write.
// Frames are requestAnimationFrame callbacks, which the main thread's display
// link drives, so a stall on either thread lengthens the gap.
import type { GestureResponderEvent } from 'react-native';
import { readStoreListenerCount } from '@codecast/web/store/storeListenerCensus';

export const PERF_PROBE = process.env.EXPO_PUBLIC_PERF_PROBE === '1';

let route = '';
let seq = 0;
const renders: Record<string, number> = {};

/** Counts a component render toward the current tap's line (`renders=`). */
export function probeRender(name: string) {
  renders[name] = (renders[name] ?? 0) + 1;
}

export function setProbeRoute(path: string) {
  route = path;
}

const CALM_GAP = 25;
const CALM_FRAMES = 6;
const CAP_MS = 5000;

export function probeTouchEnd(e: GestureResponderEvent) {
  const t0 = e.nativeEvent.timestamp;
  const seen = performance.now();
  const id = ++seq;
  const from = route;
  for (const k in renders) delete renders[k];
  let prev = seen;
  let first = 0;
  let maxGap = 0;
  let calm = 0;
  let calmSince = 0;
  const tick = () => {
    const t = performance.now();
    if (!first) first = t;
    const gap = t - prev;
    prev = t;
    if (gap > maxGap) maxGap = gap;
    if (gap < CALM_GAP) {
      if (calm === 0) calmSince = t - gap;
      calm++;
    } else {
      calm = 0;
    }
    if (calm >= CALM_FRAMES || t - t0 > CAP_MS || id !== seq) {
      const r = (n: number) => Math.round(n - t0);
      console.log(
        `[tap] #${id} at=${Math.round(t0)} lag=${r(seen)} first=${r(first)} settle=${r(calm >= CALM_FRAMES ? calmSince : t)} gap=${Math.round(maxGap)} ${from} -> ${route} listeners=${readStoreListenerCount()} renders=${JSON.stringify(renders)}`,
      );
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
