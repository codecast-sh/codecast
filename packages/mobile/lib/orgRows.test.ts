import { describe, expect, test } from 'bun:test';
import { orgRows } from './orgRows';
import { EMPTY_COUNTS, type OrgRole, type OrgSession, type OrgTree } from '@codecast/web/components/org/orgTypes';

const session = (id: string, over: Partial<OrgSession> = {}): OrgSession => ({
  _id: id, short_id: id, title: id, agent_type: 'claude_code', state: 'working', updated_at: 1, subagent_count: 0, is_anchor: false, ...over,
});
const role = (id: string, reports_to: OrgRole['reports_to'], sessions: OrgSession[] = [], total = sessions.length): OrgRole => ({
  _id: id, short_id: id, scope_type: 'team', host_user_id: 'u1', name: id, handle: id, scope: { project_ids: [], plan_ids: [] },
  reports_to, status: 'active', created_by: 'u1', created_at: 0, updated_at: 0, counts: { ...EMPTY_COUNTS }, sessions, total,
  scope_names: { projects: [], plans: [] },
});
const tree = (roles: OrgRole[], mine: OrgSession[] = []): OrgTree => ({
  workspace: { kind: 'team', id: 't1', name: 'Team' },
  people: [{ user_id: 'u1', name: 'Ada', role: 'admin', is_me: true, counts: { ...EMPTY_COUNTS }, sessions: mine, total: mine.length }],
  roles, anchors: [], generated_at: 0,
});
const open = { collapsed: new Set<string>(), expanded: {} };

describe('orgRows', () => {
  test('a parent, its sessions, then its roles, each one level in', () => {
    const rows = orgRows(tree([role('lead', { kind: 'user', user_id: 'u1' }), role('hand', { kind: 'role', role_id: 'lead' })], [session('s1')]), open);
    expect(rows.map((r) => `${r.depth}:${r.kind}`)).toEqual(['0:person', '1:session', '1:role', '2:role']);
  });

  test('a folded role hides its subtree and counts it', () => {
    const rows = orgRows(tree([role('lead', { kind: 'user', user_id: 'u1' }, [session('s1')]), role('hand', { kind: 'role', role_id: 'lead' })]), { collapsed: new Set(['role:lead']), expanded: {} });
    expect(rows.map((r) => r.kind)).toEqual(['person', 'role']);
    expect(rows[1]).toMatchObject({ collapsed: true, hidden: 2 });
  });

  test('past five sessions the rest fold into one row that says what a tap opens', () => {
    const eight = Array.from({ length: 8 }, (_, i) => session(`s${i}`));
    const t = tree([role('lead', { kind: 'user', user_id: 'u1' }, eight, 20)]);
    const more = orgRows(t, open).find((r) => r.kind === 'more');
    expect(more).toMatchObject({ remaining: 15, loaded: 3, opened: false });
    const opened = orgRows(t, { collapsed: new Set(), expanded: { 'role:lead': [] } });
    expect(opened.filter((r) => r.kind === 'session')).toHaveLength(8);
    expect(opened.find((r) => r.kind === 'more')).toMatchObject({ remaining: 12, loaded: 0, opened: true });
  });
});
