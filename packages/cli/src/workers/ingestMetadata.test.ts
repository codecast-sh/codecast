import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readIngestJob, ingestIdentity } from './ingestJobs.js';
import type { IngestJob } from './ingestTypes.js';

const limit = 64 * 1024;
const row = (value: unknown) => JSON.stringify(value) + '\n';
const assistant = (text: string, id: string = randomUUID()) => row({ type: 'assistant', uuid: id, timestamp: '2026-09-05T12:00:00Z', message: { content: text } });
const prefix = () => Array.from({ length: 256 }, (_, i) => assistant(`prefix ${i}`, `prefix-${i}`)).join('');
async function fixture(content: string, run: (job: IngestJob) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-metadata-job-'));
  const file = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(file, content);
  const job: IngestJob = { client: 'claude', file, offset: 0, sessionId: 'metadata-fixture', generation: randomUUID(), identity: ingestIdentity(fs.statSync(file)) };
  try { await run(job); }
  finally { fs.rmSync(root, { recursive: true }); }
}
const outcome = <T>(value: Promise<T>) => value.then(result => ({ result }), error => ({ error }));

test('Codex project metadata survives long session headers on initial and incremental reads', async () => {
  for (const bytes of [22 * 1024, 96 * 1024]) {
    const head = row({ type: 'session_meta', payload: { id: 'codex-thread', cwd: '/Users/ashot/src/codecast', originator: 'codex-tui', source: 'cli', base_instructions: { text: 'x'.repeat(bytes) } } });
    const message = row({ type: 'response_item', timestamp: '2026-09-07T22:42:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check browser routing' }] } });
    await fixture(head + message, async job => {
      for (const offset of [0, Buffer.byteLength(head)]) {
        const result = await readIngestJob({ ...job, client: 'codex', offset });
        expect(result.metadata.cwd).toBe('/Users/ashot/src/codecast');
        expect(result.metadata.codex?.originator).toBe('codex-tui');
        expect(result.messages[0].content).toBe('Check browser routing');
      }
    });
  }
});

test('production metadata finds a summary beyond the original tail behind a large native row', async () => {
  const primary = prefix();
  await fixture(primary + row({ type: 'summary', summary: 'recovered title' }) + assistant('😀'.repeat(5000)), async job => {
    const result = await readIngestJob(job);
    expect(result.bytesConsumed).toBe(Buffer.byteLength(primary));
    expect(result.messages.length).toBe(256);
    expect(result.metadata.summaryTitle).toBe('recovered title');
    expect(result.metadata.warnings).toEqual([]);
  });
});

test('primary summary precedes tail summaries and initial tail first-summary ordering stays exact', async () => {
  const first = row({ type: 'summary', summary: 'primary first' });
  await fixture(first + prefix() + row({ type: 'summary', summary: 'tail later' }), async job => {
    expect((await readIngestJob(job)).metadata.summaryTitle).toBe('primary first');
  });
  const initial = row({ type: 'summary', summary: 'tail first' }) + row({ type: 'summary', summary: 'tail second' });
  await fixture(prefix() + initial, async job => {
    expect((await readIngestJob(job)).metadata.summaryTitle).toBe('tail first');
  });
});

test('first large head record retains native scalar and first-three user semantics', async () => {
  const first = row({ type: 'user', uuid: 'head-first', slug: 'native-slug', cwd: '/owned/work', parentUuid: 'native-parent', timestamp: '2026-09-05T12:00:00Z', message: { content: 'x'.repeat(20 * 1024) } });
  await fixture(first + assistant('later'), async job => {
    const result = await readIngestJob(job);
    expect(result.metadata.slug).toBe('native-slug');
    expect(result.metadata.cwd).toBe('/owned/work');
    expect(result.metadata.parentUuid).toBe('native-parent');
    expect(result.metadata.headMessages?.map(message => message.uuid)).toEqual(['head-first']);
    expect(result.messages[0].content).toBe('x'.repeat(20 * 1024));
  });
});

