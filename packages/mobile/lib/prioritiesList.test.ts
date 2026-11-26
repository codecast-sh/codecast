// The phone's Priorities list (app/priorities.tsx) cannot load under bun
// (React Native), so what it shows and what its menus press are tested here,
// over the same models the screen builds (web lib/priorityList buildModels).
import { describe, expect, it } from 'bun:test';
import { buildModels, landedByDay, lastDays } from '@codecast/web/lib/priorityList';
import type { PriorityWrites } from '@codecast/web/lib/priorities';
import { lineTrail, milestoneMenu, momentumWords, moveToItems, priorityMenu, sessionMenu, sessionTargets, shownLines, statsWords } from './prioritiesList';

const NOW = Date.now();
const HOUR = 3_600_000;
const step = (key: string, title: string, over: Record<string, unknown> = {}) => ({ key, title, tier: 'critical' as const, tier_set_by: 'pass' as const, refs: [], done: false, ...over });
const session = (id: string, state: string, over: Record<string, unknown> = {}) => ({ short_id: id, conversation_id: `conv-${id}`, title: `Session ${id}`, state, mine: true, workflow: false, why: ['mapped' as const], last_active_at: NOW - HOUR, ...over });
const link = (key: string, sessions: unknown[] = []) => ({ key, sessions, sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false });
const row = (over: Record<string, unknown> = {}) => ({
  _id: 'p7', short_id: 'pri-7', title: 'Priorities for Union', summary: '', status: 'active', rank: 2, person_pos: 2, ai_rank: 2, rank_source: 'person', serves: null,
  steps: [
    step('s1', 'Live behind a flag', { done: true, done_at: NOW - HOUR }),
    step('s2', 'Calibrate goal finding'),
    step('s3', 'Session mapping reaches 0.75'),
    step('p1', 'Pill hover card', { tier: 'polish' }),
    step('p2', 'Notes are tidy', { tier: 'polish' }),
  ],
  counts: { critical_done: 1, critical_total: 3 },
  workspace: 'team:t1', user_id: 'me', owner: 'Jason', mine: true, first_seen_at: NOW - 30 * HOUR, last_active_at: NOW, done_at: null,
  session_count: 3, session_count_more: false, sessions: [], correction_pending: false, plan: null,
  links: [link('s1'), link('s2', [session('a', 'needs_you')]), link('s3', [session('b', 'dormant'), session('c', 'needs_you', { last_active_at: NOW - 2 * HOUR })]), link('p1'), link('p2', [session('d', 'needs_you', { last_active_at: NOW - 3 * HOUR })])],
  ...over,
}) as any;
const model = (r: any) => buildModels([r], undefined, () => undefined, lastDays(10, NOW), NOW)[0];

