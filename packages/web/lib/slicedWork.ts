// Work that yields. A long derivation written as a generator yields at points
// where it may stop; `drain` runs it to the end at once (the synchronous
// reading, one implementation for both), and `runSliced` runs it in slices of
// a few milliseconds, handing the main thread back between them, so a page
// building something large still answers input and paints while it builds.
//
// Slices are scheduled with a MessageChannel message: not clamped like a
// timer, and not paused in a hidden tab like an animation frame.

/** A computation that may stop where it yields. */
export type Sliced<T> = Generator<void, T, void>;

/** Runs a sliced computation to its end, now. */
export function drain<T>(work: Sliced<T>): T {
  for (;;) {
    const r = work.next();
    if (r.done) return r.value;
  }
}

/** Yields every `every` calls: put one in a loop, and the loop stops there every so often. */
export function yieldEvery(every: number): () => boolean {
  let n = 0;
  return () => ++n % every === 0;
}

const channel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const queue: Array<() => void> = [];
if (channel) channel.port1.onmessage = () => queue.shift()?.();
const later = (fn: () => void) => {
  if (!channel) { setTimeout(fn, 0); return; }
  queue.push(fn);
  channel.port2.postMessage(0);
};

/** A sliced computation in progress; `cancel` stops it at its next slice. */
export type SlicedRun = { cancel: () => void };

/** Runs a sliced computation in slices of about `budgetMs`, then hands its result to `done`. */
export function runSliced<T>(work: Sliced<T>, done: (value: T) => void, budgetMs = 8): SlicedRun {
  let cancelled = false;
  const slice = () => {
    if (cancelled) return;
    const start = performance.now();
    for (;;) {
      const r = work.next();
      if (r.done) { done(r.value); return; }
      if (performance.now() - start >= budgetMs) { later(slice); return; }
    }
  };
  later(slice);
  return { cancel: () => { cancelled = true; } };
}