test('required heads grow for complete large records at either offset while incomplete heads refuse', async () => {
  const empty = assistant('', 'giant-first');
  const exact = assistant('x'.repeat(limit - Buffer.byteLength(empty)), 'giant-first');
  await fixture(exact + assistant('tail'), async job => {
    expect((await readIngestJob(job)).bytesConsumed).toBe(job.identity.size);
  });
  const tooLarge = assistant('x'.repeat(limit - Buffer.byteLength(empty) + 1), 'giant-first');
  await fixture(tooLarge + assistant('tail'), async job => {
    for (const offset of [0, Buffer.byteLength(tooLarge)]) {
      const result = await readIngestJob({ ...job, offset });
      expect(result.bytesConsumed).toBe(job.identity.size - offset);
      expect(result.messages.at(-1)?.content).toBe('tail');
    }
  });
  await fixture(assistant('unfinished').slice(0, -1), async job => {
    const result = await outcome(readIngestJob(job));
    expect('error' in result && result.error.message).toBe('ingest head incomplete: no complete native prefix');
    fs.appendFileSync(job.file, '\n');
    const complete = await readIngestJob({ ...job, identity: ingestIdentity(fs.statSync(job.file)) });
    expect(complete.messages.length).toBe(1);
  });
  await fixture('', async job => {
    const result = await readIngestJob(job);
    expect(result.bytesConsumed).toBe(0);
    expect(result.metadata.headMessages).toEqual([]);
    expect(result.metadata.warnings).toEqual([]);
  });
});

test('leading blank records cannot hide the first native metadata record', async () => {
  const first = row({ type: 'user', uuid: 'after-blanks', cwd: '/known', parentUuid: 'parent', timestamp: '2026-09-05T12:00:00Z', message: { content: 'first native record' } });
  await fixture((' '.repeat(limit) + '\n').repeat(4) + first, async job => {
    const result = await readIngestJob(job);
    expect(result.metadata.cwd).toBe('/known');
    expect(result.metadata.parentUuid).toBe('parent');
    expect(result.metadata.headMessages?.map(message => message.uuid)).toEqual(['after-blanks']);
  });
});

test('complete prefix survives later exhaustion and incomplete optional title is diagnosed', async () => {
  const first = row({ type: 'user', cwd: '/known', parentUuid: 'known-parent', timestamp: '2026-09-05T12:00:00Z', message: { content: 'first' } });
  await fixture(first + assistant('x'.repeat(limit + 100)), async job => {
    const result = await readIngestJob(job);
    expect(result.metadata.cwd).toBe('/known');
    expect(result.metadata.parentUuid).toBe('known-parent');
    expect(result.bytesConsumed).toBe(job.identity.size);
    expect(result.metadata.warnings).toContain(`head: metadata read allowance exhausted (${limit} bytes)`);
    expect(result.metadata.warnings).toContain(`title: metadata read allowance exhausted (${limit} bytes)`);
  });
  const primary = prefix();
  await fixture(primary + row({ type: 'summary', summary: 'unfinished title' }).slice(0, -1), async job => {
    const result = await readIngestJob(job);
    expect(result.bytesConsumed).toBe(Buffer.byteLength(primary));
    expect(result.metadata.summaryTitle).toBeUndefined();
    expect(result.metadata.warnings).toContain('title: incomplete final record');
  });
});

test('real malformed tail records keep parser diagnostics and malformed primary input rejects', async () => {
  const log = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await fixture(prefix() + '{native malformed}\n' + row({ type: 'summary', summary: 'after malformed' }), async job => {
      const result = await readIngestJob(job);
      expect(result.metadata.summaryTitle).toBe('after malformed');
      expect(log.mock.calls.flat().join('\n')).toContain('Failed to parse session line');
    });
    await fixture('{native malformed}\n', async job => {
      const result = await outcome(readIngestJob(job));
      expect('error' in result && result.error instanceof SyntaxError).toBe(true);
    });
  } finally { log.mockRestore(); }
});

test('optional title EACCES preserves primary data and head EACCES remains a refusal', async () => {
  await fixture(prefix() + assistant('tail'.repeat(2000)), async job => {
    const nativeOpen = fs.promises.open.bind(fs.promises);
    let denyHead = false;
    let opens = 0;
    const denied = Object.assign(new Error('owned metadata denied'), { code: 'EACCES' });
    const open = spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof nativeOpen>) => {
      const fd = await nativeOpen(...args);
      const ordinal = ++opens;
      const nativeRead = fd.read.bind(fd);
      fd.read = (async (...values: unknown[]) => {
        if (denyHead && ordinal === 2 || !denyHead && values[2] === 4097 && Number(values[3]) > 0) throw denied;
        return (nativeRead as (...input: unknown[]) => Promise<unknown>)(...values);
      }) as typeof fd.read;
      return fd;
    });
    try {
      const result = await readIngestJob(job);
      expect(result.messages.length).toBe(256);
      expect(result.bytesConsumed).toBe(Buffer.byteLength(prefix()));
      expect(result.metadata.warnings).toContain('title: EACCES');
      denyHead = true; opens = 0;
      const failure = await outcome(readIngestJob(job));
      expect('error' in failure && failure.error).toBe(denied);
    } finally { open.mockRestore(); }
  });
});

