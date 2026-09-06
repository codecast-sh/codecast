import { createHash } from 'node:crypto';

export const PAYLOAD_PAGE_BYTES = 65_536;
export const PAYLOAD_MAX_BYTES = 128 * 1024 * 1024;
export type BytePage = { offset: number; data: string };
export type ByteDescriptor = { length: number; sha256: string };
export const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const ownFields = (v: Record<string, any>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
export const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const boundedText = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length <= limit;
export const identity = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(v);
export function validByteDescriptor(v: unknown): v is ByteDescriptor {
  return record(v) && ownFields(v, ['length', 'sha256']) && count(v.length) && v.length <= PAYLOAD_MAX_BYTES && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256);
}
export function validBytePage(v: unknown): v is BytePage {
  return record(v) && ownFields(v, ['offset', 'data']) && count(v.offset) && v.offset <= PAYLOAD_MAX_BYTES && boundedText(v.data, 87_384) && v.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(v.data) && Buffer.from(v.data, 'base64').length <= PAYLOAD_PAGE_BYTES;
}
export function describeBytes(bytes: Buffer): ByteDescriptor {
  if (bytes.length > PAYLOAD_MAX_BYTES) throw new Error('payload byte limit');
  return { length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function bytePage(bytes: Buffer, offset: number): BytePage {
  if (!count(offset) || offset > bytes.length) throw new Error('payload offset');
  return { offset, data: bytes.subarray(offset, offset + PAYLOAD_PAGE_BYTES).toString('base64') };
}
export class ByteReceiver {
  private offset = 0;
  private digest = createHash('sha256');
  private ended = false;
  constructor(private readonly expected?: ByteDescriptor) {}
  get length() { return this.offset; }
  push(page: BytePage): Buffer {
    if (this.ended || !validBytePage(page) || page.offset !== this.offset) throw new Error('payload byte sequence');
    const bytes = Buffer.from(page.data, 'base64');
    if (bytes.toString('base64') !== page.data || !bytes.length || this.offset + bytes.length > (this.expected?.length ?? PAYLOAD_MAX_BYTES)) throw new Error('payload byte integrity');
    this.offset += bytes.length;
    this.digest.update(bytes);
    return bytes;
  }
  finish(expected = this.expected): ByteDescriptor {
    if (this.ended) throw new Error('payload already ended');
    this.ended = true;
    const actual = { length: this.offset, sha256: this.digest.digest('hex') };
    if (expected && (actual.length !== expected.length || actual.sha256 !== expected.sha256)) throw new Error('payload digest mismatch');
    return actual;
  }
}
