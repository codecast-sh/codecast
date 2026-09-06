import { test, expect } from 'bun:test';
import { PreparationCursors } from './preparationCursors.js';
import { ingestTokenPages, IngestAssembler } from './ingestTransport.js';
import { validPreparationPayload, validPreparationPage, PREPARATION_COMPUTE_MS, PREPARATION_LIFETIME_MS } from './preparationTypes.js';
import type { PreparationPayload, PreparationPage } from './preparationTypes.js';
import { beginMessagePreparation, finishPreparationMessage } from '../messagePreparation.js';

async function cursorHarness(value: unknown) {
  const cursors = new PreparationCursors();
  const first = await cursors.request({ action: 'open', generation: 'fixture', origin: 'transcript' }, 'cursor');
  let sequence = first.sequence + 1;
  const request = (command: object) => cursors.request({ ...command, cursor: 'cursor', generation: 'fixture', sequence: sequence++ } as PreparationPayload, 'request');
  for await (const tokens of ingestTokenPages(value)) await request({ action: 'push', tokens });
  await request({ action: 'seal' });
  const read = async (command: object) => {
    const assembler = new IngestAssembler();
    let page: PreparationPage = await request(command);
    for (;;) {
      expect(validPreparationPage(page)).toBe(true);
      assembler.push(page.tokens);
      if (page.done) return assembler.finish();
      page = await request({ action: 'next' });
    }
  };
  return { cursors, request, read };
}

test('bounded pages preserve UTF16, escaped strings, nested tool JSON and exact byte sizing', async () => {
  const raw = [{ uuid: 'id', role: 'assistant', timestamp: 1, content: ('a\n\\"\ud800😀').repeat(2000), toolCalls: [{ id: 't', name: 'x', input: { nested: [{ text: 'ghp_' + 'A'.repeat(36) }], ['__proto__']: 'ordinary' } }] }];
  const h = await cursorHarness(raw);
  try {
    const result = await h.read({ action: 'finish' }) as any;
    const expected = beginMessagePreparation(raw, 'transcript').map(finishPreparationMessage);
    expect(JSON.stringify(result.messages)).toBe(JSON.stringify(expected));
    expect(result.bytes).toEqual(expected.map(m => Buffer.byteLength(JSON.stringify(m))));
  } finally { await h.request({ action: 'close' }); }
  expect(h.cursors.size).toBe(0);
});

test('cursor admission, unfinished input, wrong sequence, fixed lifetime and cleanup are explicit', async () => {
  let now = 0;
  const cursors = new PreparationCursors(() => now);
  await cursors.request({ action: 'open', generation: 'g', origin: 'service' }, 'one');
  await expect(cursors.request({ action: 'open', generation: 'g2', origin: 'service' }, 'two')).rejects.toThrow('busy');
  await expect(cursors.request({ action: 'close', generation: 'g', cursor: 'one', sequence: 9 }, 'bad')).rejects.toThrow('invalid preparation cursor');
  now = PREPARATION_LIFETIME_MS;
  await expect(cursors.request({ action: 'seal', generation: 'g', cursor: 'one', sequence: 1 }, 'expired')).rejects.toThrow('expired');
  expect(cursors.size).toBe(0);
  await cursors.request({ action: 'open', generation: 'next', origin: 'service' }, 'next');
  await expect(cursors.request({ action: 'seal', generation: 'next', cursor: 'next', sequence: 1 }, 'incomplete')).rejects.toThrow('incomplete');
  expect(cursors.size).toBe(0);
});

test('mutable rescue state preserves next8 across retry and rejects unselected URL positions', async () => {
  const h = await cursorHarness([{ uuid: 'images', role: 'assistant', timestamp: 1, content: Array.from({ length: 18 }, (_, i) => `![x](/tmp/${i}.png)`).join(' ') }]);
  const first = await h.read({ action: 'paths', index: 0 }) as string[];
  expect(first).toHaveLength(8);
  await h.request({ action: 'replace', index: 0, urls: first.map((_, i) => [i, `https://fixture.invalid/${i}`]) });
  const second = await h.read({ action: 'paths', index: 0 }) as string[];
  expect(second[0]).toBe('/tmp/8.png');
  await expect(h.request({ action: 'replace', index: 0, urls: [[0, 'x'], [0, 'y']] })).rejects.toThrow('invalid preparation replacements');
  expect(h.cursors.size).toBe(0);
});

