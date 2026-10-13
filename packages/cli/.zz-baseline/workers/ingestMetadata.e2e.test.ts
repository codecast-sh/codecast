import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };

for (const mode of ['current', 'old-tail']) test(`metadata actual child ${mode}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-metadata-child-'));
  fs.mkdirSync(path.join(root, 'tmux'));
  const token = randomUUID().replaceAll('-', '');
  const evidence = process.env.F3_METADATA_EVIDENCE;
  const allocation = { ownerPid: process.pid, root: fs.realpathSync(root), token, mode, fixture: path.join(import.meta.dir, 'fixtures/ingestMetadataControl.ts') };
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'allocation-' + token + '.json'), JSON.stringify(allocation) + '\n');
  }
  console.error('F3_METADATA_ALLOCATION ' + JSON.stringify(allocation));
  const result = await run(process.execPath, [path.join(import.meta.dir, 'fixtures/ingestMetadataControl.ts'), mode], {
    env: { ...process.env, HOME: root, TMPDIR: root, TMUX_TMPDIR: path.join(root, 'tmux'), TMUX: '', NODE_ENV: 'test', F3_METADATA_ROOT: root, F3_METADATA_TOKEN: token },
    timeout: 15000, maxBuffer: 1024 * 1024,
  }).then(output => ({ ok: true, ...output }), error => ({ ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: String(error) }));
  console.error('F3_METADATA_SUBPROCESS ' + JSON.stringify({ mode, root, token, ...result }));
  const files = fs.readdirSync(root);
  const receipts = files.filter(name => name.endsWith('.json')).map(name => ({ name, value: JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) }));
  const spawnReceipts = receipts.filter(receipt => receipt.name.startsWith('spawn-'));
  const owned = receipts.filter(receipt => /^(spawn|fixture-process|worker-source)-/.test(receipt.name));
  const valid = owned.every(receipt => receipt.value.token === token && Number.isSafeInteger(receipt.value.pid) && receipt.value.pid > 1);
  const remaining = valid ? [...new Set(owned.map(receipt => receipt.value.pid as number))].filter(alive) : [];
  const census = await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 }).then(output => ({ ok: true, ...output }), error => ({ ok: false, stdout: '', stderr: String(error) }));
  const groups = new Set(spawnReceipts.map(receipt => receipt.value.pid));
  const remainingGroups = census.stdout.split('\n').filter(line => groups.has(Number(line.trim().split(/\s+/)[2])));
  const artifact = { mode, root, token, result, receipts, valid, remaining, remainingGroups, censusKnown: census.ok };
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, mode + '.json'), JSON.stringify(artifact, null, 2) + '\n');
    fs.cpSync(root, path.join(evidence, mode + '-sources'), { recursive: true });
  }
  const outcome = receipts.find(receipt => receipt.name === 'metadata-outcome.json')?.value;
  const complete = valid && remaining.length === 0 && census.ok && remainingGroups.length === 0 && spawnReceipts.length === 1 && outcome && Array.isArray(outcome.remaining) && outcome.remaining.length === 0;
  if (complete) fs.rmSync(root, { recursive: true });
  console.error('F3_METADATA_CLEANUP ' + JSON.stringify({ mode, root, valid, remaining, remainingGroups, censusKnown: census.ok, removed: !fs.existsSync(root), complete }));
  expect(complete).toBe(true);
  expect(result.ok).toBe(true);
  if (mode === 'current') expect(outcome.completed).toBe(32);
  else { expect(outcome.completed).toBeGreaterThan(0); expect(outcome.completed).toBeLessThan(32); }
  expect(outcome.supervisorParses).toBe(mode === 'current' ? 0 : 1);
}, 20000);
