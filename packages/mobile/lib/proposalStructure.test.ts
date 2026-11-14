import { describe, expect, test } from 'bun:test';
import { ORG_FIXTURE } from '@codecast/web/components/org/orgFixture';
import type { OrgChange, OrgProposalChange } from '@codecast/web/components/org/orgStaffingTypes';
import { looksAfter, structureOf } from './proposalStructure';

let seq = 0;
const change = (c: OrgChange, status: OrgProposalChange['status'] = 'proposed'): OrgProposalChange => ({ _id: `chg-${++seq}`, proposal_id: 'p', seq, change: c, rationale: 'because', evidence: [], status });

describe('structureOf', () => {
  test('a new role reads under the parent it will report to, with what it looks after', () => {
    const [s] = structureOf(ORG_FIXTURE, [change({ kind: 'role', name: 'Head of Platform', handle: 'platform', reports_to: 'me', scope: { projects: ['Platform'] } })]);
    expect([s.kind, s.role.handle, s.before, s.after, s.accepted]).toEqual(['new', 'platform', null, 'Ashot Petrosian', false]);
    expect(looksAfter(s.role)).toBe('Platform');
  });

  test('a move names who the role reports to before and after; a retire names who it reported to', () => {
    const moved = structureOf(ORG_FIXTURE, [change({ kind: 'move', handle: 'growth', reports_to: 'Samvit Jain' })]);
    expect(moved.map((s) => [s.kind, s.role.handle, s.before, s.after])).toEqual([['move', 'growth', 'Ashot Petrosian', 'Samvit Jain']]);
    const retired = structureOf(ORG_FIXTURE, [change({ kind: 'retire', handle: 'growth' })]);
    expect(retired.map((s) => [s.kind, s.before, s.after])).toEqual([['retire', 'Ashot Petrosian', null]]);
  });

  test('new roles lead, and a skipped change draws nothing', () => {
    const rows = structureOf(ORG_FIXTURE, [
      change({ kind: 'retire', handle: 'growth' }),
      change({ kind: 'role', name: 'Ops lead', handle: 'ops', reports_to: 'me' }),
      change({ kind: 'role', name: 'Skipped', handle: 'skipped', reports_to: 'me' }, 'skipped'),
    ]);
    expect(rows.map((s) => s.role.handle)).toEqual(['ops', 'growth']);
  });

  test('a resolved proposal still says what it changed, read off the live tree', () => {
    const rows = structureOf(ORG_FIXTURE, [
      change({ kind: 'hire', handle: 'growth', template: 'eng-lead' } as unknown as OrgChange, 'applied'),
      change({ kind: 'scope', handle: 'growth', add: ['fixture-project-growth'] }, 'applied'),
      change({ kind: 'trust', handle: 'nobody', trust: 'direct' } as unknown as OrgChange, 'applied'),
    ]);
    expect(rows.map((s) => [s.kind, s.role.handle, s.accepted, s.after])).toEqual([['new', 'growth', true, 'Ashot Petrosian']]);
    expect(rows[0].notes).toHaveLength(1);
    expect(rows[0].notes[0]).toContain('Growth');
    expect(rows[0].notes[0]).not.toContain('fixture-project-growth');
  });
});
