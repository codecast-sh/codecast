// The org structure an open proposal changes, one row per role it touches:
// a role it adds, moves or retires, its reporting line before and after, and
// the rest of what it changes there. Read off the web's ghost plan
// (orgGhostsFor), the model the org chart draws a proposal's ghosts from.
// Pure, so it is tested without React Native.
import { ghostsFor } from '@codecast/web/components/org/orgGhostsFor';
import { roleNodeId } from '@codecast/web/components/org/orgLayout';
import { parentName } from '@codecast/web/components/org/orgMeta';
import type { OrgProposalChange } from '@codecast/web/components/org/orgStaffingTypes';
import type { OrgRole, OrgTree } from '@codecast/web/components/org/orgTypes';

export type Shift = { key: string; role: OrgRole; kind: 'new' | 'move' | 'retire' | 'change'; accepted: boolean; before: string | null; after: string | null; notes: string[] };

/** The structure a proposal changes, one row per role it touches: its reporting line before and after, and the rest of what it changes there. */
export function structureOf(tree: OrgTree, changes: readonly OrgProposalChange[]): Shift[] {
  const plan = ghostsFor(tree, changes);
  const m = plan.merged;
  const byNode = new Map(m.roles.map((r) => [roleNodeId(r._id), r]));
  const out = new Map<string, Shift>();
  const shift = (nodeId: string, kind: Shift['kind'], accepted = false): Shift | null => {
    const role = byNode.get(nodeId);
    if (!role) return null;
    const s = out.get(nodeId) ?? { key: nodeId, role, kind, accepted, before: null, after: null, notes: [] };
    if (kind !== 'change') s.kind = kind;
    out.set(nodeId, s);
    return s;
  };
  for (const [nodeId, stub] of Object.entries(plan.stubs)) {
    if (stub.kind !== 'role') continue;
    const s = shift(nodeId, 'new', stub.solid);
    if (s) s.after = parentName(m, s.role.reports_to);
  }
  for (const mv of plan.moves) {
    const s = shift(mv.nodeId, 'move');
    if (s) { s.before = parentName(m, mv.from); s.after = parentName(m, mv.to); }
  }
  for (const nodeId of Object.keys(plan.retires)) {
    const s = shift(nodeId, 'retire');
    if (s) s.before = parentName(m, s.role.reports_to);
  }
  for (const [nodeId, chips] of Object.entries(plan.chips)) {
    const s = shift(nodeId, 'change');
    if (s) s.notes.push(...chips.filter((c) => c.kind !== 'move').map((c) => c.line));
  }
  const order = { new: 0, move: 1, retire: 2, change: 3 };
  return [...out.values()].sort((a, b) => order[a.kind] - order[b.kind]);
}

/** What a role looks after: the projects and plans in its scope, else its charter's first line. */
export function looksAfter(role: OrgRole): string | null {
  const names = [...role.scope_names.projects.map((p) => p.title), ...role.scope_names.plans.map((p) => p.short_id ?? p.title)];
  if (names.length) return names.join(', ');
  return (role.charter ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? null;
}
