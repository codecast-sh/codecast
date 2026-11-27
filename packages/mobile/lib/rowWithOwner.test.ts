import { beforeEach, expect, test } from 'bun:test';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { rowWithOwnerLabel } from './rowWithOwner';

const LEAD = 'l'.repeat(32);
const KID = 'k'.repeat(32);
const ME = 'u_me';
const lead = { _id: LEAD, session_id: LEAD, title: 'Ship the cards', user_id: ME, updated_at: Date.now(), message_count: 9, owners_model: true, owned_by_me: true };
// A Claude Code subagent its lead owns, in the viewer's store with the lead's
// card (the inbox read sends it stamped owner_session_id, owned_by_me false).
const child = (over: Record<string, unknown> = {}) => ({
  _id: KID, session_id: KID, title: 'Explore the rail', user_id: ME, message_count: 4,
  owners_model: true, owned_by_me: false, is_subagent: true,
  parent_conversation_id: LEAD, owner_session_id: LEAD, ...over,
});

beforeEach(() => {
  useInboxStore.setState({
    currentUser: { _id: ME, name: 'Alex Rivera' }, sessionOwners: {}, sessionDecisions: {},
    sessionsWithQueuedMessages: new Set(), pendingMessages: {}, conversations: {},
  } as any);
});

const labelOf = (row: Record<string, unknown>, place: { placedBucket?: string; underParent?: boolean } = { underParent: true }) => {
  useInboxStore.setState({ sessions: { [LEAD]: lead, [KID]: row } } as any);
  return rowWithOwnerLabel(useInboxStore.getState(), row as never, place, Date.now());
};

test('a finished owned subagent drawn under its lead reads Done, as web\'s nested card does: no "With <lead>"', () => {
  expect(labelOf(child({ status: 'completed', is_idle: true, updated_at: Date.now() - 3 * 3600_000 }))).toBeNull();
});

test('an owned subagent still producing reads Working "With <lead>"', () => {
  expect(labelOf(child({ status: 'active', is_idle: false, updated_at: Date.now() }))).toBe('Ship the cards');
});

// Standing as its own row (an escalated wait seats it, or its lead is off the
// list), it reads where the list placed it, never the nested Done/Working.
test('an owned subagent standing as its own row reads its placement', () => {
  expect(labelOf(child({ status: 'active', is_idle: false, updated_at: Date.now() }), { placedBucket: 'needs_input' })).toBeNull();
  expect(labelOf(child({ status: 'completed', is_idle: true, updated_at: Date.now() - 3 * 3600_000 }), {})).toBe('Ship the cards');
});

