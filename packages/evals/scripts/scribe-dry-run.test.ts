// The dry run feeds Scribe what prod sends it: its end message is the one
// convex deliverRoutes builds when the call stops.
import { expect, test } from 'bun:test';
import { HUDDLE_REBRIEF_EVERY } from '@codecast/shared/contracts';
import { SCRIBE_ENDED, SCRIBE_REMINDER, scribeChunkHeader } from '@codecast/shared/contracts/scribePrompt';
import { endMessage } from './scribe-dry-run';

test("the call's end is prod's ended header, naming the call and its board", () => {
  const end = endMessage(3, 'cl-9');
  expect(end).toBe(scribeChunkHeader({ name: 'Scribe', lane: 'context', held: false, full: false, call: 'cl-9', board: 's97fakeboardscribeeval0000000001', ended: true }));
  expect(end).toContain(SCRIBE_ENDED);
  expect(end).toContain('The call is cl-9.');
  expect(end).not.toContain(SCRIBE_REMINDER);
});

test('an end that falls on a rebrief carries the brief, as prod does', () => {
  expect(endMessage(HUDDLE_REBRIEF_EVERY, 'cl-9')).toContain(SCRIBE_REMINDER);
});
