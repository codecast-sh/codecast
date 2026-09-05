import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WorkerHost } from './host.js';
import { MessagePreparation } from './preparationClient.js';
import { ingestIdentity } from './ingestJobs.js';

const raw = [{ uuid: 'fixture', role: 'assistant', content: 'ordinary fixture', timestamp: 1 }];
const worker = path.join(import.meta.dir, 'preparationFixture.ts');
const makeHost = (delay = 0) => new WorkerHost('ingest', {
  invocation: { command: process.execPath, args: [worker, '_worker', 'ingest'] },
  env: { ...process.env, PREPARATION_REPLY_DELAY_MS: String(delay) }, backoffMs: [0,0,0],
  spawnChild(command, args, env) {
    console.log({ command, args, parent: process.pid });
    const child = spawn(command, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.on('data', b => process.stderr.write(b));
    child.once('exit', (code, signal) => console.log({ code, signal }));
    return child;
  },
});

test('worker unavailable never runs main preparation, and pre-cancel never launches a child', async () => {
  await expect(MessagePreparation.open(raw, 'transcript')).rejects.toThrow('unavailable');
  const host = makeHost(), controller = new AbortController();
  controller.abort();
  try {
    await expect(MessagePreparation.open(raw, 'transcript', { host, signal: controller.signal })).rejects.toThrow();
    expect(host.state.pid).toBeNull();
  } finally { host.close(); }
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
  } finally { clearTimeout(timer); host.close(); }
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
  } finally { host.close(); }
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
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);
