import { MAX_DEADLINE_MS } from './protocol.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export class IngestCancelled extends Error {}
export class IngestDeadlineExceeded extends Error {}
export class IngestDeadline {
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private end: number;
  private abort: () => void;
  // Set when the transaction that owns this deadline has returned. Timers and
  // detached promises armed inside the scope keep its AsyncLocalStorage
  // context forever, so without this a loop first armed during an ingest
  // (the fleet heartbeat flush) inherited a deadline that expired minutes
  // later and failed every call it made from then on.
  disposed = false;
  constructor(timeoutMs = MAX_DEADLINE_MS, private parentSignal?: AbortSignal, private clock = () => performance.now()) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DEADLINE_MS) throw new Error('invalid ingest deadline');
    this.end = clock() + timeoutMs;
    this.signal = this.controller.signal;
    this.abort = () => this.controller.abort(parentSignal?.reason instanceof IngestDeadlineExceeded ? parentSignal.reason : new IngestCancelled('ingest stopped'));
    parentSignal?.addEventListener('abort',this.abort,{once:true});
    if (parentSignal?.aborted) this.abort();
    this.timer = setTimeout(() => this.controller.abort(new IngestDeadlineExceeded('ingest transaction deadline')),Math.ceil(timeoutMs));
    this.timer.unref?.();
  }
  remaining(): number {
    this.check();
    return Math.max(1,Math.ceil(this.end-this.clock()));
  }
  check(): void {
    if (this.signal.aborted) throw this.signal.reason;
    if (this.clock() >= this.end) {
      const error = new IngestDeadlineExceeded('ingest transaction deadline');
      this.controller.abort(error);
      throw error;
    }
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.parentSignal?.removeEventListener('abort',this.abort);
  }
}
const transcriptDeadline = new AsyncLocalStorage<IngestDeadline>();
export const currentTranscriptDeadline = (): IngestDeadline | undefined => {
  const deadline = transcriptDeadline.getStore();
  return deadline && !deadline.disposed ? deadline : undefined;
};
export const checkTranscriptDeadline = () => currentTranscriptDeadline()?.check();
// Run fn with no transcript deadline in scope: for daemon-wide work (a fleet
// timer, a standing loop) that may be armed from inside an ingest but must
// never be bounded by that one transcript's budget.
export const outsideTranscriptDeadline = <T>(fn: () => T): T => transcriptDeadline.exit(fn);
export async function withTranscriptDeadline<T>(run: () => Promise<T>, options: {signal?: AbortSignal; timeoutMs?: number} = {}): Promise<T> {
  const previous = currentTranscriptDeadline();
  if (previous) { previous.check(); return run(); }
  const deadline = new IngestDeadline(options.timeoutMs,options.signal);
  try { return await transcriptDeadline.run(deadline,run); }
  finally { deadline.dispose(); }
}
export async function waitForTranscriptReservation(before: Promise<void> | undefined, deadline: IngestDeadline): Promise<void> {
  deadline.check();
  if (!before) return;
  await new Promise<void>((resolve,reject) => {
    const abort = () => reject(deadline.signal.reason);
    deadline.signal.addEventListener('abort',abort,{once:true});
    before.then(() => { deadline.signal.removeEventListener('abort',abort); resolve(); });
  });
  deadline.check();
}