test('metadata read cancellation closes the held real handle before rejecting', async () => {
  await fixture(assistant('head'), async job => {
    const nativeOpen = fs.promises.open.bind(fs.promises);
    const refusal = new Error('cancel during head read');
    let opens = 0;
    let cancelled = false;
    let closed = false;
    const open = spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof nativeOpen>) => {
      const fd = await nativeOpen(...args);
      if (++opens === 2) {
        const nativeRead = fd.read.bind(fd);
        const nativeClose = fd.close.bind(fd);
        fd.read = (async (...values: unknown[]) => {
          const result = await (nativeRead as (...input: unknown[]) => Promise<unknown>)(...values);
          cancelled = true;
          return result;
        }) as typeof fd.read;
        fd.close = async () => { await nativeClose(); closed = true; };
      }
      return fd;
    });
    try {
      const result = await outcome(readIngestJob(job, () => { if (cancelled) throw refusal; }));
      expect('error' in result && result.error).toBe(refusal);
      expect(closed).toBe(true);
    } finally { open.mockRestore(); }
  });
});

test('held metadata handle cannot substitute a replacement generation', async () => {
  await fixture(assistant('original'), async job => {
    const nativeOpen = fs.promises.open.bind(fs.promises);
    let opens = 0;
    let replaced = false;
    const open = spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof nativeOpen>) => {
      if (++opens === 2) {
        const replacement = job.file + '.replacement';
        fs.writeFileSync(replacement, assistant('replacement'));
        fs.renameSync(replacement, job.file);
        replaced = true;
      }
      return nativeOpen(...args);
    });
    try {
      const result = await outcome(readIngestJob(job));
      expect(replaced).toBe(true);
      expect('error' in result && result.error.message).toBe('ingest metadata handle changed');
    } finally { open.mockRestore(); }
  });
});

test('checkpoint refusal is never reclassified as optional title access failure', async () => {
  await fixture(prefix() + assistant('tail'.repeat(2000)), async job => {
    const nativeOpen = fs.promises.open.bind(fs.promises);
    const refusal = Object.assign(new Error('checkpoint with native-looking code'), { code: 'EACCES' });
    let tailRead = false;
    const open = spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof nativeOpen>) => {
      const fd = await nativeOpen(...args);
      const nativeRead = fd.read.bind(fd);
      fd.read = (async (...values: unknown[]) => {
        const result = await (nativeRead as (...input: unknown[]) => Promise<unknown>)(...values);
        if (values[2] === 4097 && Number(values[3]) > 0) tailRead = true;
        return result;
      }) as typeof fd.read;
      return fd;
    });
    try {
      const result = await outcome(readIngestJob(job, () => { if (tailRead) throw refusal; }));
      expect(tailRead).toBe(true);
      expect('error' in result && result.error).toBe(refusal);
    } finally { open.mockRestore(); }
  });
});

test('Codex title uses the same complete tail while keeping its session head and model state', async () => {
  const native = row({ type: 'session_meta', payload: { id: 'codex-metadata', cwd: '/owned/codex', originator: 'codex_cli_rs' } });
  const primary = native + Array.from({ length: 255 }, (_, i) => row({ type: 'event_msg', payload: { type: 'agent_message', message: `codex ${i}` } })).join('');
  await fixture(primary + row({ type: 'summary', summary: 'codex tail title' }) + row({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(20000) } }), async job => {
    const result = await readIngestJob({ ...job, client: 'codex', modelKnown: true, model: 'preserved-model' });
    expect(result.metadata.summaryTitle).toBe('codex tail title');
    expect(result.metadata.cwd).toBe('/owned/codex');
    expect(result.metadata.codex?.id).toBe('codex-metadata');
    expect(result.model).toBe('preserved-model');
    expect(result.bytesConsumed).toBe(Buffer.byteLength(primary));
  });
});

