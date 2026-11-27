// The phone's priorities (app/priorities.tsx, app/priority/[id].tsx) cannot
// load under bun (React Native), so what they show and what their presses do
// are tested here, over the same models the screens build (web
// lib/priorityList buildModels).
import { describe, expect, it } from 'bun:test';
import { buildModels, lastDays, milestonesByState, sessionRowMark, sessionRowStatus } from '@codecast/web/lib/priorityList';
import { milestoneStartHref, type PriorityWrites } from '@codecast/web/lib/priorities';
import { parseComposeLink } from '@codecast/web/lib/composeLink';
import { buildSections, pageControls } from '@codecast/web/lib/prioritySections';
import {
  age, connectedOf, dayBar, dayLabel, groupBySheet, itemRows, milestoneMark, sectionItems, toggleHidden, workflowRef, milestoneMenu, milestoneSections, moveToItems, priorityMenu, sectionRuns, sessionLabel, sessionMenu, sessionTargets, startCompose,
} from './prioritiesList';
import { linkedCreateArgs, openCompose, useCompose } from './compose';

const NOW = Date.now();
const HOUR = 3_600_000;
const PLAN = { short_id: 'pl-60', title: 'The plan', done: 1, total: 4, size: 4 };
const BIG = { short_id: 'pl-9', title: 'The program', done: 61, total: 149, size: 149 };
const step = (key: string, title: string, over: Record<string, unknown> = {}) => ({ key, title, tier: 'critical' as const, tier_set_by: 'pass' as const, refs: [], done: false, ...over });
const session = (id: string, state: string, over: Record<string, unknown> = {}) => ({ short_id: id, conversation_id: `conv-${id}`, title: `Session ${id}`, state, mine: true, workflow: false, why: ['mapped' as const], last_active_at: NOW - HOUR, ...over });
const link = (key: string, sessions: unknown[] = [], over: Record<string, unknown> = {}) => ({ key, sessions, sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false, ...over });
const row = (over: Record<string, unknown> = {}) => ({
  _id: 'p7', short_id: 'pri-7', title: 'Priorities for Union', summary: '', status: 'active', rank: 2, person_pos: 2, ai_rank: 2, rank_source: 'person', serves: null,
  steps: [
    step('s1', 'Live behind a flag', { done: true, done_at: NOW - HOUR }),
    step('s2', 'Calibrate goal finding'),
    step('s3', 'Session mapping reaches 0.75'),
    step('s4', 'Priorities page redesign'),
    step('p1', 'Pill hover card', { tier: 'polish' }),
    step('p2', 'Notes are tidy', { tier: 'polish', done: true }),
  ],
  counts: { critical_done: 1, critical_total: 4 },
  workspace: 'team:t1', user_id: 'me', owner: 'Jason', mine: true, first_seen_at: NOW - 30 * HOUR, last_active_at: NOW, done_at: null,
  session_count: 3, session_count_more: false, sessions: [], correction_pending: false, plan: null,
  links: [
    link('s1'),
    link('s2', [session('a', 'needs_you'), session('w', 'working', { last_active_at: NOW })]),
    link('s3', [session('b', 'dormant')]),
    link('s4'),
    link('p1'),
    link('p2'),
  ],
  ...over,
}) as any;
/** `asking`: the conversations the sidebar files under Needs You (the inbox's live verdict); the rest keep the server's state. */
const model = (r: any, asking: string[] = []) => buildModels([r], undefined, (id) => (asking.includes(id) ? { mark: 'needs_you', asks: true, target: id } : undefined), lastDays(10, NOW))[0];
const ms = (r: any, key: string, asking: string[] = []) => model(r, asking).milestones.find((x) => x.key === key)!;

