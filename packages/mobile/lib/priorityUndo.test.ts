// A check-off on the phone (app/priorities.tsx, app/priority/[id].tsx build
// their writes from web lib/priorityWrites, as web does) shows on the undo bar
// with its own Undo, which puts back exactly what the press replaced.
import { beforeEach, expect, test } from 'bun:test';
import { _resetUndoStacks, resetUndoHistory } from '@platform/engine';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { priorityWrites } from '@codecast/web/lib/priorityWrites';
import { setAppActive, useUndoBar } from './undoBar';

const calls: Array<[string, unknown[]]> = [];
const step = (key: string, title: string) => ({ key, title, tier: 'critical' as const, tier_set_by: 'pass' as const, refs: [], done: false });
const priority = () => ({
  _id: 'p1', short_id: 'pri-1', title: 'Ship the grader', summary: '', status: 'active', rank: 1, person_pos: null, ai_rank: 1, status_set_by: 'pass',
  steps: [step('s1', 'Grader live')], counts: { critical_done: 0, critical_total: 1 }, sessions: [], links: [], mine: true,
  workspace: 'team:t1', user_id: 'me', last_active_at: 1, done_at: null,
});
const stored = () => (useInboxStore.getState() as any).priorities.p1;
const bar = () => useUndoBar.getState().item;
const writes = priorityWrites(() => {});

beforeEach(() => {
  resetUndoHistory();
  _resetUndoStacks();
  setAppActive(true);
  useUndoBar.setState({ item: null, heldKillId: null });
  calls.length = 0;
  const st = useInboxStore.getState() as any;
  st._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; });
  useInboxStore.setState({ pending: {}, priorities: { p1: priority() }, priorityDetails: {} } as any);
});

test('a milestone check-off shows on the bar, and its Undo opens the milestone again as the pass held it', () => {
  writes.setStepDone('pri-1', 's1', true);
  expect(stored().steps[0].done).toBe(true);
  expect(bar()?.title).toBe('Marked “Grader live” done');
  bar()!.onUndo!();
  expect(stored().steps[0].done).toBe(false);
  expect(stored().steps[0].done_set_by).toBeUndefined();
  expect(calls.map(([a, args]) => [a, ...args])).toEqual([['setPriorityStepDone', 'pri-1', 's1', true], ['undoPriorityStepDone', 'pri-1', 's1', null]]);
});

test("Mark done shows on the bar, and its Undo puts the priority back at its place", () => {
  writes.markDone('pri-1');
  expect(stored().status).toBe('done');
  expect(bar()?.title).toBe('Marked “Ship the grader” done');
  bar()!.onUndo!();
  expect([stored().status, stored().ai_rank]).toEqual(['active', 1]);
  expect(calls.at(-1)).toEqual(['undoPriorityDone', ['pri-1', { status: 'active', ai_rank: 1 }]]);
});