/** Every write a press makes, by name and arguments. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const writes = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => { calls.push([name, ...args]); } }) as PriorityWrites;
  return { calls, writes };
}
const noUi = { open: () => {}, moveTo: () => {}, mergeInto: () => {}, correct: () => {}, copyLink: () => {} };

describe('the phone Priorities list', () => {
  it('shows one line per open critical milestone, the done ones once progress is pressed', () => {
    const m = model(row());
    expect(shownLines(m, { done: false, polish: false }).critical.map((x) => x.key)).toEqual(['s2', 's3']);
    expect(shownLines(m, { done: true, polish: false }).critical.map((x) => x.key)).toEqual(['s2', 's3', 's1']);
  });

  it('keeps a collapsed polish line in sight when it asks the person, and opens the rest on Polish', () => {
    const m = model(row());
    expect(shownLines(m, { done: false, polish: false }).polish.map((x) => x.key)).toEqual(['p2']);
    expect(shownLines(m, { done: false, polish: true }).polish.map((x) => x.key)).toEqual(['p1', 'p2']);
  });

  it('puts the priority\'s one action on its line, and an outlined Answer or a state word on the others', () => {
    const m = model(row());
    // The most recently waiting session wins Answer: s2's, an hour ago, over s3's two hours ago.
    expect(m.action?.kind).toBe('answer');
    const trail = (key: string) => lineTrail(m, m.milestones.find((x) => x.key === key)!);
    expect(trail('s2')).toMatchObject({ kind: 'action' });
    expect(trail('s3')).toMatchObject({ kind: 'answer', session: { short_id: 'c' } });
    expect(trail('s1')).toBeNull();
    const calm = model(row({ links: [link('s1'), link('s2', [session('a', 'working')]), link('s3', [session('b', 'dormant')]), link('p1'), link('p2')] }));
    expect(lineTrail(calm, calm.milestones.find((x) => x.key === 's3')!)).toEqual({ kind: 'state', word: 'Dormant' });
  });

  it('offers a teammate\'s priority no action at all', () => {
    const m = model(row({ mine: false, rank: null }));
    expect(m.action).toBeNull();
    expect(lineTrail(m, m.milestones.find((x) => x.key === 's2')!)?.kind).not.toBe('action');
  });

  it('says the stats line as web\'s phone layout does', () => {
    const days = lastDays(10, NOW);
    const landed = landedByDay([row()], days);
    expect(statsWords(landed, days, { total: 12, topPct: 50 })).toEqual({ landed: 1, today: '50% top 3 today' });
    expect(statsWords(landed, days, { total: 0, topPct: 0 }).today).toBeNull();
  });

  it('says momentum, and stalled in place of how long since', () => {
    expect(momentumWords({ landed10: 3, lastLandedDays: 2, stalledDays: null })).toBe('3 landed · last 2d');
    expect(momentumWords({ landed10: 0, lastLandedDays: null, stalledDays: null })).toBe('0 landed · none yet');
    expect(momentumWords({ landed10: 0, lastLandedDays: 9, stalledDays: 9 })).toBe('0 landed · stalled 9d');
  });
});

describe('the list\'s menus press web\'s writes', () => {
  const own = [row({ short_id: 'pri-1', rank: 1 }), row(), row({ short_id: 'pri-9', rank: 3 })];

  it('the owner\'s priority ⋯ moves, closes, sets aside and corrects through the same writes', () => {
    const { calls, writes } = recorder();
    const { title, items } = priorityMenu(row(), own, writes, noUi);
    expect(title).toBe('#2 · you placed it');
    expect(items.map((i) => i.label)).toEqual(['Open', 'Move up', 'Move down', 'Move to #…', 'Mark done', 'Set aside', 'Merge into…', 'Correct…', 'Copy link']);
    for (const label of ['Move up', 'Move down', 'Mark done', 'Set aside']) items.find((i) => i.label === label)!.onPress();
    expect(calls).toEqual([['move', 'pri-7', 'up'], ['move', 'pri-7', 'down'], ['markDone', 'pri-7'], ['setAside', 'pri-7']]);
  });

  it('a teammate\'s priority ⋯ holds Open and Copy link alone', () => {
    const { writes } = recorder();
    expect(priorityMenu(row({ mine: false, rank: null }), [], writes, noUi).items.map((i) => i.label)).toEqual(['Open', 'Copy link']);
  });

  it('a set-aside priority offers Restore, not Set aside or a move', () => {
    const { writes } = recorder();
    const labels = priorityMenu(row({ status: 'set_aside', rank: null }), own, writes, noUi).items.map((i) => i.label);
    expect(labels).toContain('Restore');
    expect(labels).not.toContain('Set aside');
    expect(labels).not.toContain('Move up');
  });

  it('Move to #… lists every place, the current one marked and a no-op', () => {
    const { calls, writes } = recorder();
    const items = moveToItems(row(), own, writes);
    expect(items.map((i) => [i.label, !!i.selected])).toEqual([['#1', false], ['#2', true], ['#3', false]]);
    items[1].onPress();
    items[0].onPress();
    expect(calls).toEqual([['move', 'pri-7', 1]]);
  });

  it('a milestone\'s ⋯: Done, Rename, tier, Drop, Correct', () => {
    const { calls, writes } = recorder();
    const s = row().steps[1];
    const items = milestoneMenu(row(), s, writes, { rename: () => {}, drop: () => {}, correct: () => {} });
    expect(items.map((i) => i.label)).toEqual(['Done', 'Rename', 'Move to polish', 'Drop…', 'Correct…']);
    items[0].onPress();
    items[2].onPress();
    expect(calls).toEqual([['setStepDone', 'pri-7', 's2', true], ['setStepTier', 'pri-7', 's2', 'polish']]);
    expect(milestoneMenu(row(), row().steps[0], writes, { rename: () => {}, drop: () => {}, correct: () => {} })[0].label).toBe('Undone');
  });

  it('a session\'s ⋯ takes it off the milestone or the priority, or moves it', () => {
    const { calls, writes } = recorder();
    const items = sessionMenu(row(), { short_id: 'b' }, 's3', writes, { moveTo: () => {} });
    expect(items.map((i) => i.label)).toEqual(['Not this milestone', 'Not this priority', 'Move to…']);
    items[0].onPress();
    items[1].onPress();
    expect(calls).toEqual([['moveSession', 'b', 'pri-7', 'pri-7', null], ['sessionNotThis', 'b', 'pri-7']]);
  });

  it('a session moves to this priority\'s other open milestones (critical first), then the owner\'s others', () => {
    const targets = sessionTargets(row(), own, 's3').map((t) => `${t.priority.short_id}/${t.step.key}`);
    expect(targets.slice(0, 3)).toEqual(['pri-7/s2', 'pri-7/p1', 'pri-7/p2']);
    expect(targets).not.toContain('pri-7/s1');
    expect(targets).toContain('pri-1/s2');
    expect(targets).toContain('pri-9/s3');
  });
});
