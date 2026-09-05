import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
for (const scenario of [{mutant:false,client:undefined},{mutant:true,client:'claude'},{mutant:true,client:'gemini'}]) for (const enabled of [false, true]) test(`emission known receipt clock recovery worker=${enabled} mutant=${scenario.mutant} client=${scenario.client??'both'}`, async () => {
  const {mutant,client}=scenario;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-review-control-')), bin = path.join(root, 'bin'), tmp = path.join(root, 'tmux');
  fs.mkdirSync(bin); fs.mkdirSync(tmp);
  for (const name of ['tmux', 'ps', 'lsof', 'claude', 'codex', 'gemini', 'opencode', 'pi', 'grok']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  let producer: string | undefined, productionSha256: string | undefined, scratchSha256: string | undefined;
  try {
    if (mutant) {
      const original = fs.readFileSync(path.join(import.meta.dir, 'ingestJobs.ts'), 'utf8');
      const needle = 'result.receiptSignatures.push(ingestReceiptSignature(message,source));';
      expect(original.split(needle).length).toBe(2);
      const scratch = original.replace(needle, "result.receiptSignatures.push(createHash('sha256').update(JSON.stringify(message)).digest('hex'));").replace(/((?:from\s+|import\()['"])([^'"]+)(['"])/g, (all, start, spec, end) => spec.startsWith('.') ? start + path.resolve(import.meta.dir, spec) + end : all);
      producer = path.join(root, 'ingestJobs-generated-clock.ts'); fs.writeFileSync(producer, scratch);
      productionSha256 = sha(original); scratchSha256 = sha(scratch);
    }
    const result = await run(process.execPath, [path.join(import.meta.dir, 'fixtures/ingestProduction.ts'), String(enabled), 'emission-review'], {
      env: { ...process.env, HOME: root, TMUX_TMPDIR: tmp, TMUX: '', PATH: bin + path.delimiter + process.env.PATH, NODE_ENV: 'test', F3_FIXTURE_EMISSION_CLIENT: client, F3_FIXTURE_PHYSICAL_TASKKEY: mutant ? '1' : '0', F3_FIXTURE_INGEST_PRODUCER: producer },
      timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    }).then(output => ({ ok: true, code: 0, ...output }), error => ({ ok: false, code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: String(error) }));
    console.log(JSON.stringify({ enabled, mutant, client, productionSha256, scratchSha256, outcome: result }));
    if (mutant) {
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('known receipt must not resend generated timestamp occurrences');
      const invocations = fs.readdirSync(root).filter(name => /^invocations-\d+\.jsonl$/.test(name)).flatMap(name => fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
      console.log(JSON.stringify({ enabled, mutant, client, invocations }));
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every(row => row.sha256 === scratchSha256 && row.producer === producer)).toBe(true);
      const pids = new Set(invocations.map(row => row.pid));
      const supervisor = fs.readdirSync(root).filter(name => /^producer-\d+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))).find(row => row.ppid === process.pid);
      expect(supervisor).toBeDefined(); expect(pids.size).toBe(1); expect(pids.has(supervisor.pid)).toBe(!enabled);
    } else {
      expect(result.ok).toBe(true);
      const row = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      expect(row.review).toEqual({ formats: 2, clockReread: true, nativeTextChange: true, identicalOccurrences: true, filtered: true, toolsImages: true, queuedShiftedWindow: true });
      if (enabled) { expect(row.parentParses).toBe(0); expect(row.workerPid).toBeGreaterThan(0); }
    }
  } finally {
    const owned = fs.readdirSync(root).filter(name => /^fixture-process-\d+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).pid as number);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
    const end = Date.now() + 2000;
    while (owned.some(alive) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    const remaining = owned.filter(alive); console.log(JSON.stringify({ enabled, mutant, ownedPids: owned, remaining }));
    expect(remaining).toEqual([]); if (!remaining.length) fs.rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
