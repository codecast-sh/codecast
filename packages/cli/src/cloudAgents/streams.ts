/**
 * The live streams a cloud agent adapter follows, one mechanism for every
 * provider. A follow is keyed (an agent, a run), opens its provider's stream,
 * folds each event into the agent's record (events.json) and has the mirror
 * re-render; when it ends, the agent is mirrored again from the API, which
 * opens another while the agent still runs.
 *
 * The core owns what every provider's follower needs: one follow per key,
 * buffering events until the mirror's handle attaches (a stream opened before
 * the agent has one: a create, a follow-up), a quiet timeout, reconnects with
 * backoff, the dropped-stream log line, and stop(). An adapter supplies how to
 * open its stream and what an event means.
 */
import { errorText, logTag, type AnyCloudAgentAdapter, type CloudAgentHandle } from "./types.js";

/** A stream that ended without delivering anything waits this long before the next opens, doubling up to STREAM_RETRY_MAX_MS. */
const STREAM_RETRY_MS = 2_000;
const STREAM_RETRY_MAX_MS = 60_000;

export interface CloudStreamSpec<E, D> {
  /** Open the stream. `attempt` counts reconnects within this follow (0 first). */
  open(signal: AbortSignal, attempt: number): Promise<AsyncIterable<E>>;
  /** Fold one event into the agent's record (`at`: when it arrived). "end" when what the stream follows is over. */
  apply(e: E, data: D, at: number): "end" | void;
  /** After the stream ended on its own: whether the work it followed is over, so no reconnect. */
  finished?(): boolean;
  /** An error that means the stream is gone for good (expired): the follow ends without a reconnect. */
  gone?(err: unknown): boolean;
  /** Reconnects after a drop before the follow ends (default 0: the next mirror opens another while the agent still runs). */
  reconnects?: number;
  /** A stream with nothing to say for this long is closed. */
  quietMs?: number;
}

/** One follow: its stream's state, and the handle its events land through. */
export class CloudStream<E, D> {
  readonly controller = new AbortController();
  readonly openedAt: number;
  lastEventAt: number;
  /** Events arrived since it opened. */
  delivered = 0;
  ended = false;
  /** Resolves once the first stream is open (or failed to open): the provider is listening from then on. */
  readonly opened: Promise<void>;
  private markOpened!: () => void;
  private handle?: CloudAgentHandle<D>;
  private readonly buffer: Array<{ e: E; at: number }> = [];

  constructor(readonly spec: CloudStreamSpec<E, D>, private readonly now: () => number) {
    this.openedAt = this.lastEventAt = now();
    this.opened = new Promise((resolve) => { this.markOpened = resolve; });
  }

  get attached(): boolean {
    return !!this.handle;
  }

  /** Give the stream its mirror handle: what it kept lands now. True on the first attach. */
  attach(handle: CloudAgentHandle<D>): boolean {
    if (this.handle) return false;
    this.handle = handle;
    for (const { e, at } of this.buffer.splice(0)) this.spec.apply(e, handle.data(), at);
    return true;
  }

  /** One event. The render that follows saves the record, so a stream of deltas never serializes it per event. */
  push(e: E): "end" | void {
    this.lastEventAt = this.now();
    this.delivered++;
    if (!this.handle) { this.buffer.push({ e, at: this.lastEventAt }); return; }
    const verdict = this.spec.apply(e, this.handle.data(), this.lastEventAt);
    this.handle.scheduleRender();
    return verdict;
  }

  abort(): void {
    this.controller.abort();
  }

  /** @internal */
  opening(): void {
    this.markOpened();
  }

  /** @internal Mirror the agent from the API again (the follow ended). */
  follow(): void {
    void this.handle?.follow();
  }

  /** @internal */
  log(msg: string): void {
    this.handle?.log(msg);
  }
}

export class CloudAgentStreams<E, D> {
  private readonly live = new Map<string, CloudStream<E, D>>();
  /** Keys whose stream keeps ending without a word: when the next may open, and the wait after that. */
  private readonly retry = new Map<string, { at: number; waitMs: number }>();
  private readonly now: () => number;

