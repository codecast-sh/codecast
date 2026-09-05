import { MAX_INFLIGHT } from './protocol.js';
import { ingestTokenPages } from './ingestTransport.js';
import { readIngestJob } from './ingestJobs.js';
import type { IngestPayload, IngestPage, IngestToken } from './ingestTypes.js';
type Cursor = { generation: string; sequence: number; iterator: AsyncGenerator<IngestToken[]>; busy: boolean; timer?: ReturnType<typeof setTimeout> };
export class IngestCursors {
  private cursors = new Map<string, Cursor>();
  get size() { return this.cursors.size; }
  async request(payload: IngestPayload, id: string): Promise<IngestPage> {
    const key = payload.action === 'open' ? id : payload.cursor;
    if (payload.action === 'open') {
      if (this.cursors.size >= MAX_INFLIGHT || this.cursors.has(key)) throw new Error('ingest cursors busy');
      const job = payload.job;
      async function* pages() { yield* ingestTokenPages(await readIngestJob(job)); }
      this.cursors.set(key,{generation:payload.job.generation,sequence:0,iterator:pages(),busy:false});
    }
    const cursor = this.cursors.get(key);
    if (!cursor || cursor.busy || payload.action !== 'open' && (payload.generation !== cursor.generation || payload.sequence !== cursor.sequence)) throw new Error('invalid ingest cursor');
    if (cursor.timer) clearTimeout(cursor.timer);
    cursor.busy = true;
    try {
      const result = payload.action === 'close' ? await cursor.iterator.return(undefined) : await cursor.iterator.next();
      if (result.done) this.cursors.delete(key);
      else cursor.timer = setTimeout(() => { this.cursors.delete(key); void cursor.iterator.return(undefined); },30_000);
      return {cursor:key,generation:cursor.generation,sequence:cursor.sequence++,tokens:result.done ? [] : result.value,done:!!result.done};
    } catch (error) {
      this.cursors.delete(key);
      await cursor.iterator.return(undefined);
      throw error;
    } finally { cursor.busy = false; }
  }
}
