import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerHost } from './host.js';
import { MessagePreparation } from './preparationClient.js';
import { ingestIdentity } from './ingestJobs.js';

const raw = [{ uuid: 'fixture', role: 'assistant', content: 'ordinary fixture', timestamp: 1 }];
const worker = path.resolve(import.meta.dir, 'preparationFixture.ts');
const deadlines = new WeakMap<WorkerHost, ReturnType<typeof setTimeout>>();
const makeHost = (delay = 0) => {
  const host = new WorkerHost('ingest', { invocation: { command: process.execPath, args: [worker, '_worker', 'ingest'] }, env: { ...process.env, PREPARATION_REPLY_DELAY_MS: String(delay) }, backoffMs: [0,0,0] });
  deadlines.set(host, setTimeout(() => host.close(), 10_000));
  return host;
};
const dispose = (host: WorkerHost) => { clearTimeout(deadlines.get(host)); deadlines.delete(host); host.close(); };

test('worker unavailable never runs main preparation, and pre-cancel never launches a child', async () => {
  await expect(MessagePreparation.open(raw, 'transcript')).rejects.toThrow('unavailable');
  const host = makeHost(), controller = new AbortController();
  controller.abort();
  try {
    await expect(MessagePreparation.open(raw, 'transcript', { host, signal: controller.signal })).rejects.toThrow();
    expect(host.state.pid).toBeNull();
  } finally { dispose(host); }
});

test('cancel during open terminates the owned child and releases admission for a replacement', async () => {
  const host = makeHost(100), controller = new AbortController();
  const opened = MessagePreparation.open(raw, 'transcript', { host, signal: controller.signal });
  const pid = host.state.pid;
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await expect(opened).rejects.toThrow();
    expect(host.state.pending).toBe(0);
    const replacement = await MessagePreparation.open(raw, 'transcript', { host });
    expect(host.state.pid).not.toBe(pid);
    expect((await replacement.finish()).messages[0].message_uuid).toBe('fixture');
    await replacement.close();
  } finally { clearTimeout(timer); dispose(host); }
}, 15_000);

test('child death rejects a retained cursor and a replacement can prepare the same raw message', async () => {
  const host = makeHost();
  try {
    const first = await MessagePreparation.open(raw, 'transcript', { host });
    const oldPid = host.state.pid!;
    process.kill(oldPid, 'SIGKILL');
    const deadline = performance.now() + 5000;
    while (host.state.pid === oldPid && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(host.state.pid).toBeNull();
    await expect(first.finish()).rejects.toThrow('no longer available');
    const replacement = await MessagePreparation.open(raw, 'transcript', { host });
    expect((await replacement.finish()).messages[0].content).toBe(raw[0].content);
    await replacement.close();
  } finally { dispose(host); }
}, 15_000);

test('four retained ingest results and one preparation have separate predictable admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preparation-pressure-'));
  const host = makeHost();
  try {
    const file = path.join(root, 'fixture.jsonl');
    await writeFile(file, JSON.stringify({ type: 'assistant', uuid: 'ingest', timestamp: '2026-09-05T12:00:00Z', message: { role: 'assistant', content: 'fixture' } }) + '\n');
    const identity = ingestIdentity(await stat(file));
    const pages: any[] = [];
    for (let i = 0; i < 4; i++) pages.push(await host.request('ingest', { action: 'open', job: { client: 'claude', file, sessionId: 'fixture', generation: `ingest-${i}`, identity, offset: 0 } }));
    await expect(host.request('ingest', { action: 'open', job: { client: 'claude', file, sessionId: 'fixture', generation: 'ingest-overflow', identity, offset: 0 } })).rejects.toThrow();
    const prep = await MessagePreparation.open(raw, 'transcript', { host });
    await expect(MessagePreparation.open(raw, 'transcript', { host })).rejects.toThrow('unavailable');
    expect((await prep.finish()).messages[0].content).toBe(raw[0].content);
    await prep.close();
    for (const p of pages) await host.request('ingest', { action: 'close', cursor: p.cursor, generation: p.generation, sequence: p.sequence + 1 });
    expect(await host.request('ping', null)).toBe('pong');
  } finally { dispose(host); await rm(root, { recursive: true, force: true }); }
}, 20_000);

test('worker deadline rejects without fallback and permits a fresh owned child', async () => {
  const host = makeHost(100);
  try {
    await expect(host.request('prepare', { action: 'open', generation: 'deadline', origin: 'transcript' }, { timeoutMs: 20 })).rejects.toThrow('deadline');
    expect(host.state.pending).toBe(0);
    expect(host.state.pid).toBeNull();
    const replacement = await MessagePreparation.open(raw, 'transcript', { host });
    expect((await replacement.finish()).messages[0].content).toBe(raw[0].content);
    await replacement.close();
  } finally { dispose(host); }
}, 15_000);

test('surviving image cursor advances next8; child loss replays the unread first attempt', async () => {
  const host = makeHost();
  const content = Array.from({ length: 18 }, (_, i) => `![${i}](/tmp/preparation-${i}.png)`).join(' ') + 'x'.repeat(100_001);
  const original = [{ ...raw[0], content }];
  const applyAttempt = async (prep: MessagePreparation) => {
    const paths = await prep.paths(0);
    await prep.replaceLinks(0, paths.map((p, i) => [i, 'https://fixture.invalid/' + p.split('/').at(-1)]));
    return { paths, output: await prep.finish() };
  };
  try {
    const first = await MessagePreparation.open(original, 'transcript', { host });
    const attemptOne = await applyAttempt(first);
    const attemptTwo = await applyAttempt(first);
    expect(attemptOne.paths).toHaveLength(8);
    expect(attemptTwo.paths[0]).toBe('/tmp/preparation-8.png');
    expect(attemptTwo.output).not.toEqual(attemptOne.output);
    const oldPid = host.state.pid!;
    process.kill(oldPid, 'SIGKILL');
    const deadline = performance.now() + 5000;
    while (host.state.pid === oldPid && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    await expect(first.finish()).rejects.toThrow();
    const restarted = await MessagePreparation.open(original, 'transcript', { host });
    const replay = await applyAttempt(restarted);
    expect(replay).toEqual(attemptOne);
    expect(original[0].content).toBe(content);
    await restarted.close();
  } finally { dispose(host); }
}, 15_000);
