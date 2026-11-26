import { describe, expect, test } from 'bun:test';
import { flatViewSessions, fullRowsCounts, subagentKeepOf, type InboxSectionKey, type InboxSession } from '@codecast/web/store/inboxStore';
import { drawsSubagentLine, subagentGroupWords, subagentLines } from './subagentLine';

const NOW = 1_700_000_000_000;
let seq = 0;
// A Convex-shaped row settled past the idle grace (web lib/__tests__/subagentRows.test.ts).
const row = (extra: Record<string, unknown> = {}): InboxSession => ({
  _id: `jx7${String(++seq).padStart(29, '0')}`,
  session_id: `s${seq}`,
  agent_type: 'claude_code',
  title: `sub ${seq}`,
  message_count: 6,
  updated_at: NOW - 5 * 60_000,
  agent_status_updated_at: NOW - 5 * 60_000,
  started_at: NOW - 30 * 60_000,
  last_heartbeat: NOW - 5_000,
  is_idle: true,
  has_pending: false,
  is_connected: true,
  is_subagent: true,
  ...extra,
}) as InboxSession;
const working = (extra = {}) => row({ is_idle: false, agent_status: 'working', ...extra });
const waiting = (extra = {}) => row({ spawned_by_conversation_id: 'jx7parent', agent_status: 'idle', ...extra });
const finished = (extra = {}) => row(extra);

describe('drawsSubagentLine', () => {
  test('Folded and Compact draw the line in every view', () => {
    for (const flat of [false, true]) {
      expect(drawsSubagentLine('folded', flat)).toBe(true);
      expect(drawsSubagentLine('compact', flat)).toBe(true);
    }
  });
  test('Full rows list subagents as rows in the flat views, and keep the line where the phone nests none', () => {
    expect(drawsSubagentLine('full', true)).toBe(false);
    expect(drawsSubagentLine('full', false)).toBe(true);
  });
  test('Hidden draws nothing', () => {
    expect(drawsSubagentLine('hidden', false)).toBe(false);
    expect(drawsSubagentLine('hidden', true)).toBe(false);
  });
});

describe('subagentLines', () => {
  const parent = row({ is_subagent: false, title: 'parent' });
  const lead = row({ is_subagent: false, standing_role_id: 'role1' });
  const parents = new Map([[parent._id, parent], [lead._id, lead]]);
  const parentOf = (id: string) => parents.get(id);

  test('one group per state the filter keeps, most urgent first, newest opening', () => {
    const older = working({ updated_at: NOW - 9 * 60_000 });
    const newer = working({ updated_at: NOW - 1 * 60_000 });
    const asks = waiting();
    const subs = new Map([[parent._id, [older, finished(), newer]]]);
    const workers = new Map([[parent._id, [asks]]]);
    const groups = subagentLines([subs, workers], parentOf, NOW, 'active').get(parent._id)!;
    expect(groups.map((g) => [g.status, g.count])).toEqual([['needs_you', 1], ['working', 2]]);
    expect(groups[1].newest._id).toBe(newer._id);
    const all = subagentLines([subs, workers], parentOf, NOW, 'all').get(parent._id)!;
    expect(all.map((g) => g.status)).toEqual(['needs_you', 'working', 'done']);
  });

  test('no line when nothing survives the filter, and none on a role lead', () => {
    const lines = subagentLines([new Map([[parent._id, [finished()]], [lead._id, [working()]]])], parentOf, NOW, 'active');
    expect(lines.has(parent._id)).toBe(false);
    expect(lines.has(lead._id)).toBe(false);
  });

  test('leaves out the open one, a row of its own in a flat view', () => {
    const open = working();
    const subs = new Map([[parent._id, [working(), open]]]);
    expect(subagentLines([subs], parentOf, NOW, 'all').get(parent._id)!.map((g) => g.count)).toEqual([2]);
    expect(subagentLines([subs], parentOf, NOW, 'all', undefined, open._id).get(parent._id)!.map((g) => g.count)).toEqual([1]);
  });

  test('an unchanged line keeps its array, so the row stays memoized', () => {
    const subs = new Map([[parent._id, [working(), finished()]]]);
    const first = subagentLines([subs], parentOf, NOW, 'all');
    const again = subagentLines([subs], parentOf, NOW, 'all', first);
    expect(again.get(parent._id)).toBe(first.get(parent._id)!);
    const changed = subagentLines([new Map([[parent._id, [working()]]])], parentOf, NOW, 'all', first);
    expect(changed.get(parent._id)).not.toBe(first.get(parent._id)!);
  });

  // The list's data is built from the map: an unchanged map keeps it.
  test('no line changed: the previous map comes back, so the list is not rebuilt', () => {
    const subs = new Map([[parent._id, [working(), finished()]]]);
    const first = subagentLines([subs], parentOf, NOW, 'all');
    expect(subagentLines([subs], parentOf, NOW, 'all', first)).toBe(first);
    expect(subagentLines([subs], parentOf, NOW, 'active', first)).not.toBe(first);
    expect(subagentLines([new Map()], parentOf, NOW, 'all', first)).not.toBe(first);
  });
});

// The phone's flat Full rows: the shared flatViewSessions with the store's
// filter, the list the rail and its keyboard order walk.
describe('flat Full rows', () => {
  test('list the subagents the filter keeps under their parent, the open one always', () => {
    const parent = row({ is_subagent: false, updated_at: NOW - 60_000 });
    const under = { parent_conversation_id: parent._id };
    const busy = working(under);
    const quiet = finished(under);
    const open = finished(under);
    const subs = new Map([[parent._id, [busy, quiet, open]]]);
    const flat = (filter: 'active' | 'active_done' | 'all', focusedId: string | null) =>
      flatViewSessions([parent, busy, quiet, open], subs, { mode: 'recent', showSubagents: true, focusedId, keepSub: subagentKeepOf(filter, NOW, focusedId, {}) }).map((s) => s._id);
    expect(flat('active', open._id)).toEqual(expect.arrayContaining([parent._id, busy._id, open._id]));
    expect(flat('active', open._id)).not.toContain(quiet._id);
    expect(flat('active_done', null)).toHaveLength(4);
    expect(flat('all', null)).toHaveLength(4);
  });
});

// The section headers under Full rows: web's rule, so phone and rail agree.
test('Full rows section counts leave out the nested rows the filter hides', () => {
  const parent = row({ is_subagent: false });
  const quiet = finished({ parent_conversation_id: parent._id });
  const busy = working({ parent_conversation_id: parent._id });
  const counts = { questions: 0, pinned: 0, newSessions: 0, needsInput: 0, done: 3, dormant: 0, working: 0 } as Record<InboxSectionKey, number>;
  const placed = { counts, nestedSectionOf: new Map<string, InboxSectionKey>([[quiet._id, 'done'], [busy._id, 'done']]), subsByParent: new Map([[parent._id, [quiet, busy]]]) };
  expect(fullRowsCounts(placed, subagentKeepOf('active', NOW, null, {})).done).toBe(2);
  expect(fullRowsCounts(placed, subagentKeepOf('active', NOW, quiet._id, {})).done).toBe(3);
  expect(fullRowsCounts(placed, subagentKeepOf('all', NOW, null, {}))).toBe(counts);
});

test('subagentGroupWords says the count in words', () => {
  expect(subagentGroupWords({ status: 'working', count: 2 })).toBe('2 subagents working');
  expect(subagentGroupWords({ status: 'needs_you', count: 1 })).toBe('1 subagent needs you');
});
