import { describe, expect, test } from 'bun:test';

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEdits, baselineProblem, budgetLine, GUIDANCE_SOURCES, GuidanceSources, missingReps, objective, overBudget, priorWeighings, readAttempts, recordAttempt, SourcesChanged, sourceForm, tally, type RepView } from './climb';
import { isTypedLine, shellAnywhere } from './find';
import { HOLD_OUT_SHARE, splitFor } from './store';
import { firstDecisive } from '../surfaces/guidance';

describe('climb edits', () => {
  const src = { 'a.ts': 'export const A = `Run \\`cast check\\` first.\nThen ${X} stays.`;\n', 'b.ts': 'export const B = `Ask with a card. Ask with a card.`;\n' };

  test('rendered text maps to its template source: backticks and ${ escaped', () => {
    expect(sourceForm('Run `cast check` first.')).toBe('Run \\`cast check\\` first.');
    expect(sourceForm('a ${b}')).toBe('a \\${b}');
  });

  test('an edit lands where its rendered text sits, escaped as the source writes it', () => {
    const { files, refused } = applyEdits(src, [{ find: 'Run `cast check` first.', replace: 'Run `cast check web` first.' }]);
    expect(refused).toEqual([]);
    expect(files['a.ts']).toContain('Run \\`cast check web\\` first.');
    expect(files['b.ts']).toBe(src['b.ts']);
  });

  test('a find that is missing, generated or repeated is refused with its reason, and the sources stay as they were', () => {
    const { files, refused } = applyEdits(src, [
      { find: 'Then the value stays.', replace: 'x' },
      { find: 'Ask with a card.', replace: 'y' },
      { find: '  ', replace: 'z' },
    ]);
    expect(refused.map((r) => r.why.split(':')[0])).toEqual(['the find text is not in the guidance source as written (it may span generated text, like a version stamp or a shared constant)', 'the find text occurs more than once', 'empty find']);
    expect(files).toEqual(src);
  });

  test('replacement text with $ patterns is written literally', () => {
    const { files } = applyEdits(src, [{ find: 'Run `cast check` first.', replace: "costs $& and $'" }]);
    expect(files['a.ts']).toContain("costs $& and $'");
  });
});

describe('climb objective', () => {
  const rep = (freeze: string, score: number): RepView => ({ freeze, score, pass: score >= 0.7, actions: [], said: '', checks: [] });

  test('tally counts passes per freeze, and the objective is the mean over every rep', () => {
    const reps = [rep('a', 1), rep('a', 0), rep('a', 1), rep('b', 0)];
    expect(tally(reps)).toEqual([
      { freeze: 'a', reps: 3, passed: 2, mean: 2 / 3 },
      { freeze: 'b', reps: 1, passed: 0, mean: 0 },
    ]);
    expect(objective(reps)).toBe(0.5);
    expect(objective([])).toBe(0);
  });
});

describe('typed lines', () => {
  test('a short line a person typed is one; relays, briefs and machine frames are not', () => {
    expect(isTypedLine('no, run the migration yourself, you have the access')).toBe(true);
    expect(isTypedLine('From @ops: noted. Pause the nightly import until the vendor answers')).toBe(false);
    expect(isTypedLine('Your message to session tst0001 was typed into it, but its arrival was never confirmed.')).toBe(false);
    expect(isTypedLine('<scheduled-task title="x">do it</scheduled-task>')).toBe(false);
    expect(isTypedLine('<session-message from="tst0002"> Hold the import and say when it resumes.</session-message>')).toBe(false);
    expect(isTypedLine(`stop ${'word '.repeat(400)}`)).toBe(false);
  });
});

describe('drafted patterns', () => {
  test('a shell pattern matches its command anywhere in a chained call; other patterns are kept as written', () => {
    expect(shellAnywhere('Bash: cast browser (open|do)')).toBe('Bash:.*cast browser (open|do)');
    expect(shellAnywhere('^Bash: .*cast decide')).toBe('Bash:.*cast decide');
    expect(shellAnywhere('^AskUserQuestion:')).toBe('^AskUserQuestion:');
    const label = { want: [shellAnywhere('Bash: cast browser open')], avoid: [] };
    expect(firstDecisive(['Bash: cat posts.md; cast browser open https://x.example'], label)?.wanted).toBe(true);
  });
});

