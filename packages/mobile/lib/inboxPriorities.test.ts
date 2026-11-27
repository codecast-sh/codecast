import { describe, expect, it } from 'bun:test';
import { priorityInboxSig, priorityInboxView } from './inboxPriorities';
import { rankTitle, workspaceMarkOf } from '@codecast/web/store/priorityOrder';
import { resolveInboxViewMode } from '@codecast/web/store/inboxStore';

// The phone's inbox, lens bar and drawer read the view through the same resolver as the web.
describe('the inbox view mode on the phone', () => {
  it('reads a stored Priorities view as the grouped one where the workspace has Priorities off', () => {
    const at = (priorities: boolean) => ({
      teams: [{ _id: 't1', features: { priorities } }],
      clientState: { ui: { inbox_view_mode: 'priorities' as const, active_team_id: 't1' } },
    });
    expect(resolveInboxViewMode(at(true))).toBe('priorities');
    expect(resolveInboxViewMode(at(false))).toBe('grouped');
  });
});

// A priority the pass slotted at `ai_rank`; its rank is its place among its owner's active ones.
const priority = (_id: string, ai_rank: number, user_id = 'me', steps = ['s1', 's2']) => ({
  _id, short_id: `pri-${_id}`, title: `${_id} title`, ai_rank, person_pos: null, workspace: 'team:t1', last_active_at: 0, user_id, status: 'active' as const,
  steps: steps.map((key) => ({ key, title: key, tier: 'critical' as const, tier_set_by: 'pass' as const, refs: [], done: false })),
});
const PRIORITIES = {
  p1: priority('p1', 1),
  p2: priority('p2', 2),
  theirs: priority('theirs', 1, 'someone'),
};
// The viewer's personal #1, in another workspace than the active team t1.
const RANKS = { personal: { _id: 'personal', workspace: 'user:me', rank: 1, short_id: 'pri-9', title: 'Personal goal' } };
const row = (_id: string, priority_id?: string, priority_step_key?: string) => ({ _id, priority_id, priority_step_key });
const state = (viewer: string | null = 'me', sessions: Record<string, ReturnType<typeof row>> = {}) => ({
  priorities: PRIORITIES as any, priorityRanks: RANKS, sessions, currentUser: viewer ? { _id: viewer } : null, clientState: { ui: { active_team_id: 't1' } },
});

describe('priorityInboxView', () => {
  const view = priorityInboxView(state());

  it("sorts a section by this workspace's rank and milestone, then other workspaces' ranks, the rest after in the order they had", () => {
    const rows = [
      row('none-a'),
      row('p2-s1', 'p2', 's1'),
      row('teammate', 'theirs', 's1'),
      row('personal', 'personal', 's1'),
      row('p1-s2', 'p1', 's2'),
      row('not-loaded', 'not-loaded', 's1'),
      row('p1-s1', 'p1', 's1'),
      row('none-b'),
    ];
    expect(view.sort(rows).map((r) => r._id)).toEqual(['p1-s1', 'p1-s2', 'p2-s1', 'personal', 'none-a', 'teammate', 'not-loaded', 'none-b']);
  });

  it('labels a ranked row with its rank, title and other workspace, and every other row with nothing', () => {
    expect(view.rankOf(row('a', 'p1', 's2'))).toEqual({ rank: 1, workspace: null, shortId: 'pri-p1', title: 'p1 title' });
    expect(view.rankOf(row('b', 'p2', 's1'))).toEqual({ rank: 2, workspace: null, shortId: 'pri-p2', title: 'p2 title' });
    const personal = view.rankOf(row('c', 'personal'))!;
    expect(personal).toEqual({ rank: 1, workspace: 'user:me', shortId: 'pri-9', title: 'Personal goal' });
    expect(rankTitle(personal, workspaceMarkOf(personal.workspace!, [], 'me'))).toBe('Your priority #1: Personal goal in your personal workspace');
    expect(view.rankOf(row('d', 'not-loaded', 's1'))).toBeNull();
    expect(view.rankOf(row('e', 'theirs', 's1'))).toBeNull();
    expect(view.rankOf(row('f'))).toBeNull();
  });

  it("outside the Priorities view labels off the live ranks, never a cached row: no stale rank or title, no retired priority", () => {
    // The phone feeds `priorities` only while the Priorities view is up, so elsewhere its rows can be old.
    const live = { ...RANKS, p1: { _id: 'p1', workspace: 'team:t1', rank: 3, short_id: 'pri-p1', title: 'Renamed since' } };
    const elsewhere = priorityInboxView({ ...state(), priorityRanks: live }, false);
    expect(elsewhere.rankOf(row('a', 'p1', 's1'))).toEqual({ rank: 3, workspace: null, shortId: 'pri-p1', title: 'Renamed since' });
    // p2 is cached but no longer among the live ranks (retired): no tag.
    expect(elsewhere.rankOf(row('b', 'p2', 's1'))).toBeNull();
    // In the Priorities view the fed rows win, so a move paints at once.
    expect(priorityInboxView({ ...state(), priorityRanks: live }, true).rankOf(row('a', 'p1', 's1'))).toEqual({ rank: 1, workspace: null, shortId: 'pri-p1', title: 'p1 title' });
  });

  it("names a team's workspace by the team and its icon", () => {
    expect(workspaceMarkOf('team:t2', [{ _id: 't2', name: 'Union', icon: 'flame', icon_color: 'orange' }], 'me')).toEqual({ personal: false, name: 'Union', icon: 'flame', color: 'orange' });
  });

  it("wakes on a session's priority link, so a moved session re-sorts", () => {
    const before = { a: row('a', 'p2', 's1'), b: row('b', 'p1', 's1') };
    const after = { ...before, a: row('a', 'p1', 's1'), b: row('b', 'p2', 's1') };
    const sig = (sessions: Record<string, ReturnType<typeof row>>) => priorityInboxSig(state('me', sessions));
    expect(sig(after)).not.toBe(sig(before));
    // A field the order does not read leaves it asleep.
    expect(sig({ ...before, a: { ...before.a, title: 'renamed' } as any })).toBe(sig(before));
    // A renamed priority wakes it: the tags name it.
    const renamed = { ...state('me', before), priorities: { ...PRIORITIES, p1: { ...PRIORITIES.p1, title: 'Renamed' } } as any };
    expect(priorityInboxSig(renamed)).not.toBe(sig(before));
    expect(view.sort(Object.values(before)).map((r) => r._id)).toEqual(['b', 'a']);
    expect(view.sort(Object.values(after)).map((r) => r._id)).toEqual(['a', 'b']);
  });

  it('labels rows in every view but sorts only in the Priorities view', () => {
    // Outside the Priorities view labels come off the live ranks (see the cached-row case above).
    const labelsOnly = priorityInboxView({ ...state(), priorityRanks: { ...RANKS, p1: { _id: 'p1', workspace: 'team:t1', rank: 1, short_id: 'pri-p1', title: 'p1 title' } } }, false);
    const rows = [row('none'), row('p2-s1', 'p2', 's1'), row('p1-s1', 'p1', 's1')];
    expect(labelsOnly.sort(rows)).toBe(rows);
    expect(labelsOnly.rankOf(row('a', 'p1'))?.rank).toBe(1);
  });

  it('places nothing without a viewer', () => {
    const anon = priorityInboxView(state(null));
    const rows = [row('x'), row('y', 'p1', 's1')];
    expect(anon.sort(rows).map((r) => r._id)).toEqual(['x', 'y']);
    expect(anon.rankOf(row('y', 'p1', 's1'))).toBeNull();
  });
});
