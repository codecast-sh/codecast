// The org structure an open proposal changes, one row per role it touches:
// a role it adds, moves or retires, its reporting line before and after, and
// the rest of what it changes there. Read off the web's ghost plan
// (orgGhostsFor), the model the org chart draws a proposal's ghosts from.
// Pure, so it is tested without React Native.
import { changeLine, editedOrgChange, isOrgQuietChange } from '@codecast/shared/contracts/orgProposal';
import { ghostsFor, withScopeNames, type OrgGhostOptions } from '@codecast/web/components/org/orgGhostsFor';
import { roleNodeId } from '@codecast/web/components/org/orgLayout';
import { parentName } from '@codecast/web/components/org/orgMeta';
import type { OrgProposalChange } from '@codecast/web/components/org/orgStaffingTypes';
import type { OrgRole, OrgTree } from '@codecast/web/components/org/orgTypes';

export type Shift = { key: string; role: OrgRole; kind: 'new' | 'move' | 'retire' | 'change'; accepted: boolean; before: string | null; after: string | null; notes: string[] };

/** The structure a proposal changes, one row per role it touches: its reporting line before and after, and the rest
 *  of what it changes there. `scope`: the store's projects and plans, so a proposed role's scope reads by name. */
export function structureOf(tree: OrgTree, changes: readonly OrgProposalChange[], scope: Pick<OrgGhostOptions, 'projects' | 'plans'> = {}): Shift[] {
  const plan = ghostsFor(tree, changes, scope);
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
  // What already landed: the ghost plan draws only what waits, so an applied
  // change reads off the live tree, by the role its apply resolved (else the handle it names).
  const live = new Map(tree.roles.map((r) => [roleNodeId(r._id), r]));
  for (const c of changes) {
    if (c.status !== 'applied' && c.status !== 'accepted') continue;
    const ch = editedOrgChange(c.change, c.edits);
    if (isOrgQuietChange(ch)) continue;
    const subject = c.applied_diff?.find((d) => d.subject?.short_id?.startsWith('or-'))?.subject.short_id;
    const handle = 'handle' in ch && typeof ch.handle === 'string' ? ch.handle.replace(/^@/, '').toLowerCase() : null;
    const role = tree.roles.find((r) => (subject && r.short_id === subject) || (!!handle && r.handle.toLowerCase() === handle));
    if (!role) continue;
    const nodeId = roleNodeId(role._id);
    if (!byNode.has(nodeId)) byNode.set(nodeId, live.get(nodeId)!);
    const kind = ch.kind === 'role' || ch.kind === 'hire' ? 'new' : ch.kind === 'move' ? 'move' : ch.kind === 'retire' ? 'retire' : 'change';
    const s = shift(nodeId, kind, true);
    if (!s) continue;
    s.accepted = true;
    if (kind === 'new' || kind === 'move') s.after = parentName(tree, role.reports_to);
    if (kind === 'change') s.notes.push(changeLine(withScopeNames(ch, tree, scope)));
  }
  const order = { new: 0, move: 1, retire: 2, change: 3 };
  return [...out.values()].sort((a, b) => order[a.kind] - order[b.kind]);
}

/** What a role looks after: the projects and plans in its scope, else its charter's first line. */
export function looksAfter(role: OrgRole): string | null {
  const names = [...role.scope_names.projects.map((p) => p.title), ...role.scope_names.plans.map((p) => p.title || p.short_id)];
  if (names.length) return names.join(', ');
  return (role.charter ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? null;
}
