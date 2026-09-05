import { expect, test } from 'bun:test';
import { validatePreparationInput, validatePreparedOutput } from '../messagePreparationValidation.js';
import { beginMessagePreparation, finishPreparationMessage } from '../messagePreparation.js';
import { PreparationCursors } from './preparationCursors.js';
import { MessagePreparation } from './preparationClient.js';
import type { WorkerHost } from './host.js';
import { IngestAssembler, ingestTokenPages } from './ingestTransport.js';
import { validPreparationPayload, validPreparationPage } from './preparationTypes.js';

const raw = () => ({ uuid: 'id', role: 'assistant', content: 'ordinary', timestamp: 1 });
const stored = () => ({ mediaType: 'image/png', storageId: 'stored', toolUseId: 'tool' });
const wire = () => ({ message_uuid: 'id', role: 'assistant', content: 'ordinary', timestamp: 1 });
const output = (message: unknown) => ({ messages: [message], bytes: [Buffer.byteLength(JSON.stringify(message))] });
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

function harness() {
  const cursors = new PreparationCursors();
  let id = 0;
  const host = {
    state: { closed: false, generation: 1, pid: 1 },
    request: async (operation: string, payload: any) => {
      expect(operation).toBe('prepare');
      expect(validPreparationPayload(payload)).toBe(true);
      const page = await cursors.request(payload, `schema-${++id}`);
      expect(validPreparationPage(page)).toBe(true);
      return page;
    },
  } as unknown as WorkerHost;
  return { cursors, host };
}

const badImages = [
  { mediaType: 12, storageId: 7, toolUseId: false },
  ...['mediaType', 'storageId', 'toolUseId', 'data', 'localPath'].map(key => ({ ...stored(), [key]: {} })),
  { ...stored(), extra: true },
  null,
];

test('L1 rejects every malformed optional or nested input field before preparation', async () => {
  const malformed = [
    ...['uuid', 'messageUuid', 'thinking', 'model', 'subtype', 'stopReason'].map(key => ({ ...raw(), [key]: {} })),
    { ...raw(), role: 1 }, { ...raw(), content: false }, { ...raw(), timestamp: Infinity },
    { ...raw(), extra: 'unknown' },
    ...['toolCalls', 'toolResults', 'images'].map(key => ({ ...raw(), [key]: {} })),
    ...[{ id: 1, name: 'n', input: {} }, { id: 't', name: 2, input: {} }, { id: 't', name: 'n', input: [] }, { id: 't', name: 'n', input: null }, { id: 't', name: 'n', input: { value: () => 1 } }, { id: 't', name: 'n', input: {}, extra: 1 }, null].map(call => ({ ...raw(), toolCalls: [call] })),
    ...[{ toolUseId: 1, content: 'r' }, { toolUseId: 't', content: {} }, { toolUseId: 't', content: 'r', isError: 1 }, { toolUseId: 't', content: 'r', extra: 1 }, null].map(result => ({ ...raw(), toolResults: [result] })),
    ...badImages.map(image => ({ ...raw(), images: [image] })),
  ];
  for (const message of malformed) await expect(validatePreparationInput([message], 'transcript')).rejects.toThrow('preparation schema');
  await expect(validatePreparationInput([{ ...raw(), role: 'user' }], 'service')).rejects.toThrow('preparation schema');
  for (const role of ['human', 'assistant', 'system']) await expect(validatePreparationInput([{ ...raw(), role }], 'service')).resolves.toHaveLength(1);
  const other = [{ ...raw(), role: 'legacy-other' }];
  await validatePreparationInput(other, 'transcript');
  expect(beginMessagePreparation(other, 'transcript')[0].role).toBe('assistant');
});

test('L1 validates initial stored images and later resolved images through the actual cursor/client', async () => {
  const h = harness();
  for (const image of badImages) {
    await expect(MessagePreparation.open([{ ...raw(), images: [image] }] as any, 'transcript', { host: h.host })).rejects.toThrow('preparation schema');
    expect(h.cursors.size).toBe(0);
    const session = await MessagePreparation.open([raw()], 'transcript', { host: h.host });
    await expect(session.setImages(0, [image] as any)).rejects.toThrow('preparation schema');
    expect(h.cursors.size).toBe(0);
  }
  await expect(MessagePreparation.open([{ ...raw(), model: {} }] as any, 'transcript', { host: h.host })).rejects.toThrow('preparation schema');
  expect(h.cursors.size).toBe(0);
  const precedence = { ...stored(), mediaType: 'existing-stored-type', data: 'not base64', localPath: '/not-read' };
  const session = await MessagePreparation.open([{ ...raw(), images: [precedence] }], 'transcript', { host: h.host });
  try {
    expect((await session.finish()).messages[0].images).toEqual([{ media_type: precedence.mediaType, storage_id: precedence.storageId, tool_use_id: 'tool' }]);
    await session.setImages(0, [precedence]);
    expect((await session.finish()).messages[0].images?.[0].storage_id).toBe('stored');
    const data = ` \n${png}\n`;
    await session.setImages(0, [{ mediaType: 'image/png', data, localPath: '', storageId: '', toolUseId: 't' }]);
    expect((await session.finish()).messages[0].images).toEqual([{ media_type: 'image/png', data, tool_use_id: 't' }]);
  } finally { await session.close(); }
  expect(h.cursors.size).toBe(0);
});

