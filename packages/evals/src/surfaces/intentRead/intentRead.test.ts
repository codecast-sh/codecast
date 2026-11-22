// The intent-read surface replays the Read station exactly as a run posts it,
// and reads its answer the way the segment and the server do.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseWorkflowSource } from '../../../../cli/src/workflow/parser';
import { BUILTIN_WORKFLOW_TEMPLATES } from '../../../../cli/src/workflow/templates';
import { fixturesDir } from '../../paths';
import impl, { answerOf, intentReadRequest, outcomeOf, type IntentReadSnap } from './index';
import { INTENT_READ_MODEL, meta } from './meta';

const fixture = (name: string) => JSON.parse(readFileSync(join(fixturesDir(), 'intent-read', `${name}.json`), 'utf-8'));
const answer = (o: Record<string, unknown>) => JSON.stringify({ ship: true, session: 'jx7a001', line: 115, quote: 'Yes, ship this', in_scope: true, why: 'They said ship.', ...o });

describe('intent-read', () => {
  test("runs on the station's own model and max_tokens, and its prompt is the station's with this moment's record", () => {
    const node = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.intent!).nodes.get('read')!;
    expect(INTENT_READ_MODEL).toBe(node.model!);
    expect(meta.model).toBe(node.model!);
    const snap: IntentReadSnap = fixture('ship-then-revise').snapshot;
    const req = intentReadRequest(snap);
    expect(req).toMatchObject({ model: node.model, max_tokens: node.max_tokens });
    expect(req.prompt).toContain('The person who started this run is Dana.');
    expect(req.prompt).toContain('[jx7a001:115] 2026-11-21 17:18Z Dana (typed_composer): Yes, ship this and shepherd it into production.');
    expect(req.prompt).toContain("[sd-2001] 2026-11-21 19:02Z Dana answered Revise on this task's Ship card: The Mine toggle hides");
    expect(req.prompt).toContain(`The change (${snap.change.files} files, +${snap.change.added} -${snap.change.removed})`);
    expect(req.prompt).not.toMatch(/\$(asker|change|task_)/);
  });

  test("a clear needs the segment's edge and the server's citation check: the line, its quote, and no later Revise", () => {
    const plain: IntentReadSnap = fixture('plain-ship').snapshot;
    expect(outcomeOf(plain, answerOf(answer({})))).toMatchObject({ clears: true });
    expect(outcomeOf(plain, answerOf(answer({ ship: false })))).toMatchObject({ clears: false });
    expect(outcomeOf(plain, answerOf(answer({ in_scope: false })))).toMatchObject({ clears: false });
    expect(outcomeOf(plain, answerOf(answer({ line: 116 })))).toMatchObject({ clears: false });
    expect(outcomeOf(plain, answerOf(answer({ quote: 'ship everything now' })))).toMatchObject({ clears: false });
    expect(outcomeOf(fixture('ship-then-revise').snapshot, answerOf(answer({})))).toMatchObject({ clears: false, why: expect.stringContaining('sd-2001 answered Revise') });
    expect(answerOf('I think they wanted it shipped.')).toBeNull();
    expect(answerOf('```json\n' + answer({}) + '\n```')).toMatchObject({ ship: true });
  });

  test('every fixture carries a label the gates grade by, and the gates pass the right answer and fail the wrong one', () => {
    for (const name of readdirSync(join(fixturesDir(), 'intent-read')).map((f) => f.replace(/\.json$/, ''))) {
      const f = fixture(name);
      expect(typeof f.label.clears).toBe('boolean');
      const right = answer(f.label.clears ? {} : { ship: false, session: '', line: 0, quote: '' });
      const wrong = answer(f.label.clears ? { ship: false } : {});
      const grade = (text: string) => {
        const a = answerOf(text);
        return impl.gates(f.snapshot, { reply: text, parsed: { answer: a, outcome: outcomeOf(f.snapshot, a) }, calls: [], agents: [] }, f.label);
      };
      expect({ name, pass: grade(right).every((g) => g.pass) }).toEqual({ name, pass: true });
      expect({ name, pass: grade(wrong).every((g) => g.pass) }).toEqual({ name, pass: false });
    }
  });
});
