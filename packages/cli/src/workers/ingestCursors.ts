import { MAX_INFLIGHT } from './protocol.js';
import { ingestTokenPages } from './ingestTransport.js';
import { readIngestJob } from './ingestJobs.js';
import { IngestDeadline } from './ingestDeadline.js';
import type { IngestPayload, IngestPage, IngestToken } from './ingestTypes.js';
type Cursor = { generation: string; sequence: number; iterator: AsyncGenerator<IngestToken[]>; busy: boolean; closing: boolean; deadline: IngestDeadline; timer?: ReturnType<typeof setTimeout> };
export class IngestCursors {
  private cursors = new Map<string, Cursor>();
  get size() { return this.cursors.size; }
  private async close(key: string, cursor: Cursor): Promise<void> {
    if (cursor.closing) return;
    cursor.closing = true;
    if (cursor.timer) clearTimeout(cursor.timer);
    cursor.deadline.dispose();
    try { await cursor.iterator.return(undefined); }
    finally { if (this.cursors.get(key) === cursor) this.cursors.delete(key); }
  }
  async request(payload: IngestPayload, id: string): Promise<IngestPage> {
    const key = payload.action === 'open' ? id : payload.cursor;
    if (payload.action === 'open') {
      if (this.cursors.size >= MAX_INFLIGHT || this.cursors.has(key)) throw new Error('ingest cursors busy');
      const job = payload.job;
      const deadline = new IngestDeadline();
      async function* pages() { yield* ingestTokenPages(await readIngestJob(job,() => deadline.check())); }
      const cursor: Cursor = {generation:payload.job.generation,sequence:0,iterator:pages(),busy:false,closing:false,deadline};
      deadline.signal.addEventListener('abort',() => {
        if (!cursor.busy) void this.close(key,cursor).catch(error => process.stderr.write(`ingest cursor cleanup: ${String(error).slice(0,256)}\n`));
      },{once:true});
      this.cursors.set(key,cursor);
    }
    const cursor = this.cursors.get(key);
    if (!cursor || cursor.busy || cursor.closing || payload.action !== 'open' && (payload.generation !== cursor.generation || payload.sequence !== cursor.sequence)) throw new Error('invalid ingest cursor');
    if (cursor.timer) clearTimeout(cursor.timer);
    cursor.busy = true;
    try {
      if (payload.action !== 'close') cursor.deadline.check();
      const result = payload.action === 'close' ? await cursor.iterator.return(undefined) : await cursor.iterator.next();
      if (payload.action !== 'close') cursor.deadline.check();
      if (result.done) { this.cursors.delete(key); cursor.deadline.dispose(); }
      else cursor.timer = setTimeout(() => { void this.close(key,cursor).catch(error => process.stderr.write(`ingest cursor cleanup: ${String(error).slice(0,256)}\n`)); },30_000);
      return {cursor:key,generation:cursor.generation,sequence:cursor.sequence++,tokens:result.done ? [] : result.value,done:!!result.done};
    } catch (error) {
      await this.close(key,cursor);
      throw error;
    } finally { cursor.busy = false; }
  }
}
