import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SyncService } from './syncService.js';
import { functionBlock } from './test-helpers/sourceRegion.js';
import { redactSecrets } from './redact.js';
import { beginMessagePreparation, finishPreparationMessage, preparationImagePaths, replacePreparationImageLinks } from './messagePreparation.js';

test('preparation matches actual daemon and SyncService content, thinking, tool and UTF16 contracts', async () => {
  const source = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8');
  const bodies = ['mapRole','prepMessageForSync'].map(name => functionBlock(source, name).text).join('\n');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(bodies);
  const prepare = new Function('redactSecrets', code + '\nreturn prepMessageForSync;')(redactSecrets);
  const token = 'ghp_' + 'A'.repeat(36);
  const contents = [
    'ordinary text', '',
    'x'.repeat(99990) + '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(40000) + '\n-----END PRIVATE KEY-----tail',
    'x'.repeat(49990) + ' API_KEY=' + 'a'.repeat(10000) + '1',
    'x'.repeat(8190) + ' ' + token,
    '😀'.repeat(49999) + 'x😀tail',
  ];
  const raw = contents.map((content, index) => ({ uuid: String(index), role: 'user', content, thinking: content, timestamp: index, toolCalls: [{ id: 'tool', name: 'read', input: { text: content, [token]: 1, ['ghp_' + 'B'.repeat(36)]: 2 } }], toolResults: [{ toolUseId: 'tool', content, isError: false }] }));
  const original = JSON.stringify(raw);
  const service = new SyncService({ convexUrl: 'http://localhost:0', authToken: 'fixture' });
  const sent: unknown[] = [];
  (service as any).mutate = async (_name: string, args: any) => { sent.push(...args.messages); return { inserted: args.messages.length, ids: args.messages.map((m: any) => m.message_uuid) }; };
  await service.addMessages({ conversationId: 'fixture', messages: raw.map(prepare) });
  const actual = beginMessagePreparation(raw, 'transcript').map(finishPreparationMessage);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(sent));
  expect(JSON.stringify(raw)).toBe(original);
});

test('image rescue preserves full-content first8 and subsequent next8 selection', () => {
  const links = Array.from({ length: 18 }, (_, i) => `![${i}](/tmp/image-${i}.png)`);
  const msg = { role: 'assistant', content: links[0] + 'x'.repeat(100_001) + links.slice(1).join(' ') + links[0], timestamp: 1 };
  const first = preparationImagePaths(msg);
  expect(first).toEqual(Array.from({ length: 8 }, (_, i) => `/tmp/image-${i}.png`));
  replacePreparationImageLinks(msg, new Map(first.map((p, i) => [p, `https://fixture.invalid/${i}`])));
  expect(msg.content.match(/https:\/\/fixture.invalid\/0/g)?.length).toBe(2);
  expect(preparationImagePaths(msg)).toEqual(Array.from({ length: 8 }, (_, i) => `/tmp/image-${i + 8}.png`));
  const prefix = finishPreparationMessage(msg).content;
  replacePreparationImageLinks(msg, new Map(preparationImagePaths(msg).map(p => [p, 'https://fixture.invalid/next'])));
  expect(finishPreparationMessage(msg).content).not.toBe(prefix);
  expect(preparationImagePaths({ ...msg, role: 'human' })).toEqual([]);
});
