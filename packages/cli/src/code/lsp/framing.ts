// LSP base protocol framing: `Content-Length: N\r\n\r\n` followed by N bytes
// of UTF-8 JSON. Language servers write to stdout in whatever chunks the pipe
// delivers, so a header can split anywhere, a multi-byte character can straddle
// two chunks, and one chunk can carry several messages. The reader works on
// bytes and decodes a body only once all of it is in, which handles all three.

const HEADER_END = Buffer.from("\r\n\r\n");
/** A header block is a line or two; anything this long is not LSP. */
const MAX_HEADER_BYTES = 8 * 1024;

export const LSP_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface LspFrameReaderEvents {
  message: (json: string) => void;
  /** A body over the cap. Its bytes are skipped and the stream stays in sync. */
  oversize: (bytes: number) => void;
  /** Bytes that cannot be a header. The stream cannot be resynchronised. */
  error: (reason: string) => void;
}

export class LspFrameReader {
  private head: Buffer = Buffer.alloc(0);
  private body: Buffer[] = [];
  private bodyHave = 0;
  /** Bytes still owed to the current body (or to a skipped oversize one). */
  private need = -1;
  private skipping = false;
  private broken = false;

  constructor(
    private readonly on: LspFrameReaderEvents,
    private readonly maxBytes = LSP_MAX_MESSAGE_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0 && !this.broken) {
      if (this.need < 0) rest = this.readHeader(rest);
      else rest = this.readBody(rest);
    }
  }

  private readHeader(chunk: Buffer): Buffer {
    // Only the unterminated tail of a header is ever buffered, so this concat
    // stays bounded by MAX_HEADER_BYTES.
    const buf = this.head.length ? Buffer.concat([this.head, chunk]) : chunk;
    const end = buf.indexOf(HEADER_END);
    if (end < 0) {
      if (buf.length > MAX_HEADER_BYTES) return this.fail("header too long");
      this.head = Buffer.from(buf);
      return Buffer.alloc(0);
    }
    this.head = Buffer.alloc(0);
    const length = contentLength(buf.subarray(0, end).toString("ascii"));
    if (length === null) return this.fail("missing Content-Length");
    this.need = length;
    this.skipping = length > this.maxBytes;
    if (this.skipping) this.on.oversize(length);
    const rest = buf.subarray(end + HEADER_END.length);
    if (length === 0) this.finishBody();
    return rest;
  }

  private readBody(chunk: Buffer): Buffer {
    const take = Math.min(this.need - this.bodyHave, chunk.length);
    if (!this.skipping) this.body.push(chunk.subarray(0, take));
    this.bodyHave += take;
    if (this.bodyHave === this.need) this.finishBody();
    return chunk.subarray(take);
  }

  private finishBody(): void {
    const parts = this.body;
    const skipped = this.skipping;
    this.body = [];
    this.bodyHave = 0;
    this.need = -1;
    this.skipping = false;
    if (!skipped) this.on.message(Buffer.concat(parts).toString("utf8"));
  }

  private fail(reason: string): Buffer {
    this.broken = true;
    this.head = Buffer.alloc(0);
    this.on.error(reason);
    return Buffer.alloc(0);
  }
}

function contentLength(header: string): number | null {
  for (const line of header.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = line.slice(colon + 1).trim();
    return /^\d+$/.test(value) ? Number(value) : null;
  }
  return null;
}

export function encodeLspFrame(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}
