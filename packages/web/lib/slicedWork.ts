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

// ── a derivation kept outside render ──────────────────────────────────────────

type StepSlot = { deps: ReadonlyArray<unknown>; value: unknown };
const sameDeps = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>) => a.length === b.length && a.every((d, i) => Object.is(d, b[i]));
const isSliced = (x: unknown): x is Sliced<unknown> => !!x && typeof (x as Generator).next === "function" && typeof (x as Generator)[Symbol.iterator] === "function";

/** A derivation's steps, each kept in a slot with the inputs it was made from: a run whose inputs moved only a little
 *  makes again only the steps whose inputs moved. One value per slot, replaced when its inputs change. */
export class StepCache {
  private slots = new Map<string, StepSlot>();
  /** The slot's value when its inputs are the ones given, else made (sliced when `make` returns a generator) and kept. */
  *step<T>(slot: string, deps: ReadonlyArray<unknown>, make: () => T | Sliced<T>): Sliced<T> {
    const was = this.slots.get(slot);
    if (was && sameDeps(was.deps, deps)) return was.value as T;
    const made = make();
    const value = isSliced(made) ? ((yield* made) as T) : (made as T);
    this.slots.set(slot, { deps, value });
    return value;
  }
}

type JobView<R> = { result: R | null; scope: string | null };

/** One kept derivation: its steps' cache, the run in flight, and the last result it published for a scope. */
export class SlicedJob<I, R> {
  readonly cache = new StepCache();
  private view: JobView<R> = { result: null, scope: null };
  private listeners = new Set<() => void>();
  private run: SlicedRun | null = null;
  private deps: ReadonlyArray<unknown> | null = null;
  constructor(private readonly steps: (inputs: I, cache: StepCache, early: (result: R) => void) => Sliced<R>) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  read = () => this.view;
  private publish(result: R, scope: string) {
    this.view = { result, scope };
    for (const fn of [...this.listeners]) fn();
  }
  /** Runs the derivation for these inputs unless a run for the same ones is done or under way. A first look at a scope
   *  takes the steps' early result (what the page can show while the rest finishes); a later run publishes only its
   *  whole result, so what is on screen never steps back. */
  start(inputs: I, deps: ReadonlyArray<unknown>, scope: string) {
    if (this.deps && sameDeps(this.deps, deps)) return;
    this.run?.cancel();
    this.deps = deps;
    const early = (result: R) => { if (this.view.scope !== scope) this.publish(result, scope); };
    this.run = runSliced(this.steps(inputs, this.cache, early), (result) => { this.run = null; this.publish(result, scope); });
  }
}
