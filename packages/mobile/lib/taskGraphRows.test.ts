import { describe, expect, it } from 'bun:test';
import type { TaskWait } from '@codecast/shared/tasks';
import { taskGraphView } from './taskGraphRows';

const tasks = [
  { _id: 'a1', short_id: 'ct-1', status: 'done', title: 'Design the schema' },
  { _id: 'a3', short_id: 'ct-3', status: 'open', title: 'Build the API' },
  { _id: 'a9', short_id: 'ct-9', status: 'in_progress', title: 'Ship it' },
];
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
      { key: 'task:ct-77', kind: 'task', ref: 'ct-77', status: 'unknown', title: undefined, cleared: false },
      { key: 'wait:w1', kind: 'pr_merged', label: 'PR #42 merges', state: 'waiting', note: undefined, cleared: false },
      { key: 'wait:w2', kind: 'decision', label: 'sd-4 answered', state: 'met', note: 'answered: Ship it', cleared: true },
    ]);
  });

  it('a blocker named by its _id reads as its short id', () => {
    expect(taskGraphView({ blocked_by: ['a3'] }, tasks).blockedBy[0]).toMatchObject({ ref: 'ct-3', title: 'Build the API' });
  });

  it('a failed wait stays open and carries its note', () => {
    const [row] = taskGraphView({ waits: [wait({ state: 'failed', note: 'closed without merging' })] }, tasks).blockedBy;
    expect(row).toMatchObject({ state: 'failed', note: 'closed without merging', cleared: false });
  });

  it('names the links, with a title when the task is held', () => {
    const view = taskGraphView({ found_during: 'ct-9', superseded_by: 'ct-50' }, tasks);
    expect(view.foundDuring).toEqual({ ref: 'ct-9', title: 'Ship it' });
    expect(view.supersededBy).toEqual({ ref: 'ct-50', title: undefined });
  });

  it('a task with no graph has nothing to show', () => {
    expect(taskGraphView({}, tasks)).toEqual({ blockedBy: [], unblocked: true, foundDuring: null, supersededBy: null });
  });
});
