import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCompleteLines, readCompleteLinesSync, type ReadWindowOpts } from './transcriptWindow.js';

async function fixture(run: (fd: FileHandle, file: string, content: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-window-checkpoint-'));
  const file = path.join(root, 'source');
  const content = '😀'.repeat(9) + '\npartial';
  fs.writeFileSync(file, content);
  const fd = await fs.promises.open(file, 'r');
  try { await run(fd, file, content); }
  finally { await fd.close(); fs.rmSync(root, { recursive: true }); }
}
const outcome = <T>(value: Promise<T>) => value.then(result => ({ result }), error => ({ error }));

test('one-byte actual reads refill each window before geometric growth', async () => {
  await fixture(async (fd, _file, content) => {
    const buffers = new Set<Buffer>();
    const positions: number[] = [];
    const reader = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      buffers.add(buffer);
      positions.push(position);
      return fd.read(buffer, offset, Math.min(length, 1), position);
    } } as unknown as FileHandle;
    const result = await readCompleteLines(reader, 0, Buffer.byteLength(content), { step: 8 });
    expect(result.content).toBe('😀'.repeat(9) + '\n');
    expect(result.bytesConsumed).toBe(37);
    expect(result.steps).toBe(37);
    expect([...buffers].map(buffer => buffer.length)).toEqual([8, 16, 32, 44]);
    expect(positions).toEqual(Array.from({ length: 37 }, (_, i) => i));
  });
});

test('initial refusal occurs before allocation or read and preserves its object', async () => {
  await fixture(async (fd, _file, content) => {
    const refusal = new Error('before allocation');
    const allocate = spyOn(Buffer, 'allocUnsafe');
    const read = spyOn(fd, 'read');
    try {
      const result = await outcome(readCompleteLines(fd, 0, Buffer.byteLength(content), { checkpoint: () => { throw refusal; } }));
      expect('error' in result && result.error).toBe(refusal);
      expect(allocate).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally { allocate.mockRestore(); read.mockRestore(); }
  });
});

test('pre-read refusal never reaches the handle', async () => {
  await fixture(async (fd, _file, content) => {
    const refusal = new Error('before read');
    let checks = 0;
    const read = spyOn(fd, 'read');
    try {
      const result = await outcome(readCompleteLines(fd, 0, Buffer.byteLength(content), { checkpoint: () => { if (++checks === 3) throw refusal; } }));
      expect('error' in result && result.error).toBe(refusal);
      expect(checks).toBe(3);
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
});

test('post-read refusal prevents decode and keeps the awaited error identity', async () => {
  await fixture(async (fd, _file, content) => {
    const refusal = new Error('after read');
    let reads = 0;
    let boundaries = 0;
    const reader = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await fd.read(buffer, offset, length, position);
      reads++;
      return result;
    } } as unknown as FileHandle;
    const result = await outcome(readCompleteLines(reader, 0, Buffer.byteLength(content), {
      checkpoint: () => { if (reads) throw refusal; },
      boundary: () => { boundaries++; return 0; },
    }));
    expect('error' in result && result.error).toBe(refusal);
    expect(reads).toBe(1);
    expect(boundaries).toBe(0);
  });
});

test('boundary cancellation fences growth and decoding', async () => {
  await fixture(async (fd, _file, content) => {
    for (const cut of [-1, 0]) {
      let cancelled = false;
      const refusal = new Error(`boundary ${cut}`);
      const allocate = spyOn(Buffer, 'allocUnsafe');
      try {
        const result = await outcome(readCompleteLines(fd, 0, Buffer.byteLength(content), {
          step: 8,
          checkpoint: () => { if (cancelled) throw refusal; },
          boundary: () => { cancelled = true; return cut; },
        }));
        expect('error' in result && result.error).toBe(refusal);
        expect(allocate).toHaveBeenCalledTimes(1);
      } finally { allocate.mockRestore(); }
    }
  });
});

test('checkpoint is captured once and default reads keep their existing result', async () => {
  await fixture(async (fd, file, content) => {
    const size = Buffer.byteLength(content);
    const expected = await readCompleteLines(fd, 0, size, { step: 8 });
    let gets = 0;
    let checks = 0;
    const opts: ReadWindowOpts = { step: 8, get checkpoint() { gets++; return () => { checks++; }; } };
    const reader = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      Object.defineProperty(opts, 'checkpoint', { value: () => { throw new Error('replacement callback'); }, configurable: true });
      return fd.read(buffer, offset, length, position);
    } } as unknown as FileHandle;
    expect(await readCompleteLines(reader, 0, size, opts)).toEqual(expected);
    expect(gets).toBe(1);
    expect(checks).toBeGreaterThan(1);
    const syncFd = fs.openSync(file, 'r');
    try { expect(readCompleteLinesSync(syncFd, 0, size, { step: 8 })).toEqual(expected); }
    finally { fs.closeSync(syncFd); }
  });
});

test('native read rejection stays exact', async () => {
  const refusal = new Error('native read');
  const reader = { read: async () => { throw refusal; } } as unknown as FileHandle;
  const result = await outcome(readCompleteLines(reader, 0, 8, { checkpoint: () => {} }));
  expect('error' in result && result.error).toBe(refusal);
});

test('synchronous twin refills short reads and fences post-read cancellation', async () => {
  await fixture(async (_fd, file, content) => {
    const syncFd = fs.openSync(file, 'r');
    const nativeRead = fs.readSync as (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
    const buffers = new Set<Buffer>();
    let reads = 0;
    const read = spyOn(fs, 'readSync').mockImplementation((...args: unknown[]) => {
      const [fd, buffer, offset, length, position] = args as [number, Buffer, number, number, number];
      buffers.add(buffer);
      const result = nativeRead(fd, buffer, offset, Math.min(length, 1), position);
      reads++;
      return result;
    });
    try {
      const result = readCompleteLinesSync(syncFd, 0, Buffer.byteLength(content), { step: 8 });
      expect(result.content).toBe('😀'.repeat(9) + '\n');
      expect([...buffers].map(buffer => buffer.length)).toEqual([8, 16, 32, 44]);
      reads = 0;
      const refusal = new Error('sync post-read');
      let caught: unknown;
      try { readCompleteLinesSync(syncFd, 0, Buffer.byteLength(content), { checkpoint: () => { if (reads) throw refusal; } }); }
      catch (error) { caught = error; }
      expect(caught).toBe(refusal);
      expect(reads).toBe(1);
    } finally { read.mockRestore(); fs.closeSync(syncFd); }
  });
});
