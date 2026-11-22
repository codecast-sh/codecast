import { describe, expect, test } from 'bun:test';
import { dmKeyFor, sessionDmKeyFor } from '@codecast/shared/chat';
import { dmRoomName } from '@codecast/web/lib/chatViews';

// The chat screen and the thread screen name a DM by dmRoomName over the
// channel row, as every web surface does. An agent's DM to
// one person names one party for that person and for the session's owner
// (ct-79021), never two names.
const ME = { _id: 'u-owner', name: 'Ashot Petrosian' };
const ALICE = { _id: 'u-alice', name: 'Alice Ng' };
const BOT = { _id: 'u-bot', name: 'Head of Growth', is_bot: true, bot_kind: 'anchor' };
const roster = [ME, ALICE, BOT];
const nameFor = (key: string, viewer: string, name = '') => dmRoomName({ name, dm_key: key }, viewer, roster);

describe('a DM from an agent reads as one-to-one on the phone', () => {
  test("a plain session's own room: the session, for Alice and for its owner", () => {
    const key = sessionDmKeyFor('t1', [ALICE._id], 'conv-1');
    expect(nameFor(key, ALICE._id, 'Deal desk')).toBe('Deal desk');
    expect(nameFor(key, ME._id, 'Deal desk')).toBe('Deal desk');
  });

  test("a role's room (its standing session or a session working for it): the role, for Alice and for its host", () => {
    const key = dmKeyFor('t1', [BOT._id, ALICE._id]);
    expect(nameFor(key, ALICE._id)).toBe('Head of Growth');
    expect(nameFor(key, ME._id)).toBe('Head of Growth');
  });

  test('a group the role named its host into still lists its people', () => {
    const key = dmKeyFor('t1', [BOT._id, ALICE._id, ME._id]);
    expect(nameFor(key, ALICE._id)).toBe('Head, Ashot');
  });
});
