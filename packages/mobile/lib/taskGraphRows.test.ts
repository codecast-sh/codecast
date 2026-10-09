import { describe, expect, it } from 'bun:test';
import type { TaskWait } from '@codecast/shared/tasks';
import { taskGraphView } from './taskGraphRows';

const tasks = Object.fromEntries(
  [
    { _id: 'a1', short_id: 'ct-1', status: 'done', title: 'Design the schema' },
    { _id: 'a3', short_id: 'ct-3', status: 'open', title: 'Build the API' },
    { _id: 'a9', short_id: 'ct-9', status: 'in_progress', title: 'Ship it' },
  ].map((t) => [t._id, t]),
);
const wait = (over: Partial<TaskWait>): TaskWait =>
  ({ id: 'w1', kind: 'pr_merged', repository: 'codecast-sh/codecast', pr_number: 42, state: 'waiting', created_at: 0, ...over }) as TaskWait;

describe('taskGraphView', () => {
  it('lists task blockers then waits, cleared ones kept and marked, with titles from the held rows', () => {
    const met = wait({ id: 'w2', kind: 'decision', decision: 'sd-4', state: 'met', note: 'answered: Ship it' } as any);
    const view = taskGraphView({ blocked_by: ['ct-1', 'ct-3', 'ct-77'], waits: [wait({}), met] }, tasks);
    expect(view.unblocked).toBe(false);
    expect(view.blockedBy).toEqual([
      { key: 'task:ct-1', kind: 'task', ref: 'ct-1', status: 'done', title: 'Design the schema', cleared: true },
      { key: 'task:ct-3', kind: 'task', ref: 'ct-3', status: 'open', title: 'Build the API', cleared: false },
      // The phone does not hold ct-77, so its state is unknown, never cleared.
      { key: 'task:ct-77', kind: 'task', ref: 'ct-77', status: 'unknown', stateLabel: 'status unknown', title: undefined, cleared: false },
      { key: 'wait:w1', kind: 'pr_merged', label: 'PR #42 merges', state: 'waiting', word: 'to merge', cleared: false },
      { key: 'wait:w2', kind: 'decision', label: 'sd-4 answered', state: 'met', word: 'answered: Ship it', cleared: true },
    ]);
  });

  it('a blocker the detail found no task for reads as not found and holds nothing back, as on the server', () => {
    const view = taskGraphView({ blocked_by: ['ct-1', 'ct-404'], graph_missing: ['ct-404'] }, tasks);
    expect(view.blockedBy[1]).toEqual({ key: 'task:ct-404', kind: 'task', ref: 'ct-404', status: 'missing', stateLabel: 'not found', cleared: false });
    expect(view.unblocked).toBe(true);
  });

  it('a blocker the phone does not hold reads from the list row\'s graph_status, as on the web', () => {
    const view = taskGraphView({ blocked_by: ['ct-500'], graph_status: [{ ref: 'ct-500', short_id: 'ct-500', status: 'done' }] }, tasks);
    expect(view.blockedBy[0]).toMatchObject({ ref: 'ct-500', status: 'done', cleared: true });
    expect(view.unblocked).toBe(true);
  });

  it('a wait kind newer than this bundle reads by its name', () => {
    const [row] = taskGraphView({ waits: [wait({ kind: 'deploy_live' as any })] }, tasks).blockedBy;
    expect(row).toMatchObject({ kind: 'deploy_live', label: 'deploy_live', state: 'waiting', word: 'waiting' });
  });

  it('a held task wins over a stale missing ref', () => {
    expect(taskGraphView({ blocked_by: ['ct-3'], graph_missing: ['ct-3'] }, tasks).blockedBy[0]).toMatchObject({ status: 'open', title: 'Build the API' });
  });

  it('a blocker named by its _id reads as its short id', () => {
    expect(taskGraphView({ blocked_by: ['a3'] }, tasks).blockedBy[0]).toMatchObject({ ref: 'ct-3', title: 'Build the API' });
  });

  it('a failed wait stays open and carries its note, or the shared failure word without one', () => {
    const [noted, bare] = taskGraphView({ waits: [wait({ state: 'failed', note: 'closed before its checks went green' }), wait({ id: 'w2', state: 'failed' })] }, tasks).blockedBy;
    expect(noted).toMatchObject({ state: 'failed', word: 'closed before its checks went green', cleared: false });
    expect(bare).toMatchObject({ word: 'closed without merging' });
  });

  it('words a wait the way the web does: a countdown while pending, nothing once the task closed', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const timed = wait({ kind: 'time', at: now + 2 * 3600_000 } as any);
    expect(taskGraphView({ waits: [timed] }, tasks, now).blockedBy[0]).toMatchObject({ word: 'in 2h' });
    expect(taskGraphView({ status: 'done', waits: [wait({})] }, tasks, now).blockedBy[0]).toMatchObject({ word: '' });
  });

  it('names the links, with a title when the task is held', () => {
    const view = taskGraphView({ found_during: 'ct-9', superseded_by: 'ct-50' }, tasks);
    expect(view.foundDuring).toEqual({ ref: 'ct-9', title: 'Ship it' });
    expect(view.supersededBy).toEqual({ ref: 'ct-50', title: undefined });
  });

  it('a ref the workspace rule refuses is nameless as well as unknown', () => {
    const outside = { b7: { _id: 'b7', short_id: 'ct-7', status: 'done', title: 'Someone else task', workspace: 'user:u2' } };
    const view = taskGraphView({ workspace: 'team:t1', blocked_by: ['ct-7'], found_during: 'ct-7' }, outside);
    // The status is unknown, so the title must be too: one line never mixes an
    // answer the graph refuses with one it gives.
    expect(view.blockedBy[0]).toEqual({ key: 'task:ct-7', kind: 'task', ref: 'ct-7', status: 'unknown', stateLabel: 'status unknown', title: undefined, cleared: false });
    expect(view.foundDuring).toEqual({ ref: 'ct-7', title: undefined });
  });

  it('a task with no graph has nothing to show', () => {
    expect(taskGraphView({}, tasks)).toEqual({ blockedBy: [], unblocked: true, foundDuring: null, supersededBy: null });
  });
  it('a live checks wait says why it is still waiting from the held PR row, red while its checks fail', () => {
    const checks = wait({ kind: 'pr_checks_green' });
    const prs = (state: string) => ({ p1: { _id: 'p1', repository: 'codecast-sh/codecast', number: 42, checks_state: state } });
    const pr = { repository: 'codecast-sh/codecast', number: 42 };
    expect(taskGraphView({ waits: [checks] }, tasks, 0, prs('failure')).blockedBy[0]).toMatchObject({ word: 'checks failing', pr, failing: true });
    expect(taskGraphView({ waits: [checks] }, tasks, 0, prs('pending')).blockedBy[0]).toEqual(expect.objectContaining({ word: 'checks running', pr }));
    expect(taskGraphView({ waits: [checks] }, tasks, 0, prs('pending')).blockedBy[0]).not.toHaveProperty('failing');
    // Before the PR row arrives the row still names the PR to feed and reads the pending word.
    expect(taskGraphView({ waits: [checks] }, tasks).blockedBy[0]).toMatchObject({ word: 'checks to go green', pr });
  });

  it('a checks wait that settled, or sits on a closed task, feeds no PR', () => {
    const met = taskGraphView({ waits: [wait({ kind: 'pr_checks_green', state: 'met' })] }, tasks).blockedBy[0];
    const closed = taskGraphView({ status: 'done', waits: [wait({ kind: 'pr_checks_green' })] }, tasks).blockedBy[0];
    expect(met).not.toHaveProperty('pr');
    expect(closed).not.toHaveProperty('pr');
  });

  it('a failed wait reads red while the task is open, as the web says it', () => {
    const failed = wait({ kind: 'pr_merged', state: 'failed' });
    expect(taskGraphView({ waits: [failed] }, tasks).blockedBy[0]).toMatchObject({ failing: true });
    expect(taskGraphView({ status: 'done', waits: [failed] }, tasks).blockedBy[0]).not.toHaveProperty('failing');
  });
});