  constructor(private readonly adapter: Pick<AnyCloudAgentAdapter, "spec">, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  get(key: string): CloudStream<E, D> | undefined {
    return this.live.get(key);
  }

  has(key: string): boolean {
    return this.live.has(key);
  }

  /**
   * Start following `key`, unless a follow already does or a stream just
   * kept ending without a word (undefined then). `handle`: the mirror's, when
   * the agent has one; else events wait for attach. `prior`: events already
   * read from the stream before the key was known (a create's first ones).
   */
  follow(key: string, spec: CloudStreamSpec<E, D>, opts: { handle?: CloudAgentHandle<D>; prior?: E[] } = {}): CloudStream<E, D> | undefined {
    if (this.live.has(key)) return undefined;
    const backoff = this.retry.get(key);
    if (backoff && this.now() < backoff.at) return undefined;
    const stream = new CloudStream(spec, this.now);
    for (const e of opts.prior ?? []) stream.push(e);
    if (opts.handle) stream.attach(opts.handle);
    this.live.set(key, stream);
    void this.run(key, stream);
    return stream;
  }

  /**
   * The mirror's side: give `key`'s follow the agent's handle. `first`: this
   * attach landed what the stream kept before it. `live`: the follow, while it
   * still runs (one that ended before the mirror came is let go here).
   */
  attach(key: string, handle: CloudAgentHandle<D>): { first: boolean; live?: CloudStream<E, D> } {
    const s = this.live.get(key);
    if (!s) return { first: false };
    const first = s.attach(handle);
    if (!s.ended) return { first, live: s };
    this.live.delete(key);
    return { first };
  }

  /** Stop following `key` (its stream is closed; nothing re-mirrors it). */
  drop(key: string, stream?: CloudStream<E, D>): void {
    const s = this.live.get(key);
    if (!s || (stream && s !== stream)) return;
    this.live.delete(key);
    s.abort();
  }

  stop(): void {
    for (const s of this.live.values()) s.abort();
    this.live.clear();
  }

  private async run(key: string, stream: CloudStream<E, D>): Promise<void> {
    const { spec } = stream;
    let quiet: NodeJS.Timeout | undefined;
    const armQuiet = () => {
      if (!spec.quietMs) return;
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => stream.abort(), spec.quietMs);
    };
    const signal = stream.controller.signal;
    for (let attempt = 0; !signal.aborted; attempt++) {
      const before = stream.delivered;
      let done = false;
      try {
        armQuiet();
        const events = await spec.open(signal, attempt);
        stream.opening();
        for await (const e of events) {
          armQuiet();
          if (stream.push(e) === "end") { done = true; break; }
        }
        if (spec.finished?.()) done = true;
      } catch (err) {
        stream.opening();
        if (signal.aborted) break;
        if (spec.gone?.(err)) done = true;
        else stream.log(`${logTag(this.adapter)} ${key} stream dropped: ${errorText(err)}`);
      }
      const said = stream.delivered > before;
      if (said) this.retry.delete(key);
      else {
        const waitMs = Math.min((this.retry.get(key)?.waitMs ?? STREAM_RETRY_MS / 2) * 2, STREAM_RETRY_MAX_MS);
        this.retry.set(key, { at: this.now() + waitMs, waitMs });
      }
      if (done || signal.aborted || attempt >= (spec.reconnects ?? 0)) break;
      await abortableSleep(this.retry.get(key)?.waitMs ?? STREAM_RETRY_MS, signal);
    }
    if (quiet) clearTimeout(quiet);
    stream.opening();
    stream.abort();
    stream.ended = true;
    // Stopped, dropped or replaced: nothing more for this follow to do.
    if (this.live.get(key) !== stream) return;
    // One the mirror has not attached yet stays, for it to take what it kept.
    if (!stream.attached) return;
    this.live.delete(key);
    stream.follow();
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}