test('preparation protocol rejects oversized, unknown and malformed fields', () => {
  const id = { cursor: 'c', generation: 'g', sequence: 0 };
  expect(validPreparationPayload({ ...id, action: 'push', tokens: [['t', 'x'.repeat(8193)]] })).toBe(false);
  expect(validPreparationPayload({ ...id, action: 'push', tokens: Array.from({ length: 129 }, () => ['v', null]) })).toBe(false);
  expect(validPreparationPayload({ ...id, action: 'push', tokens: [['v', Infinity]] })).toBe(false);
  expect(validPreparationPayload({ action: 'open', generation: 'g', origin: 'service', trustMe: true })).toBe(false);
  expect(validPreparationPayload({ ...id, action: 'replace', index: 0, urls: [[8, 'x']] })).toBe(false);
});

test('transfer deadline does not renew per page and image wait has a fixed separate lifetime', async () => {
  let now = 0;
  const cursors = new PreparationCursors(() => now);
  await cursors.request({ action: 'open', generation: 'g', origin: 'service' }, 'first');
  now = PREPARATION_COMPUTE_MS - 10;
  const page = await cursors.request({ action: 'push', generation: 'g', cursor: 'first', sequence: 1, tokens: [['a']] }, 'push');
  expect(page.computeRemainingMs).toBe(10);
  now += 11;
  await expect(cursors.request({ action: 'push', generation: 'g', cursor: 'first', sequence: 2, tokens: [['z']] }, 'late')).rejects.toThrow('expired');
  expect(cursors.size).toBe(0);
  now = 0;
  await cursors.request({ action: 'open', generation: 'g', origin: 'service' }, 'second');
  await cursors.request({ action: 'push', generation: 'g', cursor: 'second', sequence: 1, tokens: [['a'], ['z']] }, 'push');
  await cursors.request({ action: 'seal', generation: 'g', cursor: 'second', sequence: 2 }, 'seal');
  now = PREPARATION_LIFETIME_MS;
  await expect(cursors.request({ action: 'finish', generation: 'g', cursor: 'second', sequence: 3 }, 'late')).rejects.toThrow('expired');
  expect(cursors.size).toBe(0);
});

test('raw images cannot bypass resolution and validated inline representation remains exact', async () => {
  const data = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).toString('base64');
  const raw = [{ uuid: 'image', role: 'assistant', content: 'image', timestamp: 1, images: [{ mediaType: 'image/png', data }] }];
  const unresolved = await cursorHarness(raw);
  await expect(unresolved.read({ action: 'finish' })).rejects.toThrow('images unresolved');
  expect(unresolved.cursors.size).toBe(0);
  const h = await cursorHarness(raw);
  try {
    await h.request({ action: 'images', index: 0 });
    const withWhitespace = [{ mediaType: 'image/png', data: ' \n' + data + '\n', toolUseId: 'tool' }];
    for await (const tokens of ingestTokenPages(withWhitespace)) await h.request({ action: 'push', tokens });
    await h.request({ action: 'seal' });
    const output = await h.read({ action: 'finish' }) as any;
    expect(output.messages[0].images).toEqual([{ media_type: 'image/png', data: withWhitespace[0].data, tool_use_id: 'tool' }]);
  } finally { await h.request({ action: 'close' }); }
  const invalid = await cursorHarness(raw);
  await invalid.request({ action: 'images', index: 0 });
  for await (const tokens of ingestTokenPages([{ mediaType: 'image/png', data: 'not-base64!' }])) await invalid.request({ action: 'push', tokens });
  await expect(invalid.request({ action: 'seal' })).rejects.toThrow('invalid prepared images');
  expect(invalid.cursors.size).toBe(0);
});

test('forgotten ready cursor expires without a followup request and permits reuse', async () => {
  let now = 0;
  const delays: number[] = [];
  const cursors = new PreparationCursors(() => now, {
    set: ((fn: () => void, ms: number) => { delays.push(ms); return setTimeout(fn, 0); }) as typeof setTimeout,
    clear: clearTimeout,
  });
  await cursors.request({ action: 'open', generation: 'g', origin: 'service' }, 'forgotten');
  await cursors.request({ action: 'push', generation: 'g', cursor: 'forgotten', sequence: 1, tokens: [['a'], ['z']] }, 'push');
  await cursors.request({ action: 'seal', generation: 'g', cursor: 'forgotten', sequence: 2 }, 'seal');
  expect(delays.at(-1)).toBe(PREPARATION_LIFETIME_MS);
  now = PREPARATION_LIFETIME_MS;
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(cursors.size).toBe(0);
  await cursors.request({ action: 'open', generation: 'next', origin: 'service' }, 'replacement');
  expect(cursors.size).toBe(1);
  await cursors.request({ action: 'close', generation: 'next', cursor: 'replacement', sequence: 1 }, 'close');
  expect(cursors.size).toBe(0);
});
