import { describe, expect, test } from 'bun:test';

import { gradeGoalTree, type GoalTreeLabel } from './goalTree';

// A synthetic workspace: one mission already set, two projects, a plan in no project.
const inputs = {
  projects: [
    { id: 'p1', short_id: 'pj-buy', title: 'Buy budget' },
    { id: 'p2', short_id: 'pj-calls', title: 'Cold calls' },
  ],
  coverage: { initiatives: [{ short_id: 'in-1', title: 'Every listing finds its buyer', parent: undefined, projects: [] }] },
};
const label: GoalTreeLabel = {
  goals: [
    { id: 'mission', match: ['finds its buyer'], existing: 'in-1' },
    { id: 'fee', match: ['expected fee'], parent: 'mission' },
    { id: 'calls', match: ['cold call'], parent: 'mission', number: true },
  ],
  place: { 'pl-9': ['fee'], 'pj-calls': ['calls'] },
};
const ch = (change: any) => ({ change });

describe('the goal tree a review proposes', () => {
  test('a tree that places every stated goal under its parent and all live work under a goal it serves grades clean', () => {
    const t = gradeGoalTree([
      ch({ kind: 'initiative', title: 'Rank the buy budget by expected fee', parent: 'in-1', projects: ['pj-buy'] }),
      ch({ kind: 'initiative', title: 'Cold calls that convert', parent: 'Every listing finds its buyer', projects: ['Cold calls'], metrics: [{ name: 'meetings', target: '10/week' }] }),
      ch({ kind: 'file', plan: 'pl-9', project: 'Buy budget' }),
    ], inputs, label);
    expect(t).toEqual({ found: ['mission', 'fee', 'calls'], expected: 3, missing: [], parents: { right: ['fee', 'calls'], wrong: [] }, invented: [], third_level: [], self_made_targets: [], placed: { right: ['pl-9 under Rank the buy budget by expected fee', 'pj-calls under Cold calls that convert'], wrong: [], missed: [] } });
  });

  test('a missing goal, an invented one with a made up number, a third level and unplaced work are each named', () => {
    const t = gradeGoalTree([
      ch({ kind: 'initiative', title: 'Rank by expected fee', parent: 'in-1', projects: [] }),
      ch({ kind: 'initiative', title: 'Lower churn', parent: 'Rank by expected fee', projects: ['pj-calls'], metrics: [{ name: 'churn', target: '2%' }] }),
    ], inputs, label);
    expect(t.missing).toEqual(['calls']);
    expect(t.invented).toEqual(['Lower churn']);
    expect(t.self_made_targets).toEqual(['Lower churn']);
    expect(t.third_level).toEqual(['Lower churn']);
    expect(t.placed).toEqual({ right: [], wrong: ['pj-calls under Lower churn'], missed: ['pl-9'] });
  });

  test('an optional goal left out is no miss, and one proposed is matched', () => {
    const opt: GoalTreeLabel = { ...label, goals: [...label.goals, { id: 'extra', match: ['marketplace'], optional: true }] };
    expect(gradeGoalTree([], inputs, opt).missing).toEqual(['fee', 'calls']);
    expect(gradeGoalTree([ch({ kind: 'initiative', title: 'Marketplace reach', parent: 'in-1', projects: [] })], inputs, opt).found).toContain('extra');
  });

  test('an existing goal reached through initiative_projects places its work, and a shape change moves its parent', () => {
    const t = gradeGoalTree([
      ch({ kind: 'initiative', title: 'Expected fee', projects: [] }),
      ch({ kind: 'initiative_shape', initiative: 'Expected fee', parent: 'in-1', title: 'Expected fee' }),
      ch({ kind: 'initiative_projects', initiative: 'Expected fee', projects: ['pj-buy'], title: 'Expected fee' }),
      ch({ kind: 'file', plan: 'pl-9', project: 'pj-buy' }),
    ], inputs, label);
    expect(t.parents.right).toEqual(['fee']);
    expect(t.placed.right).toEqual(['pl-9 under Expected fee']);
  });
});
