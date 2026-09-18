// The org chart as the rows of one list. Web lays the same branches out on a
// canvas (orgLayout.ts measure + place); a phone reads them top to bottom, so
// the hierarchy comes from web's buildBranches and only the walk is ours: a
// parent, its own sessions, then each child indented one level.
import { buildBranches, type OrgLayoutView } from '@codecast/web/components/org/orgLayout';
import type { OrgAnchor, OrgPerson, OrgRole, OrgSession, OrgTree } from '@codecast/web/components/org/orgTypes';

type Branch = ReturnType<typeof buildBranches>[number];

export type OrgRow =
  | { key: string; depth: number; kind: 'person'; person: OrgPerson; collapsed: boolean; hidden: number }
  | { key: string; depth: number; kind: 'role'; role: OrgRole; tenure?: string; collapsed: boolean; hidden: number }
  | { key: string; depth: number; kind: 'anchor'; anchor: OrgAnchor }
  | { key: string; depth: number; kind: 'session'; session: OrgSession }
  /** The sessions a parent has beyond the ones drawn. `loaded` of them are in
   *  the tree's payload already and open on a tap; the rest are not on the phone. */
  | { key: string; depth: number; kind: 'more'; parentId: string; remaining: number; loaded: number; opened: boolean };

export function orgRows(tree: OrgTree, view: OrgLayoutView): OrgRow[] {
  const out: OrgRow[] = [];
  const walk = (b: Branch, depth: number) => {
    if (b.kind === 'person') out.push({ key: b.id, depth, kind: 'person', person: b.person!, collapsed: b.collapsed, hidden: b.hidden });
    else if (b.kind === 'role') out.push({ key: b.id, depth, kind: 'role', role: b.role!, tenure: b.tenure?.short, collapsed: b.collapsed, hidden: b.hidden });
    else out.push({ key: b.id, depth, kind: 'anchor', anchor: b.anchor! });
    if (b.stack) {
      for (const s of b.stack.sessions) out.push({ key: `${b.id}/${s._id}`, depth: depth + 1, kind: 'session', session: s });
      const opened = b.id in view.expanded;
      const held = (b.kind === 'person' ? b.person!.sessions : b.role!.sessions).length;
      const remaining = b.stack.total - b.stack.sessions.length;
      if (remaining > 0 || opened) {
        out.push({ key: `${b.id}/more`, depth: depth + 1, kind: 'more', parentId: b.id, remaining, loaded: Math.max(0, held - b.stack.sessions.length), opened });
      }
    }
    for (const c of b.children) walk(c, depth + 1);
  };
  for (const b of buildBranches(tree, view)) walk(b, 0);
  return out;
}
