import { randomUUID } from 'node:crypto';
import { ingestWorkerHost } from './bridge.js';
import { WorkerHost, WorkerUnavailable } from './host.js';
import { IngestAssembler, ingestTokenPages } from './ingestTransport.js';
import { PREPARATION_COMPUTE_MS, PREPARATION_LIFETIME_MS, type PreparationPage, type PreparationPayload } from './preparationTypes.js';
import type { PreparationImage, PreparationMessage, PreparationOrigin, PreparedWireMessage } from '../messagePreparation.js';

type Command = PreparationPayload extends infer P ? P extends PreparationPayload ? Omit<P, 'cursor' | 'generation' | 'sequence'> : never : never;
const occupied = new WeakSet<WorkerHost>();
const yieldMain = () => new Promise<void>(resolve => setImmediate(resolve));

export class MessagePreparation {
  private cursor = '';
  private sequence = 0;
  private generation = randomUUID();
  private hostGeneration = 0;
  private remaining = PREPARATION_COMPUTE_MS;
  private expires = performance.now() + PREPARATION_LIFETIME_MS;
  private closed = false;
  private busy = false;
  private cancellation = new AbortController();
  private abort = () => { void this.close(); };
  private timer: ReturnType<typeof setTimeout>;
  maxWorkerRss = 0;
  maxPageBytes = 0;
  private constructor(private readonly host: WorkerHost, private readonly signal?: AbortSignal) {
    this.timer = setTimeout(() => { void this.close(); }, PREPARATION_LIFETIME_MS);
    this.timer.unref();
    this.signal?.addEventListener('abort', this.abort, { once: true });
  }
  static async open(messages: PreparationMessage[], origin: PreparationOrigin, options: { host?: WorkerHost; signal?: AbortSignal } = {}): Promise<MessagePreparation> {
    const host = options.host ?? ingestWorkerHost();
    if (!host || occupied.has(host)) throw new WorkerUnavailable('preparation unavailable');
    occupied.add(host);
    const session = new MessagePreparation(host, options.signal);
    try {
      await session.transaction(async () => {
        await session.request({ action: 'open', origin });
        await session.write(messages);
      });
      return session;
    } catch (error) { await session.close(); throw error; }
  }
  private current() {
    if (this.closed || this.signal?.aborted || this.host.state.closed || this.hostGeneration && this.host.state.generation !== this.hostGeneration || performance.now() >= this.expires || this.remaining <= 0) throw new WorkerUnavailable('preparation no longer available');
  }
  private async transaction<T>(run: () => Promise<T>): Promise<T> {
    this.current();
    if (this.busy) throw new WorkerUnavailable('preparation busy');
    this.busy = true;
    const started = performance.now(), deadline = started + this.remaining;
    const timer = setTimeout(() => { void this.close(); }, this.remaining);
    try {
      const result = await run();
      this.current();
      if (performance.now() >= deadline) throw new WorkerUnavailable('preparation deadline');
      return result;
    } catch (error) { await this.close(); throw error; }
    finally { clearTimeout(timer); this.remaining = Math.min(this.remaining, deadline - performance.now()); this.busy = false; }
  }
  private async request(command: Command): Promise<PreparationPage> {
    this.current();
    const payload = command.action === 'open' ? { ...command, generation: this.generation } : { ...command, cursor: this.cursor, generation: this.generation, sequence: this.sequence };
    const page = await this.host.request('prepare', payload, { timeoutMs: Math.max(1, Math.ceil(this.remaining)), signal: this.cancellation.signal }) as PreparationPage;
    if (!this.cursor) { this.cursor = page.cursor; this.hostGeneration = this.host.state.generation; }
    this.current();
    if (page.cursor !== this.cursor || page.generation !== this.generation || page.sequence !== this.sequence) throw new WorkerUnavailable('preparation response identity mismatch');
    this.sequence++;
    this.remaining = Math.min(this.remaining, page.computeRemainingMs);
    this.maxWorkerRss = Math.max(this.maxWorkerRss, page.rss);
    this.maxPageBytes = Math.max(this.maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
    await yieldMain();
    return page;
  }
  private async write(value: unknown) {
    for await (const tokens of ingestTokenPages(value)) await this.request({ action: 'push', tokens });
    await this.request({ action: 'seal' });
  }
  private async read(command: Command): Promise<unknown> {
    const assembler = new IngestAssembler();
    let page = await this.request(command);
    for (;;) {
      assembler.push(page.tokens);
      await yieldMain();
      if (page.done) return assembler.finish();
      page = await this.request({ action: 'next' });
    }
  }
  paths(index: number): Promise<string[]> {
    return this.transaction(async () => await this.read({ action: 'paths', index }) as string[]);
  }
  replaceLinks(index: number, urls: Array<[number, string]>): Promise<void> {
    return this.transaction(async () => { await this.request({ action: 'replace', index, urls }); });
  }
  setImages(index: number, images: PreparationImage[]): Promise<void> {
    return this.transaction(async () => { await this.request({ action: 'images', index }); await this.write(images); });
  }
  finish(): Promise<{ messages: PreparedWireMessage[]; bytes: number[] }> {
    return this.transaction(async () => await this.read({ action: 'finish' }) as { messages: PreparedWireMessage[]; bytes: number[] });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancellation.abort();
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.abort);
    occupied.delete(this.host);
    if (this.cursor && !this.host.state.closed && this.host.state.pid !== null && this.host.state.generation === this.hostGeneration) {
      await this.host.request('prepare', { action: 'close', cursor: this.cursor, generation: this.generation, sequence: this.sequence }, { timeoutMs: 1000 }).catch(() => {});
    }
  }
}
