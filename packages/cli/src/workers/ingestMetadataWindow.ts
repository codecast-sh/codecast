import type { FileHandle } from 'node:fs/promises';
import { readCompleteLines } from '../transcriptWindow.js';
import { INGEST_MAX_BYTES } from './ingestTypes.js';

export class MetadataWindowExhausted extends Error {
  constructor(readonly maximumBytes: number) {
    super(`metadata read allowance exhausted (${maximumBytes} bytes)`);
    this.name = 'MetadataWindowExhausted';
  }
}

function checkWindow(size: number, initialBytes: number, maximumBytes: number) {
  if (![size, initialBytes, maximumBytes].every(Number.isSafeInteger) || size < 0 || initialBytes < 1 || maximumBytes < initialBytes || maximumBytes > INGEST_MAX_BYTES) {
    throw new RangeError('invalid metadata read window');
  }
}

export async function readCompleteMetadataHead(
  fd: FileHandle,
  size: number,
  initialBytes: number,
  maximumBytes: number,
  checkpoint: () => void,
): Promise<{ content: string; incomplete: boolean; exhausted: boolean }> {
  checkWindow(size, initialBytes, maximumBytes);
  checkpoint();
  const target = Math.min(size, initialBytes);
  const available = Math.min(size, maximumBytes);
  let incomplete = false;
  let exhausted = false;
  let lastComplete = -1;
  const result = await readCompleteLines(fd, 0, available, {
    step: initialBytes,
    checkpoint,
    boundary: (buffer, length, atEof, from = 0) => {
      checkpoint();
      const bytes = buffer.subarray(0, length);
      const last = buffer.subarray(from,length).lastIndexOf(0x0a);
      if (last >= 0) lastComplete = from + last;
      const cut = bytes.indexOf(0x0a, Math.max(from, target - 1));
      if (cut >= 0) return cut;
      if (!atEof) return -1;
      exhausted = available < size;
      incomplete = !exhausted && length > 0 && bytes[length - 1] !== 0x0a;
      return lastComplete;
    },
  });
  checkpoint();
  return { content: result.content, incomplete, exhausted };
}

export async function* readCompleteMetadataTail(
  fd: FileHandle,
  size: number,
  initialBytes: number,
  maximumBytes: number,
  checkpoint: () => void,
  onIncomplete: () => void,
): AsyncGenerator<string> {
  checkWindow(size, initialBytes, maximumBytes);
  checkpoint();
  if (size === 0) return;
  let extent = Math.min(size, initialBytes);
  let start = size;
  let buffer = Buffer.alloc(0);
  let unexaminedEnd: number | undefined;
  for (;;) {
    checkpoint();
    const nextStart = Math.max(0, size - extent - (extent < size ? 1 : 0));
    const added = start - nextStart;
    const next = Buffer.allocUnsafe(size - nextStart);
    buffer.copy(next, added);
    let read = 0;
    while (read < added) {
      checkpoint();
      const { bytesRead } = await fd.read(next, read, added - read, nextStart + read);
      checkpoint();
      if (bytesRead === 0) throw new Error('metadata source shortened');
      read += bytesRead;
    }
    buffer = next;
    start = nextStart;
    if (extent === Math.min(size, initialBytes) && buffer[buffer.length - 1] !== 0x0a) {
      onIncomplete();
      checkpoint();
    }
    if (unexaminedEnd === undefined) {
      const lastLf = buffer.lastIndexOf(0x0a);
      if (lastLf >= 0) unexaminedEnd = start + lastLf + 1;
    }
    const firstLf = buffer.indexOf(0x0a);
    const completeStart = start === 0 ? 0 : firstLf < 0 ? undefined : start + firstLf + 1;
    if (unexaminedEnd !== undefined && completeStart !== undefined && completeStart < unexaminedEnd) {
      checkpoint();
      const content = buffer.toString('utf8', completeStart - start, unexaminedEnd - start);
      unexaminedEnd = completeStart;
      yield content;
      checkpoint();
    }
    if (start === 0) return;
    if (extent >= maximumBytes) throw new MetadataWindowExhausted(maximumBytes);
    extent = Math.min(size, maximumBytes, extent * 2);
  }
}
