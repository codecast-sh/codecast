import { PayloadBudget } from './payloadBudget.js';
import { randomUUID } from 'node:crypto';
import { ConvexError } from 'convex/values';
import { WorkerHost, WorkerUnavailable } from './host.js';
import { ingestTokenPages } from './ingestTransport.js';
import { ByteReceiver, PAYLOAD_PAGE_BYTES, identity, ownFields, record } from './payloadBytes.js';
import { PayloadValueAssembler } from './payloadValues.js';
import { validMessagesSdkPage, validMessagesSdkPayload, type MessagesSdkPage, type MessagesSdkPayload } from './messagesSdkTypes.js';
import type { PreparedWireMessage } from '../messagePreparation.js';

type Command = MessagesSdkPayload extends infer P ? P extends MessagesSdkPayload ? Omit<P, 'cursor' | 'generation' | 'sequence'> : never : never;
type Log = { method: 'log' | 'warn' | 'error' | 'logVerbose'; args: unknown[] };
export type MessagesSdkDispatch = (init: RequestInit & { duplex: 'half' }) => Promise<Response>;
const occupied = new WeakSet<WorkerHost>();
const yieldMain = () => new Promise<void>(resolve => setImmediate(resolve));

export class MessagesSdkBatch {
  private cursor = '';
  private sequence = 0;
  private generation = randomUUID();
  private hostGeneration = 0;
  private closed = false;
  private sending = false;
  private completed?: Promise<void>;
  private settle?: () => void;
  private cancellation = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private abort = () => { this.cancellation.abort(this.signal?.reason); void this.close(); };
  custody: 'not-dispatched' | 'unknown' | 'accepted' = 'not-dispatched';
  acceptedOutcome?: { value: unknown };
  private constructor(private readonly host: WorkerHost, private readonly budget: PayloadBudget, private readonly signal?: AbortSignal) {
    this.timer = setTimeout(() => { this.cancellation.abort(new WorkerUnavailable('messages SDK deadline')); void this.close(); }, Math.max(1, budget.remainingMs()));
    this.timer.unref(); signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  static async open(value: { messages: PreparedWireMessage[]; bytes: number[] }, conversationId: string, options: { host: WorkerHost; budget: PayloadBudget; signal?: AbortSignal }): Promise<MessagesSdkBatch> {
    if (occupied.has(options.host) || options.budget.remainingMs() <= 0) throw new WorkerUnavailable('messages SDK unavailable');
    occupied.add(options.host);
    const batch = new MessagesSdkBatch(options.host, options.budget, options.signal ?? options.budget.signal);
    try {
      await batch.request({ action: 'open', conversationId, messageCount: value.messages.length, budgetMs: options.budget.remainingMs() });
      for await (const tokens of ingestTokenPages(value)) await batch.request({ action: 'push', tokens });
      await batch.request({ action: 'seal' });
      return batch;
    } catch (error) { await batch.close(); throw error; }
  }
  private current() {
    if (this.closed || this.cancellation.signal.aborted || this.host.state.closed || this.hostGeneration && this.host.state.generation !== this.hostGeneration || this.budget.remainingMs() <= 0) throw new WorkerUnavailable('messages SDK no longer available');
  }
  private async request(command: Command): Promise<MessagesSdkPage> {
    this.current();
    const sequence = this.sequence;
    const payload = command.action === 'open' ? { ...command, generation: this.generation } : { ...command, cursor: this.cursor, generation: this.generation, sequence };
    if (!validMessagesSdkPayload(payload)) throw new WorkerUnavailable('invalid messages SDK request');
    this.sequence++;
    const page = await this.host.request('messagesSdk', payload, { timeoutMs: Math.max(1, Math.ceil(Math.min(60_000, this.budget.remainingMs()))), signal: this.cancellation.signal });
    if (!validMessagesSdkPage(page) || page.sequence !== sequence || page.generation !== this.generation || this.cursor && page.cursor !== this.cursor) throw new WorkerUnavailable('invalid messages SDK reply');
    if (!this.cursor) { this.cursor = page.cursor; this.hostGeneration = this.host.state.generation; }
    this.current(); await yieldMain(); return page;
  }
  private async outcome(network?: { reference: string; error: unknown }, logger?: (log: Log) => void, onAccepted?: (value: unknown) => void): Promise<unknown> {
    const assembler = new PayloadValueAssembler();
    for (;;) {
      const page = await this.request({ action: 'outcomeNext' });
      if (page.stage !== 'values') throw new WorkerUnavailable('invalid SDK outcome page');
      assembler.push(page.tokens);
      if (page.done) break;
    }
    const value = assembler.finish();
    if (!record(value) || !Array.isArray(value.logs)) throw new WorkerUnavailable('invalid SDK outcome');
    const fields = value.kind === 'success' ? ['kind', 'value', 'logs'] : value.kind === 'network' ? ['kind', 'reference', 'logs'] : value.kind === 'error' ? ['kind', 'type', 'name', 'message', 'data', 'logs'] : [];
    if (!fields.length || !ownFields(value, fields)) throw new WorkerUnavailable('invalid SDK outcome shape');
    if (value.kind === 'success' && !Object.hasOwn(value, 'value')) throw new WorkerUnavailable('missing SDK result');
    if (value.kind === 'success') {
      this.custody = 'accepted';
      this.acceptedOutcome = { value: value.value };
      onAccepted?.(value.value);
    }
    for (let i = 0; i < value.logs.length; i++) {
      const log = value.logs[i];
      if (!record(log) || !ownFields(log, ['method', 'args']) || !Array.isArray(log.args) || !log.args.every((arg: unknown) => typeof arg === 'string') || !(log.method === 'log' && log.args.length === 3 || log.method === 'error' && log.args.length === 1)) throw new WorkerUnavailable('invalid SDK log');
      if (i % 128 === 127) { await yieldMain(); this.current(); }
    }
    for (const log of value.logs as Log[]) {
      if (logger) logger(log);
      else if (log.method !== 'logVerbose') console[log.method](...log.args);
      await yieldMain();
    }
    if (value.kind === 'success') return value.value;
    if (value.kind === 'network') {
      if (!network || !identity(value.reference) || value.reference !== network.reference) throw new WorkerUnavailable('invalid SDK network reference');
      throw network.error;
    }
    if (typeof value.name !== 'string' || typeof value.message !== 'string' || !['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ConvexError'].includes(value.type) || value.type !== 'ConvexError' && Object.hasOwn(value, 'data')) throw new WorkerUnavailable('invalid SDK error');
    const constructors: Record<string, new (message: string) => Error> = { Error, TypeError, SyntaxError, RangeError, ConvexError };
    const error = new constructors[value.type as keyof typeof constructors](value.message);
    error.name = value.name;
    if (error instanceof ConvexError) error.data = value.data;
    throw error;
  }
  async send(options: { getApiToken: () => string; dispatch: MessagesSdkDispatch; logger?: (log: Log) => void; onAccepted?: (value: unknown) => void }): Promise<unknown> {
    this.current();
    if (this.sending) throw new WorkerUnavailable('messages SDK send busy');
    this.sending = true;
    this.completed = new Promise<void>(resolve => { this.settle = resolve; });
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let requestBody: ReadableStream<Uint8Array> | undefined;
    let waiter: Promise<MessagesSdkPage> | undefined;
    let cancellationRead: Promise<void> | undefined;
    const cancelResponse = () => {
      cancellationRead = reader ? reader.cancel(this.cancellation.signal.reason).catch(() => {}) : response?.body?.cancel(this.cancellation.signal.reason).catch(() => {});
    };
    this.cancellation.signal.addEventListener('abort', cancelResponse, { once: true });
    try {
      let token = options.getApiToken();
      let capture = await this.request({ action: 'begin', apiToken: token });
      while (capture.stage === 'capture' && token !== options.getApiToken()) {
        await this.request({ action: 'reset' });
        token = options.getApiToken();
        capture = await this.request({ action: 'begin', apiToken: token });
      }
      if (capture.stage === 'outcome') return await this.outcome(undefined, options.logger, options.onAccepted);
      if (capture.stage !== 'capture') throw new WorkerUnavailable('invalid SDK capture');
      const expected = capture.capture;
      const sent = new ByteReceiver(expected);
      let ended = false;
      const body = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            if (ended) return;
            const page = await this.request({ action: 'requestNext' });
            if (page.stage !== 'bytes') throw new WorkerUnavailable('invalid SDK request page');
            if (!page.page.data && (!page.done || page.page.offset !== 0 || expected.length !== 0)) throw new WorkerUnavailable('empty SDK request page');
            const bytes = page.page.data ? sent.push(page.page) : Buffer.alloc(0);
            if (page.done) { sent.finish(); ended = true; }
            if (bytes.length) controller.enqueue(bytes);
            if (ended) controller.close();
          } catch (error) { controller.error(error); this.cancellation.abort(error); }
        },
        cancel: () => { ended = true; },
      }, { highWaterMark: 1 });
      requestBody = body;
      waiter = this.request({ action: 'waitOutcome' });
      void waiter.catch(error => { this.cancellation.abort(error); });
      let network: { reference: string; error: unknown } | undefined;
      try {
        this.current();
        this.custody = 'unknown';
        response = await options.dispatch({ method: 'POST', headers: { ...expected.headers, 'Content-Length': String(expected.length) }, body, duplex: 'half', signal: this.cancellation.signal, redirect: 'error' });
        this.current();
        await this.request({ action: 'responseStart', status: response.status, body: response.body !== null });
        const received = new ByteReceiver();
        reader = response.body?.getReader();
        if (reader) for (;;) {
          const chunk = await reader.read();
          this.current();
          if (chunk.done) break;
          for (let offset = 0; offset < chunk.value.length; offset += PAYLOAD_PAGE_BYTES) {
            const bytes = Buffer.from(chunk.value.buffer, chunk.value.byteOffset + offset, Math.min(PAYLOAD_PAGE_BYTES, chunk.value.length - offset));
            const page = { offset: received.length, data: bytes.toString('base64') };
            received.push(page);
            await this.request({ action: 'responsePush', page });
          }
        }
        await this.request({ action: 'responseEnd', descriptor: received.finish() });
      } catch (error) {
        this.current();
        network = { reference: randomUUID(), error };
        await this.request({ action: 'networkError', reference: network.reference });
      }
      await waiter;
      return await this.outcome(network, options.logger, options.onAccepted);
    } finally {
      try {
        this.cancellation.abort();
        await cancellationRead;
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else await response?.body?.cancel().catch(() => {});
        await requestBody?.cancel().catch(() => {});
        await waiter?.catch(() => {});
      } finally {
        await this.dispose();
        this.cancellation.signal.removeEventListener('abort', cancelResponse);
        this.sending = false;
        this.settle?.();
      }
    }
  }
  async close(): Promise<void> {
    this.cancellation.abort();
    if (this.sending) { await this.completed; return; }
    await this.dispose();
  }
  private async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.cancellation.abort(); clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.abort);
    try {
      if (this.cursor && this.host.state.generation === this.hostGeneration && this.host.state.pid !== null && !this.host.state.closed) await this.host.request('messagesSdk', { action: 'close', cursor: this.cursor, generation: this.generation, sequence: this.sequence++ }, { timeoutMs: 1000 });
    } catch {} finally { occupied.delete(this.host); }
  }
}
