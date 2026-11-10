import { describe, expect, test } from 'bun:test';

import { CALL_MODEL, PROD_DEFAULT_MODEL, PROSE_MODEL, STRONG_MODEL } from '../models';
import { surfaces } from '../registry';
import { CHECKS, modelPinsCheck, prodCallModel } from './doctor';

// The "model pins" check: it passes on the tree as committed and names a call
// surface whose pin leaves the model prod calls.

describe('doctor: model pins', () => {
  test('passes on every registered surface', async () => {
    const check = CHECKS.find((c) => c.name === 'model pins')!;
    const result = await check.run();
    expect(result.detail).toStartWith('call surfaces pin the models prod calls');
    expect(result.ok).toBe(true);
  });

  test('each call surface is held to the model its prod call uses', () => {
    expect(prodCallModel('title')).toBe(CALL_MODEL);
    expect(prodCallModel('changes-story')).toBe(PROSE_MODEL);
    expect(prodCallModel('ground')).toBe(STRONG_MODEL);
    expect(prodCallModel('decide')).toBe(PROD_DEFAULT_MODEL);
    expect(prodCallModel('review-note')).toBe(PROD_DEFAULT_MODEL);
  });

  test('fails, naming the surface, when a call surface pins another model', () => {
    for (const id of ['title', 'ground', 'decide', 'changes-edition']) {
      const wrong = surfaces().map((s) => (s.id === id ? { ...s, model: 'some-other-model' } : s));
      const result = modelPinsCheck(wrong);
      expect(result.ok).toBe(false);
      expect(result.detail).toBe(`off their prod model: ${id}=some-other-model, prod calls ${prodCallModel(id)}`);
    }
  });

  test('an agent surface is not held to a call model', () => {
    const agent = surfaces().find((s) => s.route === 'agent')!;
    expect(modelPinsCheck([{ ...agent, model: 'some-other-model' }]).ok).toBe(true);
  });
});
