import { PayloadBudget } from './payloadBudget.js';
import { decodeImageBase64, detectImageMediaType, hashImageBytes } from '../imagePayload.js';
import { transformImageCache } from '../imageCacheCodec.js';
import { ByteReceiver, bytePage, describeBytes } from './payloadBytes.js';
import { payloadValuePages, type PayloadToken } from './payloadValues.js';
import type { PayloadCodecJob, PayloadCodecPage, PayloadCodecPayload } from './payloadCodecTypes.js';

type Cursor = { generation: string; sequence: number; job: PayloadCodecJob; budget: PayloadBudget; timer: ReturnType<typeof setTimeout>; receiver: ByteReceiver; input?: Buffer[]; bytes?: Buffer; offset: number; values?: AsyncGenerator<PayloadToken[]>; busy: boolean };
export class PayloadCodecCursors {
  private cursors = new Map<string, Cursor>();
  get size() { return this.cursors.size; }
  private close(key: string) {
    const cursor = this.cursors.get(key);
    if (!cursor) return;
    this.cursors.delete(key); clearTimeout(cursor.timer); void cursor.values?.return(undefined);
  }
  async request(payload: PayloadCodecPayload, id: string): Promise<PayloadCodecPage> {
    const key = payload.action === 'open' ? id : payload.cursor;
    if (payload.action === 'open') {
      if (this.cursors.size || payload.budgetMs <= 0 || payload.budgetMs > 60_000) throw new Error('payload codec unavailable');
      const timer = setTimeout(() => this.close(key), payload.budgetMs); timer.unref();
      this.cursors.set(key, { generation: payload.generation, sequence: 0, job: payload.job, budget: new PayloadBudget(payload.budgetMs), timer, receiver: new ByteReceiver(), input: [], offset: 0, busy: false });
    }
    const cursor = this.cursors.get(key);
    if (!cursor || cursor.busy || cursor.generation !== payload.generation || payload.action !== 'open' && cursor.sequence !== payload.sequence) throw new Error('payload codec identity');
    const address = { cursor: key, generation: cursor.generation, sequence: cursor.sequence++ };
    cursor.busy = true;
    try {
      if (cursor.budget.remainingMs() <= 0) throw new Error('payload codec expired');
      if (payload.action === 'close') { this.close(key); return { ...address, stage: 'ready' }; }
      if (payload.action === 'push') {
        if (!cursor.input) throw new Error('payload codec already sealed');
        cursor.input.push(cursor.receiver.push(payload.page));
      } else if (payload.action === 'seal') {
        if (!cursor.input) throw new Error('payload codec already sealed');
        cursor.receiver.finish(payload.descriptor);
        const input = Buffer.concat(cursor.input, cursor.receiver.length); cursor.input = undefined;
        let result: unknown;
        const job = cursor.job;
        if (job.kind === 'cache') result = transformImageCache(input, job.operation);
        else {
          const image = job.encoding === 'base64' ? decodeImageBase64(input.toString('utf8')) : { data: input, mediaType: detectImageMediaType(input) };
          if (!image?.mediaType) result = null;
          else if (job.output === 'facts') result = { mediaType: image.mediaType, length: image.data.length, hash: hashImageBytes(image.data) };
          else if (job.output === 'bytes') {
            if (image.data.length > 5_000_000) throw new Error('image byte limit');
            result = image.data;
          } else result = Buffer.from(image.data.toString('base64'));
        }
        if (cursor.budget.remainingMs() <= 0) throw new Error('payload codec expired');
        if (Buffer.isBuffer(result)) { cursor.bytes = result; return { ...address, stage: 'descriptor', descriptor: describeBytes(result) }; }
        cursor.values = payloadValuePages(result);
      } else if (payload.action === 'next') {
        if (cursor.bytes) {
          const page = bytePage(cursor.bytes, cursor.offset);
          cursor.offset += Buffer.from(page.data, 'base64').length;
          return { ...address, stage: 'bytes', page, done: cursor.offset === cursor.bytes.length };
        }
        if (!cursor.values) throw new Error('payload codec output missing');
        const next = await cursor.values.next();
        if (this.cursors.get(key) !== cursor || cursor.budget.remainingMs() <= 0) throw new Error('payload codec expired');
        return { ...address, stage: 'values', tokens: next.done ? [] : next.value, done: !!next.done };
      }
      return { ...address, stage: 'ready' };
    } catch (error) { this.close(key); throw error; }
    finally { cursor.busy = false; }
  }
}
