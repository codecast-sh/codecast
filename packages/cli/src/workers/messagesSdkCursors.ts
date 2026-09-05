import { PayloadBudget } from './payloadBudget.js';
import { ConvexHttpClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { validatePreparedOutput } from '../messagePreparationValidation.js';
import type { PreparedWireMessage } from '../messagePreparation.js';
import { IngestAssembler } from './ingestTransport.js';
import { bytePage, describeBytes, type BytePage } from './payloadBytes.js';
import { MessagesSdkResponse } from './messagesSdkResponse.js';
import { payloadValuePages, type PayloadToken } from './payloadValues.js';
import type { MessagesSdkPage, MessagesSdkPayload, SdkCapture } from './messagesSdkTypes.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type Log = { method: 'log' | 'warn' | 'error' | 'logVerbose'; args: unknown[] };
type Attempt = {
  body?: Buffer;
  offset: number;
  captured: ReturnType<typeof deferred<SdkCapture>>;
  fetch: ReturnType<typeof deferred<Response>>;
  outcome: Promise<unknown>;
  logs: Log[];
  response?: MessagesSdkResponse;
  responseEnded: boolean;
  waiting: boolean;
  errorReference?: { reference: string };
  output?: AsyncGenerator<PayloadToken[]>;
};
type Cursor = { generation: string; sequence: number; conversationId: string; messageCount: number; input?: IngestAssembler; messages?: PreparedWireMessage[]; attempt?: Attempt; budget: PayloadBudget; timer: ReturnType<typeof setTimeout>; busy: boolean };

function sdkError(error: unknown, logs: Log[], reference?: { reference: string }): unknown {
  if (reference && error === reference) return { kind: 'network', reference: reference.reference, logs };
  if (!(error instanceof Error)) throw new Error('unsupported SDK error');
  const type = error instanceof ConvexError ? 'ConvexError' : error instanceof SyntaxError ? 'SyntaxError' : error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error.constructor === Error ? 'Error' : undefined;
  if (!type) throw new Error('unsupported SDK error class');
  return { kind: 'error', type, name: error.name, message: error.message, ...(type === 'ConvexError' ? { data: (error as ConvexError<any>).data } : {}), logs };
}

export class MessagesSdkCursors {
  private cursors = new Map<string, Cursor>();
  get size() { return this.cursors.size; }
  private current(key: string, cursor: Cursor) {
    if (this.cursors.get(key) !== cursor || cursor.budget.remainingMs() <= 0) throw new Error('messages SDK expired');
  }
  private stop(cursor: Cursor) {
    const attempt = cursor.attempt;
    if (!attempt) return;
    const error = new Error('messages SDK closed');
    attempt.fetch.reject(error); attempt.captured.reject(error);
    attempt.response?.close();
    attempt.body = undefined;
    void attempt.output?.return(undefined);
    cursor.attempt = undefined;
  }
  private close(key: string) {
    const cursor = this.cursors.get(key);
    if (!cursor) return;
    this.cursors.delete(key); clearTimeout(cursor.timer); this.stop(cursor);
  }
  private start(cursor: Cursor, apiToken: string): Attempt {
    if (!cursor.messages || cursor.attempt) throw new Error('messages SDK not ready');
    const attempt: Attempt = { offset: 0, captured: deferred<SdkCapture>(), fetch: deferred<Response>(), outcome: Promise.resolve(), logs: [], responseEnded: false, waiting: false };
    const log = (method: Log['method']) => (...args: unknown[]) => {
      if (attempt.logs.length >= 1_000_000) throw new Error('messages SDK log limit');
      attempt.logs.push({ method, args });
    };
    const sdk = new ConvexHttpClient('http://127.0.0.1:0', {
      skipConvexDeploymentUrlCheck: true,
      logger: { log: log('log'), warn: log('warn'), error: log('error'), logVerbose: log('logVerbose') },
      fetch: (async (url, init) => {
        if (url !== 'http://127.0.0.1:0/api/mutation' || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('unexpected SDK request');
        const headers = init.headers as SdkCapture['headers'];
        if (!headers || Object.keys(headers).length !== 2 || headers['Content-Type'] !== 'application/json' || typeof headers['Convex-Client'] !== 'string') throw new Error('unexpected SDK headers');
        attempt.body = Buffer.from(init.body);
        attempt.captured.resolve({ ...describeBytes(attempt.body), headers });
        return attempt.fetch.promise;
      }) as typeof fetch,
    });
    cursor.attempt = attempt;
    attempt.outcome = sdk.mutation('messages:addMessages' as any, { conversation_id: cursor.conversationId, messages: cursor.messages, api_token: apiToken }, { skipQueue: true }).then(
      value => ({ kind: 'success', value, logs: attempt.logs }),
      error => { attempt.captured.reject(error); return sdkError(error, attempt.logs, attempt.errorReference); },
    );
    void attempt.outcome.catch(() => {});
    return attempt;
  }
  async request(payload: MessagesSdkPayload, id: string): Promise<MessagesSdkPage> {
    const key = payload.action === 'open' ? id : payload.cursor;
    if (payload.action === 'open') {
      if (this.cursors.size || payload.budgetMs <= 0 || payload.budgetMs > 60_000) throw new Error('messages SDK unavailable');
      const timer = setTimeout(() => this.close(key), payload.budgetMs); timer.unref();
      this.cursors.set(key, { generation: payload.generation, sequence: 0, conversationId: payload.conversationId, messageCount: payload.messageCount, input: new IngestAssembler(), budget: new PayloadBudget(payload.budgetMs), timer, busy: false });
    }
    const cursor = this.cursors.get(key);
    if (!cursor || cursor.generation !== payload.generation || payload.action !== 'open' && payload.sequence !== cursor.sequence) throw new Error('messages SDK identity');
    const address = { cursor: key, generation: cursor.generation, sequence: cursor.sequence++ };
    const waiting = payload.action === 'waitOutcome';
    if (cursor.busy || waiting && cursor.attempt?.waiting) throw new Error('messages SDK busy');
    if (!waiting) cursor.busy = true;
    try {
      this.current(key, cursor);
      if (payload.action === 'close') { this.close(key); return { ...address, stage: 'ready' }; }
      if (payload.action === 'push') {
        if (!cursor.input) throw new Error('messages SDK input sealed');
        cursor.input.push(payload.tokens);
      } else if (payload.action === 'seal') {
        if (!cursor.input) throw new Error('messages SDK input missing');
        cursor.messages = (await validatePreparedOutput(cursor.input.finish(), cursor.messageCount, () => this.current(key, cursor))).messages;
        cursor.input = undefined;
      } else if (payload.action === 'begin') {
        const attempt = this.start(cursor, payload.apiToken);
        const captured = await Promise.race([attempt.captured.promise.then(capture => ({ capture }), () => null), attempt.outcome.then(() => null)]);
        this.current(key, cursor);
        if (captured) return { ...address, stage: 'capture', capture: captured.capture };
        await attempt.outcome;
        return { ...address, stage: 'outcome' };
      } else if (payload.action === 'reset') {
        if (cursor.attempt?.waiting) throw new Error('messages SDK waiter active');
        this.stop(cursor);
      } else if (payload.action !== 'open') {
        const attempt = cursor.attempt;
        if (!attempt) throw new Error('messages SDK attempt missing');
        if (payload.action === 'requestNext') {
          if (!attempt.body) throw new Error('messages SDK body unavailable');
          const page: BytePage = bytePage(attempt.body, attempt.offset);
          attempt.offset += Buffer.from(page.data, 'base64').length;
          return { ...address, stage: 'bytes', page, done: attempt.offset === attempt.body.length };
        }
        if (payload.action === 'responseStart') {
          if (attempt.response || attempt.responseEnded) throw new Error('messages SDK response duplicate');
          attempt.response = new MessagesSdkResponse(payload.status, payload.body);
        } else if (payload.action === 'responsePush') {
          if (!attempt.response || attempt.responseEnded) throw new Error('messages SDK response not open');
          attempt.response.push(payload.page);
        } else if (payload.action === 'responseEnd') {
          if (!attempt.response || attempt.responseEnded) throw new Error('messages SDK response not open');
          const response = attempt.response.finish(payload.descriptor, () => this.current(key, cursor));
          attempt.responseEnded = true; attempt.fetch.resolve(response);
        } else if (payload.action === 'networkError') {
          if (attempt.errorReference) throw new Error('messages SDK duplicate network error');
          attempt.errorReference = { reference: payload.reference };
          attempt.fetch.reject(attempt.errorReference);
          attempt.response?.close(); attempt.responseEnded = true;
        } else if (payload.action === 'waitOutcome') {
          attempt.waiting = true;
          await attempt.outcome;
          this.current(key, cursor);
          attempt.waiting = false;
          return { ...address, stage: 'outcome' };
        } else if (payload.action === 'outcomeNext') {
          if (!attempt.output) attempt.output = payloadValuePages(await attempt.outcome);
          const next = await attempt.output.next();
          this.current(key, cursor);
          return { ...address, stage: 'values', tokens: next.done ? [] : next.value, done: !!next.done };
        }
      }
      this.current(key, cursor);
      return { ...address, stage: 'ready' };
    } catch (error) { this.close(key); throw error; }
    finally { if (!waiting) cursor.busy = false; }
  }
}
