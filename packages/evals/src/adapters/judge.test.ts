import { describe, expect, test } from 'bun:test';

import type { ConvoMessage, Freeze } from '@platform/evals';

import anchorBrief from '../surfaces/anchorBrief';
import { criteriaCheck, judgeMomentOf, judgePrompt, judgeRuler, judgeText, PASS_AT, storedReply } from './judge';

const msg = (n: number, direction: 'in' | 'out', text: string): ConvoMessage => ({ n, id: `m${n}`, at: '2026-09-28T09:00:00.000Z', channel: 'session', isGroup: false, direction, from: direction === 'in' ? 'user' : 'assistant', text });
const freeze = { id: 'f1', name: 'anchor-brief case', judge: 'the reply keeps the reason to itself' } as Freeze;

describe('judge prompt', () => {
  test('frames the moment as context and grades against the check alone', () => {
    const p = judgePrompt(freeze, [msg(1, 'in', 'You are Fern.')], [msg(2, 'out', 'Done.')]);
    expect(p).toContain('## The moment, oldest first');
    expect(p).toContain('the check alone is the standard');
    expect(p).toContain('a command the reply names counts as that action taken');
    expect(p.indexOf('## The one check')).toBeGreaterThan(p.indexOf('## The reply'));
  });

  test('a stored prompt gives back the reply it graded, under either generation of headers', () => {
    const reply = ['First paragraph.', '', '`cast anchor say --dm mara "x"`'];
    expect(storedReply(judgeText('n', ['USER: hi', '## The reply', 'not this'], reply, 'c'))).toEqual(reply);
    expect(storedReply(judgeText('n', [], [], 'c'))).toEqual([]);
    const legacy = ['# A frozen moment: n', '', '## What the model was shown, oldest first', '', 'USER: hi', '', '## What it produced', '', 'hello', '', '## The one check', '', '- `criteria`: c'].join('\n');
    expect(storedReply(legacy)).toEqual(['hello']);
    expect(storedReply('no sections here')).toBeNull();
  });

  test('its ruler is the framing and the check: replies and moments share one, a new criterion or framing makes another', () => {
    const at = (reply: string[], criteria = 'c', moment = ['USER: hi']) => judgeRuler(judgeText('n', moment, reply, criteria));
    expect(at(['one'])).toBe(at(['two', 'lines']));
    // A fixture's moment is rendered by the prompt under test, so two arms of one comparison show the judge different moments.
    expect(at(['one'], 'c', ['USER: the variant briefing'])).toBe(at(['one']));
    expect(at(['one'], 'c2')).not.toBe(at(['one']));
    const legacy = ['# A frozen moment: n', '', '## What the model was shown, oldest first', '', 'USER: hi', '', '## What it produced', '', 'hello', '', '## The one check', '', '- `criteria`: c'].join('\n');
    expect(judgeRuler(legacy)).not.toBe(at(['hello']));
    expect(judgeRuler('no sections here')).toBeNull();
  });

  test("the criteria check takes its floor from the freeze as it stands, for a fresh rep and a rejudged one alike", () => {
    expect(criteriaCheck({ ...freeze, tags: [] }, { score: 0.5, reasoning: 'r' })).toEqual({ id: 'criteria', ask: freeze.judge!, weight: 1, score: 0.5, reasoning: 'r', must: null });
    expect(criteriaCheck({ ...freeze, tags: ['must'] }, { score: 0.5, reasoning: null }).must).toBe(PASS_AT);
  });
});

describe('the moment the judge reads', () => {
  const facts = { name: 'Fern', scopeType: 'team' as const, scopeLabel: 'the Fernhill team', teamName: 'Fernhill' };
  const fixture = { captured_at: '2026-09-28T09:00:00.000Z', world: 'fernhill', facts, turns: [{ text: 'Hi Fern, it is Theo.' }] };

  test("a fixture's judge reads who the agent is, the dry-run note and the turns, never the opening the builder renders", () => {
    const moment = judgeMomentOf(anchorBrief, fixture, fixture.captured_at);
    const shown = anchorBrief.describe(fixture);
    expect(moment.map((m) => m.text).join('\n')).not.toContain('## Judgment');
    expect(shown[0]!.text).toContain('## Judgment');
    expect(moment[0]!.text).toContain('Fern, the team workspace');
    expect(moment[0]!.text).toContain('Dry run (harness note)');
    expect(moment[1]!.text).toBe('Hi Fern, it is Theo.');
  });

  test("a real freeze's judge reads the opening prod sent", () => {
    const real = { captured_at: '2026-09-28T09:00:00.000Z', world: 'fernhill', opening: { text: 'the opening prod sent', at: '2026-09-28T08:00:00.000Z', line: 1 } };
    expect(judgeMomentOf(anchorBrief, real, real.captured_at)[0]!.text).toStartWith('the opening prod sent');
  });
});
