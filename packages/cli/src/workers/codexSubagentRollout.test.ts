import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readIngestJob, ingestIdentity } from './ingestJobs.js';
import { isIngestSchemaRejection, validateIngestResult } from './ingestValidation.js';
import { TranscriptRetryOwner, transcriptFailureLog } from './ingestRetryOwner.js';
import type { IngestJob } from './ingestTypes.js';

// The head of a Codex 0.167 in-process subagent rollout as the app server wrote
// it on 2026-11-11 (every session_meta key it carried, ids and text replaced).
// Until 03f9d2065 the raw `source` object reached the ingest result, and its
// thread_spawn.agent_role failed the validator for all 254 such rollouts.
const PARENT = '01a1c92c-0000-7000-8000-000000000001';
const CHILD = '01a1c92d-0000-7000-8000-000000000002';
const at = (s: number) => `2026-11-11T05:56:${String(37 + s).padStart(2, '0')}.000Z`;
const ROLLOUT = [
  { timestamp: at(0), ordinal: 0, type: 'session_meta', payload: {
    creator_user_id: 'user-fixture', creator_account_id: '00000000-0000-4000-8000-000000000000',
    session_id: PARENT, id: CHILD, forked_from_id: PARENT, parent_thread_id: PARENT,
    timestamp: at(0), cwd: '/tmp/fixture', runtime_workspace_roots: ['/tmp/fixture'],
    originator: 'codecast', cli_version: '0.167.0',
    source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: '/root/search', agent_nickname: 'Fixture', agent_role: null } } },
    thread_source: 'subagent', agent_nickname: 'Fixture', agent_path: '/root/search', model_provider: 'openai',
    history_mode: 'paginated', subagent_history_start_ordinal: 24, multi_agent_version: 'v2',
    context_window: { window_id: '01a1c92d-0000-7000-8000-000000000003' }, git: {},
  } },
  { timestamp: at(1), ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', root_turn_id: 't1', started_at: 1794376508, model_context_window: 258400, collaboration_mode_kind: 'default' } },
  { timestamp: at(2), ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'Find the fixture.' }] }, metadata: { client_authored: false, inherited_user_message: true } },
  { timestamp: at(3), ordinal: 3, type: 'response_item', payload: { type: 'function_call', status: 'completed', id: 'f1', name: 'exec_command', namespace: 'functions', arguments: '{"cmd":"ls"}', call_id: 'c1' } },
  { timestamp: at(4), ordinal: 4, type: 'response_item', payload: { type: 'function_call_output', id: 'o1', call_id: 'c1', output: 'fixture.txt' } },
  { timestamp: at(5), ordinal: 5, type: 'response_item', payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }] } },
  { timestamp: at(6), ordinal: 6, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', root_turn_id: 't1', last_agent_message: 'Found it.' } },
].map(line => JSON.stringify(line) + '\n').join('');

async function withRollout(run: (job: IngestJob) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subagent-'));
  const file = path.join(root, `rollout-2026-11-11T00-56-37-${CHILD}.jsonl`);
  fs.writeFileSync(file, ROLLOUT);
  try { await run({ client: 'codex', file, sessionId: CHILD, offset: 0, generation: randomUUID(), identity: ingestIdentity(fs.statSync(file)) }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a Codex 0.167 subagent rollout ingests, keeping only the declared spawn fields', async () => {
  await withRollout(async job => {
    const result = await readIngestJob(job);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.metadata.codex).toEqual({ id: CHILD, parentThreadId: PARENT, originator: 'codecast',
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: '/root/search', agent_nickname: 'Fixture' } } } });
  });
});

test('the raw source shape is a schema rejection the retry path recognizes', async () => {
  await withRollout(async job => {
    const result = await readIngestJob(job);
    const raw = JSON.parse(ROLLOUT.split('\n')[0]).payload.source;
    const leaked = { ...result, metadata: { ...result.metadata, codex: { ...result.metadata.codex, source: raw } } };
    const error = await validateIngestResult(leaked, job).then(() => null, e => e);
    expect(isIngestSchemaRejection(error)).toBe(true);
    expect(isIngestSchemaRejection(new Error('ingest source changed before read'))).toBe(false);
  });
});

test('a schema rejection ends its retry burst at once and is not re-armed; a transient failure still is', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-retry-'));
  let now = 0;
  const owner = new TranscriptRetryOwner({ allowed: () => true, retryable: () => true, now: () => now, wakeDelayMs: 1 });
  const warn = console.warn; console.warn = () => {};
  try {
    const runs = { schema: 0, transient: 0 };
    const make = (kind: keyof typeof runs, message: string) => {
      const file = path.join(root, kind); fs.writeFileSync(file, 'x');
      return owner.create(new Map(), file, { client: 'codex', file, sessionId: kind }, async () => { runs[kind]++; throw new Error(message); }, { maxRetries: 3 });
    };
    const schema = make('schema', 'invalid ingest result schema');
    const transient = make('transient', 'ingest handle changed');
    await schema.invalidateAndAwait(); await transient.invalidateAndAwait();
    expect(runs).toEqual({ schema: 1, transient: 3 });
    now += 10;
    expect(owner.drain()).toBe(1);
    await transient.awaitQueue(); await schema.awaitQueue();
    expect(runs).toEqual({ schema: 1, transient: 6 });
    await schema.invalidateAndAwait();
    expect(runs.schema).toBe(2);
  } finally { console.warn = warn; owner.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a transcript failing the same way logs once a window and says how many lines it held back', () => {
  const lines: string[] = [];
  let now = Date.parse('2026-11-11T06:00:00Z');
  const logFailure = transcriptFailureLog(line => lines.push(line), 600_000, () => now);
  for (let i = 0; i < 600; i++) { logFailure('Error processing Codex session file a.jsonl', 'invalid ingest result schema'); now += 100; }
  logFailure('Error processing Codex session file b.jsonl', 'invalid ingest result schema');
  logFailure('Error processing Codex session file a.jsonl', 'ingest handle changed');
  now += 600_000;
  logFailure('Error processing Codex session file a.jsonl', 'invalid ingest result schema');
  expect(lines).toEqual([
    'Error processing Codex session file a.jsonl: invalid ingest result schema',
    'Error processing Codex session file b.jsonl: invalid ingest result schema',
    'Error processing Codex session file a.jsonl: ingest handle changed',
    'Error processing Codex session file a.jsonl: invalid ingest result schema (599 more since 2026-11-11T06:00:00.000Z)',
  ]);
});
