import { describe, expect, it } from 'bun:test';
import { priorityInboxView } from './inboxPriorities';
import { rankLabelWords } from '@codecast/web/store/priorityOrder';

// A priority the pass slotted at `ai_rank`; its rank is its place among its owner's active ones.
const priority = (_id: string, ai_rank: number, user_id = 'me', steps = ['s1', 's2']) => ({
  _id, ai_rank, person_pos: null, workspace: 'team:t1', last_active_at: 0, user_id, status: 'active' as const,
  steps: steps.map((key) => ({ key, title: key, tier: 'critical' as const, tier_set_by: 'pass' as const, refs: [], done: false })),
});
const PRIORITIES = {
  p1: priority('p1', 1),
  p2: priority('p2', 2),
  theirs: priority('theirs', 1, 'someone'),
};
const row = (_id: string, priority_id?: string, priority_step_key?: string) => ({ _id, priority_id, priority_step_key });

describe('priorityInboxView', () => {
  const view = priorityInboxView(PRIORITIES as any, 'me');

  it('sorts a section by rank, then milestone, the rest after in the order they had', () => {
    const rows = [
      row('none-a'),
      row('p2-s1', 'p2', 's1'),
      row('teammate', 'theirs', 's1'),
      row('p1-s2', 'p1', 's2'),
      row('elsewhere', 'not-loaded', 's1'),
      row('p1-s1', 'p1', 's1'),
      row('none-b'),
    ];
    expect(view.sort(rows).map((r) => r._id)).toEqual(['p1-s1', 'p1-s2', 'p2-s1', 'none-a', 'teammate', 'elsewhere', 'none-b']);
  });

  it("labels each row with its rank, 'other ws' for a priority not loaded here, else None", () => {
    // The phone is a touch screen: it shows the touch words, never a bare "—".
    const words = (r: ReturnType<typeof row>) => rankLabelWords(view.rankOf(r)).touch;
    expect(words(row('a', 'p1', 's2'))).toBe('#1');
    expect(words(row('b', 'p2', 's1'))).toBe('#2');
    expect(words(row('c', 'not-loaded', 's1'))).toBe('other ws');
    expect(words(row('d', 'theirs', 's1'))).toBe('None');
    expect(words(row('e'))).toBe('None');
  });

  it('places nothing without a viewer', () => {
    const anon = priorityInboxView(PRIORITIES as any, null);
    const rows = [row('x'), row('y', 'p1', 's1')];
    expect(anon.sort(rows).map((r) => r._id)).toEqual(['x', 'y']);
    expect(anon.rankOf(row('y', 'p1', 's1'))).toBeNull();
  });
});
