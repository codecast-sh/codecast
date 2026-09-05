import { PayloadBudget } from './payloadBudget.js';
import { randomUUID } from 'node:crypto';
import { WorkerHost, WorkerUnavailable } from './host.js';
import { ByteReceiver, PAYLOAD_PAGE_BYTES, type ByteDescriptor } from './payloadBytes.js';
import { PayloadValueAssembler } from './payloadValues.js';
import { validPayloadCodecPage, validPayloadCodecPayload, type PayloadCodecJob, type PayloadCodecPayload, type PayloadCodecPage } from './payloadCodecTypes.js';

type Command = PayloadCodecPayload extends infer P ? P extends PayloadCodecPayload ? Omit<P, 'cursor' | 'generation' | 'sequence'> : never : never;
const occupied = new WeakSet<WorkerHost>();

export async function runPayloadCodec(job: PayloadCodecJob, input: AsyncIterable<Uint8Array>, options: { host: WorkerHost; budget: PayloadBudget; signal?: AbortSignal; write?: (page: Buffer) => Promise<void> }): Promise<{ value?: unknown; descriptor?: ByteDescriptor }> {
  const { host, budget } = options;
  const signal = options.signal ?? budget.signal;
  if (occupied.has(host) || budget.remainingMs() <= 0) throw new WorkerUnavailable('payload codec unavailable');
  occupied.add(host);
  const cancellation = new AbortController(), generation = randomUUID();
  let cursor = '', sequence = 0, hostGeneration = 0;
  const abort = () => cancellation.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => cancellation.abort(new WorkerUnavailable('payload codec deadline')), Math.max(1, budget.remainingMs())); timer.unref();
  const current = () => {
    if (cancellation.signal.aborted || host.state.closed || hostGeneration && hostGeneration !== host.state.generation || budget.remainingMs() <= 0) throw new WorkerUnavailable('payload codec expired');
  };
  const request = async (command: Command): Promise<PayloadCodecPage> => {
    current();
    const expected = sequence++;
    const payload = command.action === 'open' ? { ...command, generation } : { ...command, cursor, generation, sequence: expected };
    if (!validPayloadCodecPayload(payload)) throw new WorkerUnavailable('invalid codec command');
    const result = await host.request('payloadCodec', payload, { timeoutMs: Math.max(1, Math.ceil(Math.min(60_000, budget.remainingMs()))), signal: cancellation.signal });
    if (!validPayloadCodecPage(result) || result.sequence !== expected || result.generation !== generation || cursor && result.cursor !== cursor) throw new WorkerUnavailable('invalid codec reply');
    if (!cursor) { cursor = result.cursor; hostGeneration = host.state.generation; }
    current(); await new Promise<void>(resolve => setImmediate(resolve)); return result;
  };
  try {
    await request({ action: 'open', job, budgetMs: budget.remainingMs() });
    const sent = new ByteReceiver();
    for await (const chunk of input) {
      current();
      for (let offset = 0; offset < chunk.length; offset += PAYLOAD_PAGE_BYTES) {
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset + offset, Math.min(PAYLOAD_PAGE_BYTES, chunk.length - offset));
        const page = { offset: sent.length, data: bytes.toString('base64') };
        sent.push(page); await request({ action: 'push', page });
      }
    }
    const sealed = await request({ action: 'seal', descriptor: sent.finish() });
    if (sealed.stage === 'descriptor') {
      if (!options.write) throw new WorkerUnavailable('payload codec byte sink required');
      const received = new ByteReceiver(sealed.descriptor);
      for (;;) {
        const page = await request({ action: 'next' });
        if (page.stage !== 'bytes') throw new WorkerUnavailable('invalid codec bytes');
        if (!page.page.data && (!page.done || page.page.offset !== 0 || sealed.descriptor.length !== 0)) throw new WorkerUnavailable('empty codec byte page');
        const bytes = page.page.data ? received.push(page.page) : Buffer.alloc(0);
        if (page.done) received.finish();
        if (bytes.length) { await options.write(bytes); current(); }
        if (page.done) return { descriptor: sealed.descriptor };
      }
    }
    if (sealed.stage !== 'ready') throw new WorkerUnavailable('invalid codec seal');
    const assembler = new PayloadValueAssembler();
    for (;;) {
      const page = await request({ action: 'next' });
      if (page.stage !== 'values') throw new WorkerUnavailable('invalid codec value');
      assembler.push(page.tokens);
      if (page.done) return { value: assembler.finish() };
    }
  } finally {
    cancellation.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
    try {
      if (cursor && host.state.pid !== null && !host.state.closed && host.state.generation === hostGeneration) await host.request('payloadCodec', { action: 'close', cursor, generation, sequence: sequence++ }, { timeoutMs: 1000 });
    } catch {} finally { occupied.delete(host); }
  }
}

export async function* payloadStringBytes(value: string): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 8192, value.length);
    const previous = value.charCodeAt(end - 1), next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    yield Buffer.from(value.slice(offset, end)); offset = end;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
