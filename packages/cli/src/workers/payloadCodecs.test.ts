import { PayloadBudget } from './payloadBudget.js';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ByteReceiver, bytePage, describeBytes, validBytePage, PAYLOAD_PAGE_BYTES } from './payloadBytes.js';
import { PayloadValueAssembler, payloadValuePages } from './payloadValues.js';
import { transformImageCache } from '../imageCacheCodec.js';
import { decodeImageBase64, detectImageMediaType } from '../imagePayload.js';
import { imageFilePages } from '../imageFilePages.js';
import { PayloadCodecCursors } from './payloadCodecCursors.js';
import { runPayloadCodec, payloadStringBytes } from './payloadCodecClient.js';
import { validPayloadCodecPage, validPayloadCodecPayload } from './payloadCodecTypes.js';
import type { WorkerHost } from './host.js';

test('payload budget never renews across pages or backwards clocks', () => {
  let mono = 10;
  const budget = new PayloadBudget(100, undefined, () => mono);
  mono = 50; expect(budget.remainingMs()).toBe(60);
  mono = 20; expect(budget.remainingMs()).toBe(60);
  const wall = Date.now;
  try {
    Date.now = () => -1_000_000; expect(budget.remainingMs()).toBe(60);
    Date.now = () => 1_000_000; expect(budget.remainingMs()).toBe(60);
  } finally { Date.now = wall; }
  mono = 110; expect(() => budget.checkpoint()).toThrow('expired');
  mono = 0; expect(budget.remainingMs()).toBe(0);
});

test('bounded byte pages reject corruption, missing bytes and replay', () => {
  const bytes = Buffer.alloc(PAYLOAD_PAGE_BYTES + 3, 0xf9), descriptor = describeBytes(bytes);
  const receiver = new ByteReceiver(descriptor);
  receiver.push(bytePage(bytes, 0)); receiver.push(bytePage(bytes, PAYLOAD_PAGE_BYTES));
  expect(receiver.finish()).toEqual(descriptor);
  expect(() => receiver.finish()).toThrow();
  expect(() => new ByteReceiver(descriptor).finish()).toThrow('digest');
  expect(() => new ByteReceiver().push({ offset: 1, data: 'AA==' })).toThrow('sequence');
  expect(() => new ByteReceiver().push({ offset: 0, data: 'AB==' })).toThrow('integrity');
  expect(validBytePage({ offset: 0, data: 'a'.repeat(87388) })).toBe(false);
  expect(() => new ByteReceiver().push({ offset: 0, data: '' })).toThrow('integrity');
});

test('typed IPC preserves Unicode, own hostile keys and SDK values without whole-object serialization', async () => {
  const value = { text: 'x'.repeat(8191) + '\ud83d\ude00\ud800\udc00', values: [1n, -(2n ** 63n), NaN, Infinity, -Infinity, -0, undefined, new Uint8Array([0, 255]).buffer], nested: JSON.parse('{"__proto__":{"value":1},"constructor":2,"toJSON":"data"}') };
  const assembler = new PayloadValueAssembler();
  for await (const page of payloadValuePages(value)) assembler.push(page);
  expect(assembler.finish()).toEqual(value);
  const invalid = new PayloadValueAssembler();
  expect(() => invalid.push([['bytes', 3], ['b', 'AQI='], ['e']])).toThrow('incomplete');
  const replay = new PayloadValueAssembler();
  expect(() => replay.push([['v', null], ['v', null]])).toThrow('multiple');
});

test('image codec preserves sniff and base64 validation including original whitespace', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  expect(detectImageMediaType(png)).toBe('image/png');
  expect(decodeImageBase64(' \n' + png.toString('base64') + '\t')?.data).toEqual(png);
  for (const input of ['', 'a', 'AB==', 'not base64', 'AAAA']) expect(decodeImageBase64(input)).toBeNull();
});

test('cache codec retains map shape, pruning, deleted-path lookup and malformed JSON preimage default', () => {
  const initial = Buffer.from('{bad');
  const stored = transformImageCache(initial, { action: 'store', hash: 'h', absPath: '/deleted', storageId: 's', url: 'u', at: 1 }) as Buffer;
  expect(transformImageCache(stored, { action: 'hash', key: 'h' })).toEqual({ storageId: 's', url: 'u', at: 1 });
  expect(transformImageCache(stored, { action: 'path', key: '/deleted' })).toEqual({ storageId: 's', url: 'u', at: 1 });
  const entries = Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['h' + i, { storageId: 's', url: 'u', at: i }]));
  const pruned = JSON.parse((transformImageCache(Buffer.from(JSON.stringify({ byHash: entries, byPath: {} })), { action: 'store', hash: 'new', storageId: 'new', url: 'new', at: 501 }) as Buffer).toString());
  expect(Object.keys(pruned.byHash)).toHaveLength(500); expect(pruned.byHash.h0).toBeUndefined(); expect(pruned.byHash.new.at).toBe(501);
});

test('actual codec client/cursor drains bounded pages and releases failure admission', async () => {
  const cursors = new PayloadCodecCursors(); let id = 0;
  const host = { state: { pid: 1, generation: 1, closed: false }, request: async (operation: string, payload: any) => {
    expect(operation).toBe('payloadCodec'); expect(validPayloadCodecPayload(payload)).toBe(true);
    const page = await cursors.request(payload, 'codec-' + ++id); expect(validPayloadCodecPage(page)).toBe(true); return page;
  } } as unknown as WorkerHost;
  const data = Buffer.from('89504e470d0a1a0a', 'hex');
  const result = await runPayloadCodec({ kind: 'image', encoding: 'base64', output: 'facts' }, payloadStringBytes(data.toString('base64')), { host, budget: new PayloadBudget(5000) });
  expect(result.value).toEqual({ mediaType: 'image/png', length: 8, hash: createHash('sha256').update(data).digest('hex') });
  expect(cursors.size).toBe(0);
  await expect(runPayloadCodec({ kind: 'cache', operation: { action: 'store', hash: 'h', storageId: 's', url: 'u', at: 1 } }, payloadStringBytes('{}'), { host, budget: new PayloadBudget(5000), write: async () => { throw new Error('owned sink failure'); } })).rejects.toThrow('owned sink failure');
  expect(cursors.size).toBe(0);
  expect((await runPayloadCodec({ kind: 'cache', operation: { action: 'hash', key: 'none' } }, payloadStringBytes('{}'), { host, budget: new PayloadBudget(5000) })).value).toBeNull();
});

test('bounded regular image reads refuse replacement, oversized files and cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preparation-image-'));
  try {
    const file = join(dir, 'image'), newer = join(dir, 'replacement');
    await writeFile(file, Buffer.alloc(70_000, 1));
    let length = 0;
    for await (const page of imageFilePages(file, { budget: new PayloadBudget(5000) })) { expect(page.length).toBeLessThanOrEqual(PAYLOAD_PAGE_BYTES); length += page.length; }
    expect(length).toBe(70_000);
    const reading = imageFilePages(file, { budget: new PayloadBudget(5000) });
    await reading.next(); await writeFile(newer, Buffer.alloc(70_000, 2)); await rename(newer, file);
    await expect((async () => { for await (const _ of reading) {} })()).rejects.toThrow('changed');
    await writeFile(file, Buffer.alloc(5_000_001));
    await expect(imageFilePages(file, { budget: new PayloadBudget(5000) }).next()).rejects.toThrow('at most');
    await expect(imageFilePages(file, { budget: new PayloadBudget(5000), signal: AbortSignal.abort() }).next()).rejects.toThrow('cancelled');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
