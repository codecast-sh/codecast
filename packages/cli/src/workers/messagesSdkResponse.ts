import { ByteReceiver, PAYLOAD_PAGE_BYTES, type ByteDescriptor, type BytePage } from './payloadBytes.js';

export class MessagesSdkResponse {
  private receiver = new ByteReceiver();
  private pages: Buffer[] = [];
  private stored = 0;
  private closed = false;
  constructor(private readonly status: number, private readonly body: boolean) {}
  push(page: BytePage) {
    if (this.closed || !this.body) { this.close(); throw new Error('messages SDK response not open'); }
    try {
      const bytes = this.receiver.push(page);
      for (let offset = 0; offset < bytes.length;) {
        const tail = this.stored % PAYLOAD_PAGE_BYTES;
        if (!tail) this.pages.push(Buffer.allocUnsafe(PAYLOAD_PAGE_BYTES));
        const count = Math.min(bytes.length - offset, PAYLOAD_PAGE_BYTES - tail);
        bytes.copy(this.pages[this.pages.length - 1], tail, offset, offset + count);
        offset += count; this.stored += count;
      }
    }
    catch (error) { this.close(); throw error; }
  }
  finish(descriptor: ByteDescriptor, checkpoint: () => void): Response {
    if (this.closed) throw new Error('messages SDK response not open');
    this.closed = true;
    try {
      this.receiver.finish(descriptor);
      checkpoint();
      const bytes = Buffer.concat(this.pages, this.receiver.length);
      checkpoint();
      const response = new Response(bytes.length ? bytes : null, { status: this.status });
      if (!bytes.length && process.versions.bun === '1.3.14') {
        response.json = async () => { await response.text(); return null; };
      }
      checkpoint();
      return response;
    } finally { this.pages = []; }
  }
  close() { this.closed = true; this.pages = []; }
}
