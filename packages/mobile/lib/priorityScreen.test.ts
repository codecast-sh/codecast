// The phone's priority screen (app/priority/[id].tsx) cannot load under bun
// (React Native), so its words and its box's press are tested here, over the
// same models the screen builds (web lib/priorityList buildModels).
import { describe, expect, it } from 'bun:test';
import { buildModels, lastDays } from '@codecast/web/lib/priorityList';
import { correctionDraft, milestoneBox, nextWords, ownerWords, standing, startCompose } from './priorityScreen';
import { linkedCreateArgs, openCompose, useCompose } from './compose';
import { milestoneStartHref } from '@codecast/web/lib/priorities';
import { parseComposeLink } from '@codecast/web/lib/composeLink';

const NOW = Date.now();
const HOUR = 3_600_000;
const step = (key: string, title: string, done = false) => ({ key, title, tier: 'critical' as const, tier_set_by: 'pass' as const, refs: [], done, ...(done ? { done_at: NOW - HOUR } : {}) });
const asking = { short_id: 'jx7ask1', conversation_id: 'conv-ask', title: 'Priorities feature build', state: 'needs_you' as const, mine: true, workflow: false, why: ['mapped' as const], last_active_at: NOW - HOUR };
const link = (key: string, sessions: unknown[] = []) => ({ key, sessions, sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false });
const row = (over: Record<string, unknown> = {}) => ({
  _id: 'p7', short_id: 'pri-7', title: 'Priorities for Union', summary: '', status: 'active', rank: 7, person_pos: null, ai_rank: 7, rank_source: 'ai', serves: null,
  steps: [step('s1', 'Priorities live behind a flag', true), step('s2', 'Calibrate goal finding')], counts: { critical_done: 1, critical_total: 2 },
  workspace: 'team:t1', user_id: 'me', owner: 'Jason', mine: true, first_seen_at: NOW - 30 * HOUR, last_active_at: NOW, done_at: null,
  session_count: 1, session_count_more: false, sessions: [], correction_pending: false, plan: null,
  links: [link('s1'), link('s2', [asking])],
  ...over,
}) as any;
const model = (r: any) => buildModels([r], undefined, () => undefined, lastDays(10, NOW), NOW)[0];

describe('the phone priority screen', () => {
  it('Correct…: a cancelled correction is never saved by a later Save on an empty box', () => {
    const draft = correctionDraft();
    draft.type('Calibration belongs elsewhere');
    draft.cancel();
    expect(draft.take()).toBeNull();
    // What was typed after reopening is what saves, once.
    draft.type('  Notes are polish  ');
    expect(draft.take()).toBe('Notes are polish');
    expect(draft.take()).toBeNull();
  });

  it('says the rank once with who placed it, and names a teammate who placed it only once', () => {
    expect(standing(row())).toBe('#7 · ranked by AI');
    expect(ownerWords(row())).toBe('You');
    const placedByThem = row({ mine: false, owner: 'Sarah Chen', rank: 1, rank_source: 'person' });
    expect(standing(placedByThem)).toBe('#1 · Sarah Chen placed it');
    // A teammate's active priority carries no rank: it says nothing, never "Set aside".
    expect(standing(row({ mine: false, owner: 'Sarah Chen', rank: null }))).toBeNull();
    expect(ownerWords(placedByThem)).toBeNull();
    expect(standing(row({ status: 'set_aside', rank: null }))).toBe('Set aside');
  });

  it('Next is Answer on the session that asks, in its words', () => {
    const next = nextWords(model(row()).action!);
    expect(next).toEqual({ title: 'Calibrate goal finding', verb: 'Answer', answer: true, session: 'in Priorities feature build' });
  });

  it("the owner's box toggles Done either way; a teammate's is a mark with nothing to press", () => {
    const m = model(row()).milestones;
    expect(milestoneBox(row(), m[1])).toEqual({ kind: 'toggle', writes: true, label: 'Mark Calibrate goal finding done' });
    expect(milestoneBox(row(), m[0])).toEqual({ kind: 'toggle', writes: false, label: 'Mark Priorities live behind a flag not done' });
    const theirs = row({ mine: false, owner: 'Sarah Chen' });
    expect(milestoneBox(theirs, model(theirs).milestones[0])).toEqual({ kind: 'mark', label: 'Done' });
    // A teammate's priority offers no action at all.
    expect(model(theirs).action).toBeNull();
  });

  it("Start seeds web's brief and links the session to the priority, milestone and plan at creation", () => {
    const PLAN = { short_id: 'pl-60', title: 'The plan', done: 1, total: 4, size: 4 };
    const r = row({
      steps: [step('s1', 'Priorities live behind a flag', true), { ...step('s2', 'Calibrate goal finding'), refs: [{ kind: 'task', id: 'ct-9001' }, { kind: 'task', id: 'ct-9002' }] }],
      links: [link('s1'), { ...link('s2'), plan: PLAN }],
    });
    const m = model(r).milestones[1];
    const tasks: Record<string, { _id: string; title: string; status: string }> = { 'ct-9001': { _id: 'task-old', title: 'Old scorer', status: 'done' }, 'ct-9002': { _id: 'task-new', title: 'Write the scorer', status: 'open' } };
    const { seed, start, task } = startCompose(r, m, (id) => tasks[id]);
    expect(start).toEqual({ priority: 'pri-7', priority_step: 's2', plan: 'pl-60' });
    // The milestone's first open task is bound too, as web's Start binds it; never a finished one.
    expect(task).toEqual({ _id: 'task-new', short_id: 'ct-9002', title: 'Write the scorer', status: 'open' });
    // The sheet's create carries all of it: createSession's priority, priority_step, plan and the task as its linked object.
    expect(linkedCreateArgs(start, task)).toEqual({ priority: 'pri-7', priority_step: 's2', plan: 'pl-60', linked_object: { type: 'task', id: 'task-new' } });
    expect(linkedCreateArgs(null, null)).toEqual({});
    expect(seed).toBe('pri-7, milestone: Calibrate goal finding\nOpen tasks:\n- ct-9002 Write the scorer\nPlan: pl-60\nRun `cast priorities show pri-7` for current detail.');
    // Exactly what web's Start link carries.
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