describe('climb budget', () => {
  const start = { size: 36_990, max: 37_000, sectionsOver: [] as string[] };

  test('a rewrite fits the budget, and a file already over it may not grow', () => {
    expect(overBudget({ size: 36_999, sectionsOver: [] }, start)).toBeNull();
    expect(overBudget({ size: 37_010, sectionsOver: [] }, start)).toContain('10 over its 37000 limit');
    const over = { size: 37_046, max: 37_000, sectionsOver: [] as string[] };
    expect(overBudget({ size: 37_046, sectionsOver: [] }, over)).toBeNull();
    expect(overBudget({ size: 37_050, sectionsOver: [] }, over)).toContain('4 over');
    expect(overBudget({ size: 36_000, sectionsOver: ['decide'] }, start)).toContain('section decide');
  });

  test('the rewriter is told its room, or that it must pay for what it adds', () => {
    expect(budgetLine(start)).toContain('at most 10 characters');
    expect(budgetLine({ size: 37_046, max: 37_000 })).toContain('must not make it longer');
  });
});

describe('climb safety', () => {
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), 'climb-tree-'));
    for (const p of GUIDANCE_SOURCES) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), `${p} v1`);
    }
    return root;
  };
  const read = (root: string) => Object.fromEntries(GUIDANCE_SOURCES.map((p) => [p, readFileSync(join(root, p), 'utf8')]));

  test('writes and restores its own edits, and never writes over an edit another session made underneath', () => {
    const root = tree();
    const g = new GuidanceSources(read(root), root);
    const edited = { ...read(root), [GUIDANCE_SOURCES[0]!]: 'edited' };
    g.write(edited);
    expect(read(root)[GUIDANCE_SOURCES[0]!]).toBe('edited');
    writeFileSync(join(root, GUIDANCE_SOURCES[0]!), 'someone else');
    expect(() => g.restore()).toThrow(SourcesChanged);
    expect(read(root)[GUIDANCE_SOURCES[0]!]).toBe('someone else');
  });

  test('a split depends on the correction alone, holds out about its share, and never changes', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `tst0000000000000000000000000000a:${i}`);
    const held = ids.filter((id) => splitFor(id) === 'held-out').length / ids.length;
    expect(Math.abs(held - HOLD_OUT_SHARE)).toBeLessThan(0.08);
    expect(ids.map(splitFor)).toEqual(ids.map(splitFor));
  });

  test('every climb is recorded, and a held-out set already weighed shows its earlier draws', () => {
    const home = mkdtempSync(join(tmpdir(), 'climb-home-'));
    const prev = process.env.CODECAST_EVALS_HOME;
    process.env.CODECAST_EVALS_HOME = home;
    try {
      recordAttempt({ stamp: 's1', base: 'b1', final: 'f1', train: ['t'], heldOut: ['h1', 'h2'], claim: false, why: 'held-out not better' });
      recordAttempt({ stamp: 's2', base: 'b2', final: null, train: ['t'], heldOut: ['h1'], claim: false, why: 'no round beat the baseline' });
      expect(readAttempts().map((a) => a.stamp)).toEqual(['s1', 's2']);
      expect(priorWeighings(['h2']).map((a) => a.stamp)).toEqual(['s1']);
      expect(priorWeighings(['h3'])).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CODECAST_EVALS_HOME;
      else process.env.CODECAST_EVALS_HOME = prev;
    }
  });

  test('a baseline needs every rep on every freeze, each recording this tree\'s guidance', () => {
    const rep = (freezeId: string, promptSha?: string) => ({ freezeId, promptSha });
    expect(baselineProblem([rep('a', 's'), rep('a', 's')], ['a'], 2, 's')).toBeNull();
    expect(baselineProblem([rep('a', 's')], ['a'], 2, 's')).toContain('lacks 2 scored reps');
    expect(baselineProblem([rep('a', 's'), rep('a')], ['a'], 2, 's')).toContain('none recorded');
    expect(baselineProblem([rep('a', 's'), rep('a', 'other')], ['a'], 2, 's')).toContain('1 rep(s)');
  });

  test('a batch short of its reps on any freeze is incomplete', () => {
    const runs = [{ freezeId: 'a' }, { freezeId: 'a' }, { freezeId: 'b' }];
    expect(missingReps(runs, ['a', 'b'], 2)).toEqual(['b']);
    expect(missingReps(runs, ['a'], 2)).toEqual([]);
  });
});