/** Every write a press makes, by name and arguments. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const writes = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => { calls.push([name, ...args]); } }) as PriorityWrites;
  return { calls, writes };
}
const noUi = { open: () => {}, rename: () => {}, moveTo: () => {}, mergeInto: () => {}, correct: () => {}, copyLink: () => {} };

describe("a milestone's mark", () => {
  it('needs you wins over working, and is the session to answer', () => {
    const mark = milestoneMark(ms(row(), 's2', ['conv-a']));
    expect(mark).toMatchObject({ kind: 'needs_you', session: { short_id: 'a' }, label: 'Needs you: Session a' });
  });

  it("an ask the sidebar does not file under Needs You is not one: the line shows what else is on it", () => {
    expect(milestoneMark(ms(row(), 's2'))).toEqual({ kind: 'quiet', status: 'working', label: 'Working' });
  });

  it('a sleeping session is a quiet moon; done is a check', () => {
    expect(milestoneMark(ms(row(), 's3'))).toEqual({ kind: 'quiet', status: 'dormant', label: 'Sleeping' });
    expect(milestoneMark(ms(row(), 's1'))).toEqual({ kind: 'quiet', status: 'done', label: 'Done' });
  });

  it('an open milestone nobody is on is New session, on a teammate\'s active priority as on the owner\'s', () => {
    expect(milestoneMark(ms(row(), 's4')).kind).toBe('start');
    expect(milestoneMark(ms(row({ mine: false, rank: 1 }), 's4')).kind).toBe('start');
  });

  it("someone else's ask reads Needs you, as the viewer's own would", () => {
    const theirs = row({ links: [link('s1'), link('s2', [session('a', 'needs_you', { mine: false })]), link('s3'), link('s4'), link('p1'), link('p2')] });
    expect(milestoneMark(ms(theirs, 's2')).kind).toBe('needs_you');
  });
});

describe('DONE and POLISH', () => {
  it('open critical milestones first, then Done n before Polish x/y', () => {
    const { open, sections } = milestoneSections(model(row()));
    expect(open.map((m) => m.key)).toEqual(['s2', 's3', 's4']);
    expect(sections.map((s) => [s.kind, s.label, s.count, s.rows.map((m) => m.key)])).toEqual([
      ['done', 'Done', '1', ['s1']],
      ['polish', 'Polish', '1/2', ['p1', 'p2']],
    ]);
  });

  it('needs you outranks done: a done milestone that asks sits with the open ones, and returns to Done once answered', () => {
    const asking = row({ links: [link('s1', [session('q', 'working')]), link('s2'), link('s3'), link('s4'), link('p1'), link('p2')] });
    const { open, sections } = milestoneSections(model(asking, ['conv-q']));
    expect(open.map((m) => m.key)).toEqual(['s1', 's2', 's3', 's4']);
    expect(open[0].state.kind).toBe('needs_you');
    expect(sections.map((s) => s.kind)).toEqual(['polish']);
    const answered = milestoneSections(model(asking));
    expect(answered.open.map((m) => m.key)).toEqual(['s2', 's3', 's4']);
    expect(answered.sections[0]).toMatchObject({ kind: 'done', count: '1', rows: [expect.objectContaining({ key: 's1' })] });
  });

  it('a polish milestone that needs you sits with the open ones, never folded, and still counts in Polish x/y', () => {
    const asking = row({ links: [link('s1'), link('s2'), link('s3'), link('s4'), link('p1', [session('pq', 'working')]), link('p2')] });
    const { open, sections } = milestoneSections(model(asking, ['conv-pq']));
    expect(open.map((m) => m.key)).toEqual(['s2', 's3', 's4', 'p1']);
    expect(sections.map((s) => [s.kind, s.count, s.rows.map((m) => m.key)])).toEqual([['done', '1', ['s1']], ['polish', '1/2', ['p2']]]);
    // Answered: it folds back.
    expect(milestoneSections(model(asking)).sections[1].rows.map((m) => m.key)).toEqual(['p1', 'p2']);
  });

  it('a priority with nothing done and no polish has no sections', () => {
    expect(milestoneSections(model(row({ steps: [step('s2', 'Calibrate goal finding')] }))).sections).toEqual([]);
  });

  it('closed sections share a line; an open one is its head over its milestones', () => {
    const { sections } = milestoneSections(model(row()));
    expect(sectionRuns(sections, new Set()).map((r) => [r.open, r.sections.map((s) => s.kind)])).toEqual([[false, ['done', 'polish']]]);
    expect(sectionRuns(sections, new Set(['done'])).map((r) => [r.open, r.sections.map((s) => s.kind)])).toEqual([[true, ['done']], [false, ['polish']]]);
    expect(sectionRuns(sections, new Set(['polish'])).map((r) => [r.open, r.sections.map((s) => s.kind)])).toEqual([[false, ['done']], [true, ['polish']]]);
  });
});

describe('an open milestone', () => {
  it('sorts sessions the way the sidebar files them and folds the closed ones', () => {
    const r = row({ links: [link('s1'), link('s2', [
      session('i', 'idle', { last_active_at: NOW }),
      session('k', 'killed'),
      session('w', 'working', { last_active_at: NOW - 3 * HOUR }),
      session('a', 'needs_you', { last_active_at: NOW - 5 * HOUR }),
      session('d', 'dormant'),
      session('f', 'done'),
    ], { sessions_more: 2 }), link('s3'), link('s4'), link('p1'), link('p2')] });
    const c = connectedOf(ms(r, 's2', ['conv-a']));
    expect(c.live.map((s) => s.short_id)).toEqual(['a', 'w', 'd', 'i']);
    expect(c.closed.map((s) => s.short_id).sort()).toEqual(['f', 'k']);
    expect(c.more).toBe(2);
  });

  it('closed sessions put the shipped first, each keeping the sidebar order; a shipped one draws done, its live state wins when it is live', () => {
    const r = row({ links: [link('s1'), link('s2', [
      session('k', 'killed', { last_active_at: NOW }),
      session('x', 'killed', { last_active_at: NOW - 2 * HOUR, shipped: true }),
      session('f', 'done', { last_active_at: NOW - 3 * HOUR }),
      session('w', 'working', { shipped: true }),
    ]), link('s3'), link('s4'), link('p1'), link('p2')] });
    const c = connectedOf(ms(r, 's2'));
    expect(c.closed.map((s) => s.short_id)).toEqual(['x', 'f', 'k']);
    expect(c.closed.map((s) => sessionRowStatus(s))).toEqual([{ mark: 'done', shipped: true }, { mark: 'done', shipped: false }, { mark: 'killed', shipped: false }]);
    expect(sessionRowStatus(c.live[0])).toEqual({ mark: 'working', shipped: false });
  });

  it("the priority's screen orders every milestone by state, critical before polish within one, done last", () => {
    const m = model(row(), ['conv-a']);
    expect(milestonesByState(m.milestones).map((x) => `${x.key}:${x.state.kind}`)).toEqual(['s2:needs_you', 's3:dormant', 's4:start', 'p1:start', 's1:done', 'p2:done']);
  });

  it("a session's row draws the mark its inbox draws (Done's check, the stash tray, an error) while the milestone reads it as idle", () => {
    const r = row({ links: [link('s1'), link('s2', [session('f', 'idle'), session('t', 'idle'), session('e', 'idle')]), link('s3'), link('s4'), link('p1'), link('p2')] });
    const drawn: Record<string, any> = { 'conv-f': 'done', 'conv-t': 'stashed', 'conv-e': 'error' };
    const m = buildModels([r], undefined, (id) => (drawn[id] ? { mark: drawn[id], asks: false, target: id } : undefined), lastDays(10, NOW))[0].milestones.find((x) => x.key === 's2')!;
    expect(m.state.kind).toBe('idle');
    const rows = Object.fromEntries(connectedOf(m).live.map((x) => [x.short_id, [x.state, sessionRowMark(x)]]));
    expect(rows).toEqual({ f: ['idle', 'done'], t: ['idle', 'stashed'], e: ['idle', 'error'] });
    // Not drawn: the row draws its own state.
    expect(sessionRowMark(ms(row(), 's3').sessions[0])).toBe('dormant');
  });

  it("an error the phone files under Needs You still needs you on the milestone, its row drawing the error", () => {
    const r = row({ links: [link('s1'), link('s2', [session('e', 'idle')]), link('s3'), link('s4'), link('p1'), link('p2')] });
    const m = buildModels([r], undefined, (id) => (id === 'conv-e' ? { mark: 'error' as const, asks: true, target: id } : undefined), lastDays(10, NOW))[0].milestones.find((x) => x.key === 's2')!;
    expect(milestoneMark(m)).toMatchObject({ kind: 'needs_you', session: { short_id: 'e' } });
    expect(sessionRowMark(m.sessions[0])).toBe('error');
  });

  it("a session riding its role's lead opens the lead: the Needs you mark and its row both carry the lead as their target", () => {
    const r = row({ links: [link('s1'), link('s2', [session('r', 'working')]), link('s3'), link('s4'), link('p1'), link('p2')] });
    const m = buildModels([r], undefined, (id) => (id === 'conv-r' ? { mark: 'needs_you' as const, asks: true, target: 'conv-lead' } : undefined), lastDays(10, NOW))[0].milestones.find((x) => x.key === 's2')!;
    const mark = milestoneMark(m);
    expect(mark).toMatchObject({ kind: 'needs_you', session: { short_id: 'r', target: 'conv-lead' } });
    expect(m.sessions[0].target).toBe('conv-lead');
    // Not drawn: its own conversation.
    expect(ms(row(), 's3').sessions[0].target).toBe('conv-b');
  });

  it("a session the phone does not draw whose own state asks reads idle, never sleeping", () => {
    const m = ms(row(), 's2');
    expect(m.sessions.find((x) => x.short_id === 'a')!.state).toBe('idle');
    expect(milestoneMark(m).kind).not.toBe('dormant');
  });

  it("names only its own plan and the big plans it is part of, never the priority's, on the list as on the screen (web parity)", () => {
    const r = row({ plan: PLAN, links: [link('s1'), link('s2', [], { part_of: [BIG] }), link('s3', [], { plan: { ...PLAN, short_id: 'pl-61' } }), link('s4'), link('p1'), link('p2')] });
    const m = model(r);
    const s2 = m.milestones.find((x) => x.key === 's2')!;
    expect(connectedOf(s2).plans).toEqual([{ plan: BIG, partOf: true }]);
    expect(connectedOf(m.milestones.find((x) => x.key === 's3')!).plans.map((p) => p.plan.short_id)).toEqual(['pl-61']);
    expect(connectedOf(m.milestones.find((x) => x.key === 's4')!).plans).toEqual([]);
  });

  it('carries its tasks and pull requests; an "Eval request:" task is an ordinary task', () => {
    const r = row({ steps: [step('s2', 'Work the open eval requests', { refs: [{ kind: 'task', id: 'ct-1' }, { kind: 'pr', id: 'acme/app#12' }] })], links: [link('s2')] });
    const c = connectedOf(model(r).milestones[0]);
    expect(c.tasks).toEqual(['ct-1']);
    expect(c.prs).toEqual(['acme/app#12']);
    expect(Object.keys(c).sort()).toEqual(['closed', 'live', 'more', 'plans', 'prs', 'tasks']);
  });

  it("a workflow step's session reads as what it works on, never its id", () => {
    expect(sessionLabel({ title: 'Review · ct-98544 tidy the list' }, (id) => (id === 'ct-98544' ? 'Tidy the priorities list' : undefined))).toBe('Review: Tidy the priorities list');
    expect(sessionLabel({ title: 'Review · ct-98544 tidy the list' })).toBe('Review: tidy the list');
    expect(sessionLabel({ title: 'Eval case scoping' })).toBe('Eval case scoping');
    expect(sessionLabel({ title: '' })).toBe('Untitled session');
  });

  it("names the task or plan a workflow step's session works on, and nothing for another title", () => {
    expect(workflowRef('Review · ct-98544 tidy the list')).toBe('ct-98544');
    expect(workflowRef('Ship · pl-12')).toBe('pl-12');
    expect(workflowRef('Eval case scoping')).toBeNull();
  });

  it('says how long ago', () => {
    expect(age(NOW - 6 * 60_000, NOW)).toBe('6m ago');
    expect(age(NOW, NOW)).toBe('just now');
  });
});

describe('ten days', () => {
  it('an empty day is a thin line; a busier one is taller and darker, capped at the shared peak', () => {
    expect(dayBar(0, 10, 20)).toEqual({ height: 2, opacity: 1 });
    const some = dayBar(2, 10, 20);
    const peak = dayBar(10, 10, 20);
    expect(some.height).toBeLessThan(peak.height);
    expect(some.opacity).toBeLessThan(peak.opacity);
    expect(peak).toEqual({ height: 20, opacity: 1 });
    expect(dayBar(40, 10, 20)).toEqual(peak);
  });

  it('labels a day by its date, today as Today', () => {
    expect(dayLabel('2026-11-07', false)).toBe('7');
    expect(dayLabel('2026-11-26', true)).toBe('Today');
  });
});

describe('the menus press web\'s writes', () => {
  const own = [row({ short_id: 'pri-1', rank: 1 }), row(), row({ short_id: 'pri-9', rank: 3 })];

  it("the owner's priority ⋯ renames, moves, closes, sets aside and corrects through the same writes", () => {
    const { calls, writes } = recorder();
    let renamed = false;
    const { title, items } = priorityMenu(row(), own, writes, { ...noUi, rename: () => { renamed = true; } });
    expect(title).toBe('#2 · you placed it');
    expect(items.map((i) => i.label)).toEqual(['Open', 'Rename', 'Move up', 'Move down', 'Move to #…', 'Mark done', 'Set aside', 'Merge into…', 'Correct…', 'Copy link']);
    for (const label of ['Rename', 'Move up', 'Move down', 'Mark done', 'Set aside']) items.find((i) => i.label === label)!.onPress();
    expect(renamed).toBe(true);
    expect(calls).toEqual([['move', 'pri-7', 'up'], ['move', 'pri-7', 'down'], ['markDone', 'pri-7'], ['setAside', 'pri-7']]);
  });

  it("on the priority's own screen there is no Open", () => {
    const { writes } = recorder();
    const { open: _open, ...screenUi } = noUi;
    expect(priorityMenu(row(), own, writes, screenUi).items.map((i) => i.label)).not.toContain('Open');
  });

  it("a teammate's priority ⋯ holds Open and Copy link alone", () => {
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

  it("a milestone's ⋯: Done or Undone, Rename, tier, Drop, Correct", () => {
    const { calls, writes } = recorder();
    const s = row().steps[1];
    const items = milestoneMenu(row(), s, writes, { rename: () => {}, drop: () => {}, correct: () => {} });
    expect(items.map((i) => i.label)).toEqual(['Done', 'Rename', 'Move to polish', 'Drop…', 'Correct…']);
    items[0].onPress();
    items[2].onPress();
    expect(calls).toEqual([['setStepDone', 'pri-7', 's2', true], ['setStepTier', 'pri-7', 's2', 'polish']]);
    expect(milestoneMenu(row(), row().steps[0], writes, { rename: () => {}, drop: () => {}, correct: () => {} })[0].label).toBe('Undone');
  });

  it("a session's ⋯ takes it off the milestone or the priority, or moves it", () => {
    const { calls, writes } = recorder();
    const items = sessionMenu(row(), { short_id: 'b', mine: true }, 's3', writes, { moveTo: () => {} })!;
    expect(items.map((i) => i.label)).toEqual(['Not this milestone', 'Not this priority', 'Move to…']);
    items[0].onPress();
    items[1].onPress();
    expect(calls).toEqual([['moveSession', 'b', 'pri-7', 'pri-7', null], ['sessionNotThis', 'b', 'pri-7']]);
  });

  it("either owner may unlink a session from a priority; only the owner of both moves it; nobody else gets a menu", () => {
    const { writes } = recorder();
    const noMove = { moveTo: () => {} };
    expect(sessionMenu(row({ mine: false }), { short_id: 'b', mine: true }, 's3', writes, noMove)!.map((i) => i.label)).toEqual(['Not this priority']);
    expect(sessionMenu(row(), { short_id: 'b', mine: false }, 's3', writes, noMove)!.map((i) => i.label)).toEqual(['Not this priority']);
    expect(sessionMenu(row({ mine: false }), { short_id: 'b', mine: false }, 's3', writes, noMove)).toBeNull();
    // A co-owned session (mine, started by someone else): the server refuses its unlink on a teammate's priority, so no menu.
    expect(sessionMenu(row({ mine: false }), { short_id: 'b', mine: true, started_by_viewer: false }, 's3', writes, noMove)).toBeNull();
    expect(sessionMenu(row(), { short_id: 'b', mine: true, started_by_viewer: false }, 's3', writes, noMove)!.map((i) => i.label)).toEqual(['Not this priority']);
  });

  it("a session moves to this priority's other open milestones (critical first), then the owner's others", () => {
    const targets = sessionTargets(row(), own, 's3').map((t) => `${t.priority.short_id}/${t.step.key}`);
    expect(targets.slice(0, 3)).toEqual(['pri-7/s2', 'pri-7/s4', 'pri-7/p1']);
    expect(targets).not.toContain('pri-7/s1');
    expect(targets).toContain('pri-1/s2');
    expect(targets).toContain('pri-9/s3');
  });
});

describe('New session', () => {
  it("seeds web's brief and links the session to the priority, milestone and plan at creation", () => {
    const r = row({
      steps: [step('s1', 'Priorities live behind a flag', { done: true }), step('s2', 'Calibrate goal finding', { refs: [{ kind: 'task', id: 'ct-9001' }, { kind: 'task', id: 'ct-9002' }] })],
      links: [link('s1'), link('s2', [], { plan: PLAN })],
    });
    const m = model(r).milestones[1];
    expect(milestoneMark(m).kind).toBe('start');
    const tasks: Record<string, { _id: string; title: string; status: string }> = { 'ct-9001': { _id: 'task-old', title: 'Old scorer', status: 'done' }, 'ct-9002': { _id: 'task-new', title: 'Write the scorer', status: 'open' } };
    const { seed, start, task } = startCompose(r, m, (id) => tasks[id]);
    expect(start).toEqual({ priority: 'pri-7', priority_step: 's2', plan: 'pl-60' });
    // The milestone's first open task is bound too, as web's binds it; never a finished one.
    expect(task).toEqual({ _id: 'task-new', short_id: 'ct-9002', title: 'Write the scorer', status: 'open' });
    // The sheet's create carries all of it: createSession's priority, priority_step, plan and the task as its linked object.
    expect(linkedCreateArgs(start, task)).toEqual({ priority: 'pri-7', priority_step: 's2', plan: 'pl-60', linked_object: { type: 'task', id: 'task-new' } });
    expect(linkedCreateArgs(null, null)).toEqual({});
    expect(seed).toBe('pri-7, milestone: Calibrate goal finding\nOpen tasks:\n- ct-9002 Write the scorer\nPlan: pl-60\nRun `cast priorities show pri-7` for current detail.');
    // Exactly what web's New session link carries.
    const web = parseComposeLink(new URL(milestoneStartHref(r, m, (id) => tasks[id]), 'https://app.test').searchParams)!;
    expect(web.draft).toBe(seed);
    expect([web.priority, web.step, web.plan]).toEqual([start.priority, start.priority_step, start.plan]);
    // The sheet opens with the brief and holds the link for its create.
    openCompose(seed, [], start, task);
    expect(useCompose.getState()).toMatchObject({ open: true, seed, start, task });
    openCompose('plain');
    expect(useCompose.getState().start).toBeNull();
    expect(useCompose.getState().task).toBeNull();
  });
});

describe('the list across workspaces', () => {
  // The viewer in Codecast (active) and Union, a teammate in both; one done priority of the viewer's in Codecast.
  const p = (short_id: string, workspace: string, user: 'me' | 'ashot', rank: number | null, over: Record<string, unknown> = {}) =>
    row({ _id: short_id, short_id, title: short_id, workspace, user_id: user, owner: user === 'me' ? 'Jason' : 'Ashot', mine: user === 'me', rank, person_pos: user === 'me' ? rank : null, ai_rank: rank, owner_image: user === 'ashot' ? 'https://x/ashot.png' : null, ...over });
  const rows = [
    p('u-me-1', 'team:union', 'me', 1),
    p('c-me-1', 'team:codecast', 'me', 1),
    p('c-me-2', 'team:codecast', 'me', 2),
    p('c-me-done', 'team:codecast', 'me', null, { status: 'done', done_at: NOW }),
    p('c-ash-1', 'team:codecast', 'ashot', 1),
    p('c-ash-2', 'team:codecast', 'ashot', 2),
    p('u-ash-1', 'team:union', 'ashot', 1),
  ];
  const workspaceNames = { 'team:codecast': 'Codecast', 'team:union': 'Union' };
  const opts = { activeWorkspace: 'team:union', hidden: [] as string[], workspaceNames };
  const layout = (groupBy: string, over: Partial<typeof opts> = {}, list = rows) => {
    const o = { ...opts, ...over };
    const controls = pageControls(list, o);
    return sectionItems(buildSections(list, { ...o, groupBy }), { headings: controls.showSectionHeadings, people: controls.showGroupBy });
  };
  const said = (items: ReturnType<typeof sectionItems>) => items.map((i) =>
    i.kind === 'heading' ? `${i.top ? '#' : '-'} ${i.name}${i.count != null ? ` ${i.count}` : ''}` : i.kind === 'fold' ? `fold ${i.rows.length}` : `${i.row.short_id}${i.face ? ' @' : ''}`);

  it('by default: the active workspace first, each person labelled inside it, the fold last in its group', () => {
    expect(said(layout('workspace_person'))).toEqual([
      '# Union 2', '- You', 'u-me-1', '- Ashot', 'u-ash-1',
      '# Codecast 4', '- You', 'c-me-1', 'c-me-2', 'fold 1', '- Ashot', 'c-ash-1', 'c-ash-2',
    ]);
  });

  it("Workspace grouping interleaves by rank, the viewer first within one, each with its owner's face", () => {
    expect(said(layout('workspace'))).toEqual([
      '# Union 2', 'u-me-1 @', 'u-ash-1 @',
      '# Codecast 4', 'c-me-1 @', 'c-ash-1 @', 'c-me-2 @', 'c-ash-2 @', 'fold 1',
    ]);
  });

  it('Person then workspace: a heading per person with their face, a label per workspace', () => {
    const items = layout('person_workspace');
    expect(said(items)).toEqual([
      '# You 3', '- Union', 'u-me-1', '- Codecast', 'c-me-1', 'c-me-2', 'fold 1',
      '# Ashot 3', '- Union', 'u-ash-1', '- Codecast', 'c-ash-1', 'c-ash-2',
    ]);
    const ashot = items.find((i) => i.kind === 'heading' && i.name === 'Ashot');
    expect(ashot).toMatchObject({ mark: { face: { owner_image: 'https://x/ashot.png' } } });
  });

  it('a hidden workspace leaves its section out; one workspace left draws no heading', () => {
    expect(said(layout('workspace_person', { hidden: ['team:union'] }))).toEqual(['- You', 'c-me-1', 'c-me-2', 'fold 1', '- Ashot', 'c-ash-1', 'c-ash-2']);
  });

  it('the viewer alone in one workspace: no heading, no person label', () => {
    expect(said(layout('workspace_person', {}, rows.filter((r) => r.mine && r.workspace === 'team:codecast')))).toEqual(['c-me-1', 'c-me-2', 'fold 1']);
  });

  it("a teammate's ranks read 1..n as the server numbered them", () => {
    const items = layout('workspace_person', { hidden: ['team:union'] }).filter((i) => i.kind === 'priority' && !i.row.mine);
    expect(items.map((i) => (i.kind === 'priority' ? i.row.rank : null))).toEqual([1, 2]);
  });

  it('every row the list draws, folded ones included, gets a model', () => {
    expect(itemRows(layout('workspace')).map((r) => r.short_id).sort()).toEqual(rows.map((r) => r.short_id).sort());
  });

  it('a chip press turns its workspace off, and back on', () => {
    expect(toggleHidden([], 'team:union')).toEqual(['team:union']);
    expect(toggleHidden(['team:union', 'user:me'], 'team:union')).toEqual(['user:me']);
  });

  it('Group by offers what the page allows, the current one checked, and a press on it changes nothing', () => {
    const chosen: string[] = [];
    const items = groupBySheet(pageControls(rows, opts).groupByOptions, 'workspace', (g) => chosen.push(g));
    expect(items.map((i) => `${i.label}${i.selected ? ' ✓' : ''}`)).toEqual(['Workspace, then person', 'Person, then workspace', 'Workspace ✓']);
    items[2].onPress();
    items[1].onPress();
    expect(chosen).toEqual(['person_workspace']);
  });

  it("a teammate's milestone reads from mapped_links: its real state, and Start on an open one", () => {
    const theirs = p('c-ash-9', 'team:codecast', 'ashot', 1, {
      links: undefined,
      mapped_links: [link('s1'), link('s2', [session('z', 'dormant', { mine: false })]), link('s3'), link('s4'), link('p1'), link('p2')],
    });
    expect(milestoneMark(ms(theirs, 's2'))).toEqual({ kind: 'quiet', status: 'dormant', label: 'Sleeping' });
    expect(milestoneMark(ms(theirs, 's4')).kind).toBe('start');
  });
});
