import { test, expect } from 'bun:test';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MetadataWindowExhausted, readCompleteMetadataHead, readCompleteMetadataTail } from './ingestMetadataWindow.js';

const check = () => {};
const limit = 64 * 1024;
const record = (text: string) => JSON.stringify({ type: 'summary', summary: text }) + '\n';

async function fixture<T>(content: string, run: (fd: FileHandle, size: number, file: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-metadata-window-'));
  const file = path.join(root, 'source.jsonl');
  fs.writeFileSync(file, content);
  const fd = await fs.promises.open(file, 'r');
  try { return await run(fd, Buffer.byteLength(content), file); }
  finally { await fd.close(); fs.rmSync(root, { recursive: true }); }
}

async function collect(fd: FileHandle, size: number, initial: number, maximum = limit, checkpoint = check, incomplete = check) {
  const chunks: string[] = [];
  for await (const part of readCompleteMetadataTail(fd, size, initial, maximum, checkpoint, incomplete)) chunks.push(part);
  return chunks;
}

test('metadata head completes the large first native record', async () => {
  const first = record('x'.repeat(20 * 1024));
  await fixture(first + record('later'), async (fd, size) => {
    const result = await readCompleteMetadataHead(fd, size, 16384, limit, check);
    expect(result).toEqual({ content: first, incomplete: false, exhausted: false });
  });
});

test('head exhaustion preserves the previously complete prefix and marks unknown input', async () => {
  const first = record('known parent record');
  await fixture(first + record('x'.repeat(limit + 8)), async (fd, size) => {
    expect(await readCompleteMetadataHead(fd, size, 16384, limit, check)).toEqual({ content: first, incomplete: false, exhausted: true });
  });
  await fixture(record('x'.repeat(limit + 8)), async (fd, size) => {
    expect(await readCompleteMetadataHead(fd, size, 16384, limit, check)).toEqual({ content: '', incomplete: false, exhausted: true });
  });
});

test('tail boundary probe retains the exact initial record and its first-summary order', async () => {
  const first = record('initial first');
  const second = record('initial second');
  await fixture(record('older excluded') + first + second, async (fd, size) => {
    const iterator = readCompleteMetadataTail(fd, size, Buffer.byteLength(first + second), limit, check, check);
    try { expect((await iterator.next()).value).toBe(first + second); }
    finally { await iterator.return(undefined); }
  });
});

test('geometric tail growth emits every complete native record once', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => record(`native-${i}-${'x'.repeat(71)}`));
  await fixture(rows.join(''), async (fd, size) => {
    const chunks = await collect(fd, size, 128);
    const actual = chunks.flatMap(part => part.trimEnd().split('\n'));
    expect(actual.length).toBe(rows.length);
    expect(new Set(actual).size).toBe(rows.length);
    expect(actual.toSorted()).toEqual(rows.map(row => row.trimEnd()).toSorted());
  });
});

test('tail completes a record when the initial cut splits an emoji', async () => {
  const text = record('prefix 😀 suffix');
  const bytes = Buffer.from(text);
  const cut = bytes.indexOf(Buffer.from('😀')) + 2;
  await fixture(text, async (fd, size) => {
    const chunks = await collect(fd, size, size - cut);
    expect(chunks.join('')).toBe(text);
    expect(chunks.join('')).not.toContain('\ufffd');
  });
});

test('incomplete final input stays separate until its LF is appended', async () => {
  const complete = record('previous');
  const unfinished = record('new').slice(0, -1);
  await fixture(complete + unfinished, async (fd, size, file) => {
    let incomplete = 0;
    expect((await collect(fd, size, 4096, limit, check, () => incomplete++)).join('')).toBe(complete);
    expect(incomplete).toBe(1);
    expect(await readCompleteMetadataHead(fd, size, 16384, limit, check)).toEqual({ content: complete, incomplete: true, exhausted: false });
    fs.appendFileSync(file, '\n');
    expect((await collect(fd, size + 1, 4096)).join('')).toBe(complete + unfinished + '\n');
  });
});

test('exact tail cap succeeds and the next byte remains explicit exhaustion', async () => {
  const overhead = Buffer.byteLength(record(''));
  const exact = record('x'.repeat(limit - overhead));
  await fixture(record('outside cap') + exact, async (fd, size) => {
    const iterator = readCompleteMetadataTail(fd, size, 4096, limit, check, check);
    try { expect((await iterator.next()).value).toBe(exact); }
    finally { await iterator.return(undefined); }
  });
  await fixture(record('outside cap') + record('x'.repeat(limit - overhead + 1)), async (fd, size) => {
    const outcome = await collect(fd, size, 4096).then(value => ({ value }), error => ({ error }));
    expect('error' in outcome && outcome.error instanceof MetadataWindowExhausted).toBe(true);
  });
});

test('tail reads only the admitted distinct span and one boundary byte', async () => {
  await fixture('z'.repeat(limit * 2), async (fd, size) => {
    const reads: Array<{ position: number; bytes: number }> = [];
    const reader = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await fd.read(buffer, offset, length, position);
      reads.push({ position, bytes: result.bytesRead });
      return result;
    } } as unknown as FileHandle;
    const outcome = await collect(reader, size, 4096).then(value => ({ value }), error => ({ error }));
    expect('error' in outcome && outcome.error instanceof MetadataWindowExhausted).toBe(true);
    expect(reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(limit + 1);
    const ordered = reads.toSorted((a, b) => a.position - b.position);
    expect(ordered[0].position).toBe(size - limit - 1);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i - 1].position + ordered[i - 1].bytes).toBe(ordered[i].position);
  });
});

test('deadline rejection after an awaited read prevents decode and yield', async () => {
  await fixture(record('must not escape'), async (fd, size) => {
    let reads = 0;
    const refusal = new Error('same pass deadline');
    const reader = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await fd.read(buffer, offset, length, position);
      reads++;
      return result;
    } } as unknown as FileHandle;
    const outcome = await collect(reader, size, 4096, limit, () => { if (reads) throw refusal; }).then(value => ({ value }), error => ({ error }));
    expect('error' in outcome && outcome.error).toBe(refusal);
    expect(reads).toBe(1);
  });
});

test('tail generator resume checks the original deadline before growth or another read', async () => {
  await fixture(record('earlier') + record('initial'), async (fd, size) => {
    let cancelled = false;
    let reads = 0;
    const refusal = new Error('resumed expired operation');
    const reader = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      reads++;
      return fd.read(buffer, offset, length, position);
    } } as unknown as FileHandle;
    const iterator = readCompleteMetadataTail(reader, size, Buffer.byteLength(record('initial')), limit, () => { if (cancelled) throw refusal; }, check);
    expect((await iterator.next()).value).toBe(record('initial'));
    const before = reads;
    cancelled = true;
    const result = await iterator.next().then(value => ({ value }), error => ({ error }));
    expect('error' in result && result.error).toBe(refusal);
    expect(reads).toBe(before);
  });
});