test('failed real-handle close is required and double failure keeps the primary error', async () => {
  for (const mode of ['close', 'read-and-close', 'checkpoint-and-close', 'writer-failure', 'render-failure']) await fixture(prefix() + assistant('tail'.repeat(2000)), async job => {
    const nativeOpen = fs.promises.open.bind(fs.promises);
    const closeError = Object.assign(new Error('close refused before retirement'), { code: 'EIO' });
    const primaryError = Object.assign(new Error('original read or checkpoint refusal'), { code: 'EACCES' });
    const diagnosticError = new Error('diagnostic failed');
    let renders = 0;
    if (mode === 'render-failure') Object.defineProperty(closeError, Symbol.toPrimitive, { value: () => { renders++; throw diagnosticError; } });
    let opens = 0;
    let checkpointFailed = false;
    let held: Awaited<ReturnType<typeof nativeOpen>> | undefined;
    let closeOwned: (() => Promise<void>) | undefined;
    const open = spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof nativeOpen>) => {
      const fd = await nativeOpen(...args);
      if (++opens === 3) {
        held = fd;
        closeOwned = fd.close.bind(fd);
        fd.close = async () => { throw closeError; };
        const nativeRead = fd.read.bind(fd);
        fd.read = (async (...values: unknown[]) => {
          if (['read-and-close', 'writer-failure', 'render-failure'].includes(mode)) throw primaryError;
          const result = await (nativeRead as (...input: unknown[]) => Promise<unknown>)(...values);
          if (mode === 'checkpoint-and-close') checkpointFailed = true;
          return result;
        }) as typeof fd.read;
      }
      return fd;
    });
    const diagnostic = spyOn(process.stderr, 'write').mockImplementation(() => { if (mode === 'writer-failure') throw diagnosticError; return true; });
    let savedDiagnostics: string[] = [];
    try {
      const result = await outcome(readIngestJob(job, () => { if (checkpointFailed) throw primaryError; }));
      expect('error' in result && result.error).toBe(mode === 'close' ? closeError : primaryError);
      expect(held).toBeDefined();
      expect(held!.fd).toBeGreaterThanOrEqual(0);
      savedDiagnostics = diagnostic.mock.calls.map(args => String(args[0]));
      if (mode !== 'close' && mode !== 'render-failure') {
        expect(savedDiagnostics.join('')).toContain(closeError.message);
        expect(savedDiagnostics.join('')).toContain(primaryError.message);
      }
      if (mode === 'writer-failure') expect(diagnostic).toHaveBeenCalledTimes(1);
      if (mode === 'render-failure') { expect(renders).toBe(1); expect(diagnostic).not.toHaveBeenCalled(); }
    } finally {
      diagnostic.mockRestore();
      open.mockRestore();
      if (closeOwned) await closeOwned();
      console.error('F3_METADATA_CLOSE_INTERVENTION ' + JSON.stringify({ mode, productRetired: false, fixtureRetired: held?.fd === -1, diagnostics: savedDiagnostics }));
    }
    expect(held!.fd).toBe(-1);
  });
});

test('job settlement waits for actual held close and then observes the same deadline', async () => {
  for (const cancel of [false, true]) await fixture(prefix() + assistant('tail'.repeat(2000)), async job => {
    const nativeOpen = fs.promises.open.bind(fs.promises);
    let opens = 0;
    let release!: () => void;
    const permit = new Promise<void>(resolve => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const refusal = new Error('deadline while close held');
    let cancelled = false;
    let retired = false;
    let settled = false;
    let closeOwned: (() => Promise<void>) | undefined;
    const open = spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof nativeOpen>) => {
      const fd = await nativeOpen(...args);
      if (++opens === 3) {
        closeOwned = fd.close.bind(fd);
        fd.close = async () => { began(); await permit; await closeOwned!(); retired = true; };
      }
      return fd;
    });
    const completion = outcome(readIngestJob(job, () => { if (cancelled) throw refusal; })).then(value => { settled = true; return value; });
    try {
      const reached = await Promise.race([started.then(() => true), completion.then(() => false)]);
      expect(reached).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(retired).toBe(false);
      cancelled = cancel;
      release();
      const result = await completion;
      expect(retired).toBe(true);
      if (cancel) expect('error' in result && result.error).toBe(refusal);
      else expect('result' in result && result.result.messages.length).toBe(256);
    } finally {
      release();
      await completion;
      open.mockRestore();
      if (closeOwned && !retired) await closeOwned();
    }
  });
});
