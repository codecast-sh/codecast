// The phone's half of subagents on inbox cards. The states, the filter and
// their order are web's (lib/subagentRows), so the phone and the rail agree on
// every subagent; the phone has no menu and follows the rail's prefs.
// No React Native here: lib/subagentLine.test.ts loads it under bun.
import { SESSION_STATUS } from '@codecast/web/lib/sessionStatus';
import { subagentPasses, subagentRowsOf, subagentStateGroups, subagentStatusOf, type SubagentStateGroup } from '@codecast/web/lib/subagentRows';
import { standingRoleIdOf } from '@codecast/web/lib/sessionIdentity';
import type { InboxSession, SubagentFilter, SubagentRowsMode } from '@codecast/web/store/inboxStore';

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

/** Full rows in a flat view: the hoisted subagents the filter drops leave the
 *  list; the open one always stays. */
export function filterHoistedSubagents(
  list: readonly InboxSession[],
  subsByParent: ReadonlyMap<string, readonly InboxSession[]>,
  now: number,
  filter: SubagentFilter,
  focusedId: string | null | undefined,
): InboxSession[] {
  if (filter === 'all') return [...list];
  const nested = new Set<string>();
  for (const subs of subsByParent.values()) for (const s of subs) nested.add(s._id);
  return list.filter((s) => !nested.has(s._id) || s._id === focusedId || subagentPasses(subagentStatusOf(s, now), filter));
}

/** A count's words, for screen readers: "2 subagents working". */
export function subagentGroupWords(g: Pick<SubagentStateGroup, 'status' | 'count'>): string {
  return `${g.count} ${g.count === 1 ? 'subagent' : 'subagents'} ${SESSION_STATUS[g.status].word.toLowerCase()}`;
}
