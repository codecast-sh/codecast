import { describe, expect, test } from 'bun:test';
import { flatViewSessions, type InboxSession } from '@codecast/web/store/inboxStore';
import { flatAllItems } from './inboxListItems';

const NOW = 1_700_000_000_000;
const id = (tag: string) => tag.padEnd(32, '0');
const PARENT = id('parent');
const TASK = id('task');
const OWNED = id('owned');
const OTHER = id('other');
const row = (_id: string, extra: Record<string, unknown> = {}): InboxSession => ({
  _id,
  session_id: `s-${_id.slice(0, 6)}`,
  user_id: 'me',
  agent_type: 'claude_code',
  title: _id,
  message_count: 6,
  started_at: NOW - 3_600_000,
  updated_at: NOW - 60_000,
  is_idle: true,
  has_pending: false,
  ...extra,
}) as InboxSession;

// A listed card with a Task subagent and a child its session owns, both
// drawn under it in A card each, and a card of its own below.
const parent = row(PARENT, { owners_model: true, owned_by_me: true, updated_at: NOW - 1_000 });
const task = row(TASK, { is_subagent: true, parent_conversation_id: PARENT, updated_at: NOW - 2_000 });
const owned = row(OWNED, { is_subagent: true, parent_conversation_id: PARENT, owners_model: true, owned_by_me: false, owner_session_id: PARENT, updated_at: NOW - 3_000 });
const other = row(OTHER, { updated_at: NOW - 30_000 });
const subsByParent = new Map([[PARENT, [task, owned]]]);
const flat = flatViewSessions([parent, task, other], subsByParent, { mode: 'recent', showSubagents: true, keepSub: () => true });

describe("the phone's flat All run", () => {
  test('lists the subagents under their card', () => {
    expect(flat.map((s) => s._id)).toEqual([PARENT, OWNED, TASK, OTHER]);
  });

  test('marks each row hoisted under its listed card as drawn there', () => {
    const rows = flatAllItems(flat, subsByParent, { collapsed: false, meId: 'me' }).flatMap((item) => (item.kind === 'row' ? [[item.session._id, !!item.underParent] as const] : []));
    expect(rows).toEqual([[PARENT, false], [OWNED, true], [TASK, true], [OTHER, false]]);
  });

  test('a child its session owns adds to no count, as the grouped headers and web leave it out', () => {
    const [header] = flatAllItems(flat, subsByParent, { collapsed: false, meId: 'me' });
    expect(header).toMatchObject({ kind: 'header', section: 'all', label: 'All', count: 3 });
  });

  test('with its card off the list, the open child stands as a card of its own and counts', () => {
    const alone = flatViewSessions([owned, other], subsByParent, { mode: 'recent', showSubagents: false, focusedId: OWNED });
    const items = flatAllItems(alone, subsByParent, { collapsed: false, meId: 'me' });
    expect(items[0]).toMatchObject({ kind: 'header', count: 2 });
    expect(items.some((item) => item.kind === 'row' && item.underParent)).toBe(false);
  });

  test('collapsed, the run is its header alone', () => {
    expect(flatAllItems(flat, subsByParent, { collapsed: true, meId: 'me' }).map((item) => item.kind)).toEqual(['header']);
  });
});
