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
  watchFrames(e.nativeEvent.timestamp, performance.now());
}

/** The same line for a gesture the root never sees as a touch end (a
 *  gesture-handler swipe claims its touch): call it where the gesture commits. */
export function probeGesture() {
  const now = performance.now();
  watchFrames(now, now);
}

function watchFrames(t0: number, seen: number) {
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

// TEMP why-probe
if (PERF_PROBE) {
  const g = globalThis as any;
  const hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const counts: Record<string, number> = {};
  g.__why = counts;
  const preview = (v: any) => { try { const s = typeof v === 'object' && v !== null ? (Array.isArray(v) ? `arr${v.length}` : `obj{${Object.keys(v).slice(0, 4).join(',')}}`) : String(v); return s.slice(0, 40); } catch { return '?'; } };
  const scan = (root: any) => {
    const stack = [root.current];
    while (stack.length) {
      const f = stack.pop();
      if (!f) continue;
      if (f.type && f.type.name === 'SessionScreen' && f.alternate) {
        let a = f.memoizedState, b = f.alternate.memoizedState, i = 0;
        while (a && b) {
          if (a.queue && a.memoizedState !== b.memoizedState) { const k = `h${i}:${preview(a.memoizedState)}`; counts[k] = (counts[k] ?? 0) + 1; }
          a = a.next; b = b.next; i++;
        }
        if (f.memoizedProps !== f.alternate.memoizedProps) counts.props = (counts.props ?? 0) + 1;
        if (!g.__dumped) { g.__dumped = 1; let h = f.memoizedState, j = 0; const out: string[] = []; while (h) { if (j >= 300) out.push(`${j}:${h.queue ? (h.queue.getSnapshot ? 'sync' : 'state') : (Array.isArray(h.memoizedState) ? 'memo' : h.memoizedState && typeof h.memoizedState === 'object' && 'current' in h.memoizedState ? 'ref' : 'other')}=${preview(h.memoizedState)}`); h = h.next; j++; } console.log('[hooks] total=' + j + ' ' + out.join(' | ')); }
        continue;
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
  };
  if (hook) {
    const orig = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (id: any, root: any, ...rest: any[]) { try { scan(root); } catch {} return orig?.call(this, id, root, ...rest); };
  }
  setInterval(() => { console.log('[why]', JSON.stringify(Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 12))); for (const k in counts) delete counts[k]; }, 10000);
}
