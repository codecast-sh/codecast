// One layout read per frame for the layout reads that follow DOM writes.
//
// A layout read (scrollHeight, clientWidth, getComputedStyle, ...) made after
// any DOM write lays the whole page out synchronously, and the next write
// throws that layout away. A conversation switch, a diff panel toggle and a
// send each ran several such reads, every one between writes: the transcript's
// commit, then a scroll hold, an overflow check, a composer measure and a
// scroll listener, each reading and then writing (ct-101461, 250-300ms frames
// with 100-150ms of it forced layout).
//
// measureInFrame queues a read and the write that uses its answer. At the
// start of the next animation frame, before the browser paints, every queued
// read runs, then every write. The page is laid out at most once for all of
// them, and the frame's own layout reuses it. A job queued by a write (a
// scroll event a write dispatched) runs in a further round of the same frame,
// so nothing waits for the frame after. A job queued after this frame's pass
// but before its paint (a commit an observer callback flushed) runs in a
// microtask instead: waiting for the next frame would paint without it.
type Job = { read: () => unknown; write?: (value: any) => void };

const queues = new Map<Window | typeof globalThis, Job[]>();
// Windows whose pass ran this frame and that have not painted it yet, with
// how many microtask runs each has had since. A chain of jobs that queue each
// other through events would otherwise run in microtasks forever and starve
// the task that ends the pass; past a few runs they wait for the next frame.
const passed = new Map<Window | typeof globalThis, number>();
const MICROTASK_RUNS = 4;

function raf(win: Window | typeof globalThis): ((cb: () => void) => unknown) | null {
  const fn = (win as Window).requestAnimationFrame;
  return typeof fn === "function" ? fn.bind(win) : null;
}

function run(win: Window | typeof globalThis, fromFrame: boolean) {
  if (fromFrame && !passed.has(win)) {
    passed.set(win, 0);
    // A task queued from an animation frame runs after that frame paints.
    setTimeout(() => passed.delete(win), 0);
  } else if (!fromFrame && passed.has(win)) {
    passed.set(win, passed.get(win)! + 1);
  }
  // A write that queues a job adds a round; a write that keeps queueing
  // itself must not hold the frame forever.
  // A job that throws still leaves the queue able to schedule the next one.
  try {
    for (let round = 0; round < 8; round++) {
      const jobs = queues.get(win);
      if (!jobs || jobs.length === 0) break;
      queues.set(win, []);
      const values = jobs.map((j) => j.read());
      jobs.forEach((j, i) => j.write?.(values[i]));
    }
  } finally {
    const left = queues.get(win) ?? [];
    queues.delete(win);
    // Whatever is still queued waits for the next frame.
    if (left.length > 0) schedule(win, left, raf(win));
  }
}

function schedule(win: Window | typeof globalThis, jobs: Job[], frame: ((cb: () => void) => unknown) | null) {
  queues.set(win, jobs);
  if (frame) frame(() => run(win, true));
  else queueMicrotask(() => run(win, false));
}

/** Run `read` at the start of the next frame with every other queued read,
 *  then `write` with its answer once all reads are done. `win` is the window
 *  that owns the element read (a test's fake scroller has its own). Without
 *  animation frames (a DOM-less test), or once this frame's pass has run,
 *  the job runs in a microtask. */
export function measureInFrame<T>(read: () => T, write?: (value: T) => void, win: Window | typeof globalThis = globalThis): void {
  const jobs = queues.get(win);
  if (jobs) { jobs.push({ read, write }); return; }
  const runs = passed.get(win);
  schedule(win, [{ read, write }], runs !== undefined && runs < MICROTASK_RUNS ? null : raf(win));
}
