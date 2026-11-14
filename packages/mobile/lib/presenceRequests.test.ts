import { expect, test } from 'bun:test';
import { ownChallenges, pickPresenceRequest, type PresenceRequest } from './presenceRequests';

const row = (id: string, expires_at = 2_000): PresenceRequest => ({ challenge_id: id, action: 'approve', label: 'stripe-live for jx7ana1', from: 'MacBook-Pro-2', expires_at });

test('the newest pending request another device opened, skipping this phone\'s own, set-aside and expired ones', () => {
  ownChallenges.add('own');
  expect(pickPresenceRequest([row('own'), row('a'), row('b')], new Set(), 1_000)?.challenge_id).toBe('a');
  expect(pickPresenceRequest([row('a'), row('b')], new Set(['a']), 1_000)?.challenge_id).toBe('b');
  expect(pickPresenceRequest([row('a', 500)], new Set(), 1_000)).toBeNull();
  expect(pickPresenceRequest(undefined, new Set(), 1_000)).toBeNull();
  ownChallenges.clear();
});
