import { describe, expect, test } from 'bun:test';
import type { InboxSession } from '@codecast/web/store/inboxStore';
import { activityLineParts, splitDormant } from './inboxActivity';
import { movedWeight } from '@codecast/web/lib/railActivity';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const id = (tag: string) => tag.padEnd(32, '0');

const parked = (_id: string, extra: Record<string, unknown> = {}) => ({
  _id,
  session_id: `s-${_id.slice(0, 8)}`,
  agent_type: 'claude_code',
  title: _id,
  user_id: 'me',
  message_count: 6,
  updated_at: NOW - 5 * 60_000,
  started_at: NOW - HOUR,
  last_heartbeat: NOW - 5_000,
  is_idle: true,
  agent_status: 'dormant',
  ...extra,
}) as unknown as InboxSession;

const REVIEWERS = id('reviewers');
const SHIPPER = id('shipper');
const FAILED = id('failedci');
const ON_PERSON = id('onperson');
const ON_SESSION = id('onsession');
const ON_TASK = id('ontask');
const ON_PR = id('onpr');
const SCHEDULED = id('scheduled');
const STALLED = id('stalled');

const rows = [
  parked(REVIEWERS, { open_tasks: [{ kind: 'agent', description: 'Review the list rewrite' }, { kind: 'agent', description: 'Review the store change' }, { kind: 'agent', description: 'Verify the build' }], open_tasks_at: NOW - 60_000 }),
  parked(SHIPPER, { pr_status: { pr_id: 'p1', repository: 'acme/app', number: 263, state: 'ci_pending' } }),
  parked(FAILED),
  parked(ON_PERSON, { waiting_on: { kind: 'person', ref: '@ashot', at: NOW - 2 * HOUR } }),
  parked(ON_SESSION, { waiting_on: { kind: 'session', ref: id('waitedon'), label: 'jx7abc1' } }),
  parked(ON_TASK, { waiting_on: { kind: 'task', ref: 'ct-102274', at: NOW - HOUR } }),
  parked(ON_PR, { waiting_on: { kind: 'pr', ref: 'acme/app#259' } }),
  parked(SCHEDULED, { armed_trigger_kind: 'standing' }),
  parked(STALLED),
];

const run = (_id: string, spawner: string, extra: Record<string, unknown>) => ({
  _id, spawner_conversation_id: spawner, takes_change: true, status: 'running', created_at: NOW - HOUR, updated_at: NOW - 60_000, ...extra,
});

const state = {
  sessions: Object.fromEntries(rows.map((r) => [r._id, r])),
  workflowRuns: {
    r1: run('r1', SHIPPER, { current_node_id: 'ci', current_node_label: 'CI' }),
    r2: run('r2', FAILED, { current_node_id: 'ci_conflict', waiting_on_session: { node_id: 'ci_conflict', conversation_id: FAILED } }),
  },
  agentTasks: {
    t1: { _id: 't1', title: 'Distill new huddles', status: 'scheduled', run_at: NOW + 44 * 60_000, schedule_type: 'recurring', originating_conversation_id: SCHEDULED, created_at: NOW - HOUR },
  },
  sessionDecisions: {},
  currentUser: { _id: 'me' },
  clientState: { ui: {} },
} as any;

const split = splitDormant(state, rows, NOW);
const line = (rowId: string) => activityLineParts(split.activity.get(rowId)!, NOW);

describe("the phone inbox's split of Dormant", () => {
  test('delegated work reads Working, a change in flight Shipping, and only waits stay Sleeping', () => {
    expect(split.working.map((r) => r._id)).toEqual([REVIEWERS]);
    expect(split.shipping.map((r) => r._id).sort()).toEqual([SHIPPER, FAILED].sort());
    expect(split.sleeping.map((r) => r._id)).toEqual([ON_PERSON, ON_SESSION, ON_TASK, ON_PR, SCHEDULED, STALLED]);
  });

  test('a moved card carries its nested Dormant rows into the header number under Full rows', () => {
    const sub = parked(id('sub'));
    const subs = new Map([[REVIEWERS, [sub]]]);
    const all = () => true;
    expect(movedWeight(split.working, null, subs, new Map([[sub._id, 'dormant']]))).toBe(1);
    expect(movedWeight(split.working, all, subs, new Map([[sub._id, 'dormant']]))).toBe(2);
    expect(movedWeight(split.working, all, subs, new Map([[sub._id, 'working']]))).toBe(1);
    expect(movedWeight(split.working, () => false, subs, new Map([[sub._id, 'dormant']]))).toBe(1);
  });
});

describe('the under-lines say what web says', () => {
  test('Working names the work', () => {
    expect(line(REVIEWERS)).toMatchObject({ label: 'What is running', words: '3 subagents · reviewing', warn: false, bar: null });
  });

  test('Shipping has neutral words and the bar at its stage; a failed step says so', () => {
    expect(line(SHIPPER)).toMatchObject({ words: 'CI running · #263', bar: { stage: 'ci', failed: false }, warn: false });
    expect(line(FAILED)).toMatchObject({ words: 'CI failed · fixing', bar: { stage: 'ci', failed: true }, warn: false });
  });

  test('a step held for the viewer asks for attention; one held for someone else stays neutral', () => {
    const held = (holder: 'you' | 'other') => activityLineParts({ state: 'shipping', stage: 'deploy', failed: false, words: 'Your call', holder }, NOW);
    expect(held('you')).toMatchObject({ label: 'What the change waits on you for', words: 'Your call', warn: true, bar: { stage: 'deploy', failed: false } });
    expect(held('other')).toMatchObject({ label: 'Where the change is', warn: false });
  });

  test('a wait names its target, with the tail and how long', () => {
    expect(line(ON_PERSON)).toMatchObject({ waiting: { kind: 'person', ref: '@ashot', label: '@ashot', tail: null }, right: 'since 2h', warn: false });
    // A session is drawn from its conversation id, its short id the text.
    expect(line(ON_SESSION)).toMatchObject({ waiting: { kind: 'session', ref: id('waitedon'), label: 'jx7abc1', tail: null }, right: null });
    expect(line(ON_TASK)).toMatchObject({ waiting: { kind: 'task', ref: 'ct-102274', label: 'ct-102274', tail: 'landing' }, right: 'since 1h' });
    expect(line(ON_PR)).toMatchObject({ waiting: { kind: 'pr', ref: 'acme/app#259', label: '#259', tail: 'to merge' } });
  });

  test("a trigger reads its title and countdown", () => {
    expect(line(SCHEDULED)).toMatchObject({ words: 'Distill new huddles', right: 'in 44m', warn: false, waiting: null });
  });

  test('nothing visible to wake it is the stalled line, in the warning colour with the alert glyph', () => {
    const stalled = line(STALLED);
    expect(stalled).toMatchObject({ label: 'Nothing wakes this session', words: 'nothing scheduled', warn: true, alert: true });
    expect(stalled.right).toStartWith('back to you in ');
  });
});
