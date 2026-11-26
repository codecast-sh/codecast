// The phone's half of subagents on inbox cards. The states, the filter and
// their order are web's (store subagentRowsOf), so the phone and the rail agree on
// every subagent; the phone has no menu and follows the rail's prefs.
// No React Native here: lib/subagentLine.test.ts loads it under bun.
import { SESSION_STATUS } from '@codecast/web/lib/sessionStatus';
import { subagentStateGroups, type SubagentStateGroup } from '@codecast/web/lib/subagentRows';
import { standingRoleIdOf } from '@codecast/web/lib/sessionIdentity';
import { subagentRowsOf, type InboxSession, type SubagentFilter, type SubagentRowsMode } from '@codecast/web/store/inboxStore';

/** Whether cards draw the folded line. Folded and Compact rows draw it. Full
 *  rows list subagents as rows of their own in the flat views (Updated,
 *  Created); the grouped view and the lenses nest none on the phone, so there
 *  Full keeps the line rather than show less than Folded. Hidden draws nothing. */
export function drawsSubagentLine(mode: SubagentRowsMode, flatView: boolean): boolean {
  if (mode === 'hidden') return false;
  return !(mode === 'full' && flatView);
}

const groupsSig = (groups: readonly SubagentStateGroup[]) =>
  groups.map((g) => `${g.status}:${g.count}:${g.newest._id}`).join('|');

/** Each card's folded line: its subagents and the workers waiting on the
 *  person, one group per state the filter keeps, most urgent first. Only
 *  parents with a line are in the map, never a role lead's card. A parent's
 *  array from `prev` is reused while it draws the same line, so a memoized row
 *  does not re-render for an unchanged line. */
export function subagentLines(
  childrenByParent: readonly ReadonlyMap<string, readonly InboxSession[]>[],
  parentOf: (id: string) => InboxSession | undefined,
  now: number,
  filter: SubagentFilter,
  prev?: ReadonlyMap<string, SubagentStateGroup[]>,
): Map<string, SubagentStateGroup[]> {
  const children = new Map<string, InboxSession[]>();
  for (const byParent of childrenByParent)
    for (const [id, subs] of byParent) children.set(id, [...(children.get(id) ?? []), ...subs]);
  const out = new Map<string, SubagentStateGroup[]>();
  for (const [id, subs] of children) {
    const parent = parentOf(id);
    if (!parent || standingRoleIdOf(parent as any)) continue;
    const groups = subagentStateGroups(subagentRowsOf(subs, now, filter));
    if (groups.length === 0) continue;
    const old = prev?.get(id);
    out.set(id, old && groupsSig(old) === groupsSig(groups) ? old : groups);
  }
  return out;
}

/** A count's words, for screen readers: "2 subagents working". */
export function subagentGroupWords(g: Pick<SubagentStateGroup, 'status' | 'count'>): string {
  return `${g.count} ${g.count === 1 ? 'subagent' : 'subagents'} ${SESSION_STATUS[g.status].word.toLowerCase()}`;
}