test('L2 rejects every malformed wire field and byte count while preserving prepared input strings', async () => {
  const malformed = [
    ...['message_uuid', 'content', 'thinking', 'subtype', 'model'].map(key => ({ ...wire(), [key]: {} })),
    { ...wire(), role: 'human' }, { ...wire(), timestamp: '1' }, { ...wire(), extra: true },
    ...['tool_calls', 'tool_results', 'images'].map(key => ({ ...wire(), [key]: {} })),
    ...[{ id: 1, name: 'n', input: 'json' }, { id: 't', name: false, input: 'json' }, { id: 't', name: 'n', input: {} }, { id: 't', name: 'n', input: 'json', extra: 1 }, null].map(call => ({ ...wire(), tool_calls: [call] })),
    ...[{ tool_use_id: 1, content: 'r' }, { tool_use_id: 't', content: {} }, { tool_use_id: 't', content: 'r', is_error: 1 }, { tool_use_id: 't', content: 'r', extra: 1 }, null].map(result => ({ ...wire(), tool_results: [result] })),
    ...[{ media_type: 12, storage_id: 7, tool_use_id: false }, { media_type: 'image/png', storage_id: {} }, { media_type: 'image/png', data: 1 }, { media_type: 'image/png', data: png, tool_use_id: false }, { media_type: 'image/png', data: png, extra: 1 }, { media_type: 'image/png', data: png, storage_id: 's' }, { media_type: 'image/png' }, null].map(image => ({ ...wire(), images: [image] })),
  ];
  for (const message of malformed) await expect(validatePreparedOutput(output(message), 1)).rejects.toThrow('preparation schema');
  const good = output({ ...wire(), tool_calls: [{ id: 't', name: 'n', input: '{"cut"' }], images: [{ media_type: 'image/png', data: ` ${png} ` }] });
  for (const bytes of [0, -1, 1.5, Infinity, '1', good.bytes[0] - 1, good.bytes[0] + 1]) await expect(validatePreparedOutput({ ...good, bytes: [bytes] }, 1)).rejects.toThrow('preparation schema');
  for (const bad of [{ ...good, extra: 1 }, { ...good, bytes: [] }, { ...good, messages: {} }, { ...good, bytes: {} }]) await expect(validatePreparedOutput(bad, 1)).rejects.toThrow('preparation schema');
  expect(await validatePreparedOutput(good, 1)).toBe(good);
});

test('L2 validates assembled client replies and closes malformed result owners', async () => {
  const h = harness();
  for (const bad of [
    { messages: [{ ...wire(), tool_calls: [{ id: 't', name: 'n', input: {} }], images: [{ media_type: 12, storage_id: 7 }], extra: true }], bytes: [0] },
    { ...output(wire()), bytes: [0] },
  ]) {
    const session = await MessagePreparation.open([raw()], 'transcript', { host: h.host });
    const assembler = new IngestAssembler();
    for await (const tokens of ingestTokenPages(bad)) assembler.push(tokens);
    (session as any).read = async () => assembler.finish();
    await expect(session.finish()).rejects.toThrow('preparation schema');
    expect(h.cursors.size).toBe(0);
  }
});

test('bounded byte verification matches JSON bytes across surrogate cuts, hostile keys and escapes', async () => {
  const input = JSON.parse('{"__proto__":{"constructor":"own"},"toJSON":"ordinary","2":[null,true,1e+30],"1":"\\u0000\\n\\\\\\\""}');
  const messages = [8191, 8192, 8193].map(length => ({ ...raw(), content: 'a'.repeat(length) + '😀\ud800\udc00\udfff\u2028\u2029\n\t\\"', thinking: '\ud800'.repeat(100), toolCalls: [{ id: 't', name: 'n', input }] }));
  await validatePreparationInput(messages, 'transcript');
  const prepared = beginMessagePreparation(messages, 'transcript').map(finishPreparationMessage);
  const expected = { messages: prepared, bytes: prepared.map(msg => Buffer.byteLength(JSON.stringify(msg))) };
  const stringify = JSON.stringify, byteLength = Buffer.byteLength;
  let maxString = 0, maxBytesInput = 0, checks = 0;
  JSON.stringify = ((value: unknown, ...args: any[]) => {
    expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null).toBe(true);
    if (typeof value === 'string') maxString = Math.max(maxString, value.length);
    return (stringify as any)(value, ...args);
  }) as typeof JSON.stringify;
  Buffer.byteLength = ((value: any, encoding?: any) => {
    maxBytesInput = Math.max(maxBytesInput, value.length);
    return byteLength(value, encoding);
  }) as typeof Buffer.byteLength;
  try { expect(await validatePreparedOutput(expected, messages.length, () => { checks++; })).toBe(expected); }
  finally { JSON.stringify = stringify; Buffer.byteLength = byteLength; }
  expect(maxString).toBeLessThanOrEqual(8192);
  expect(maxBytesInput).toBeLessThanOrEqual(8192 * 6 + 2);
  expect(checks).toBeGreaterThan(0);
  expect(Object.hasOwn(input, '__proto__')).toBe(true);
  const h = harness();
  const session = await MessagePreparation.open(messages, 'transcript', { host: h.host });
  try { expect(await session.finish()).toEqual(expected); }
  finally { await session.close(); }
});

test('schema/count walks checkpoint within a many-tool message and preserve all valid image selection', async () => {
  const row = { ...wire(), tool_calls: Array.from({ length: 256 }, (_, i) => ({ id: String(i), name: 'n', input: '{"cut"' })) };
  let checks = 0;
  await expect(validatePreparedOutput(output(row), 1, () => { if (++checks === 2) throw new Error('fixture expired'); })).rejects.toThrow('fixture expired');
  expect(checks).toBe(2);
  const h = harness();
  const session = await MessagePreparation.open([{ ...raw(), role: 'human', messageUuid: 'service-id', images: Array.from({ length: 11 }, stored) }], 'service', { host: h.host });
  try {
    const result = await session.finish();
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].message_uuid).toBe('service-id');
    expect(result.messages[0].images).toHaveLength(10);
  } finally { await session.close(); }
});
