import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../../paths';
import { briefVars, findingLines, renderBrief, renderCard, TEMPLATE, verdictOfCommand } from './index';

const template = readFileSync(join(REPO_ROOT, TEMPLATE), 'utf8');

const VARS = {
  task_id: 'ct-1',
  task_title: 'Typed answers at a gate never ship',
  branch: 'codecast/gate-text',
  default_branch: 'main',
  acceptance_criteria: 'A typed question is answered\n- and never lands the change',
  'line.principles': 'docs/principles.md',
  'line.prompting': 'docs/prompting.md',
};

describe('the brief', () => {
  test('reads back the values it was rendered from, so a new template renders the same facts', () => {
    const rendered = renderBrief(template, VARS);
    const vars = briefVars(template, rendered)!;
    for (const name of Object.keys(vars)) expect(vars[name]).toBe(VARS[name as keyof typeof VARS]);
    expect(renderBrief(template, vars)).toBe(rendered);
  });

  test('a brief from another template is not read', () => {
    expect(briefVars(template, 'You are the presenter.')).toBeNull();
  });
});

describe('reading the verdict', () => {
  test('a heredoc note after other commands', () => {
    const cmd = `git worktree remove --force /tmp/rv && cast task verdict ct-1 approve --note - <<'EOF'\nApprove.\n\nlow a/b.ts:3-4 a gap -> rejected\nEOF\ncast state --status done "Reviewed"`;
    expect(verdictOfCommand(cmd)).toEqual({ task: 'ct-1', verdict: 'approve', note: 'Approve.\n\nlow a/b.ts:3-4 a gap -> rejected' });
  });

  test('a quoted note', () => {
    expect(verdictOfCommand(`cast task verdict ct-2 changes --note "Fails \\"x\\"."`)).toEqual({ task: 'ct-2', verdict: 'changes', note: 'Fails "x".' });
  });

  test('no verdict', () => {
    expect(verdictOfCommand('cast task show ct-1')).toBeNull();
  });
});

test('the card is decide.cast Ship card with the note as its document', () => {
  const card = renderCard({ task_title: 'X works', branch: 'b' }, 'Approve.\nnit a.ts:1 y -> rejected');
  expect(card).toStartWith('Question: Ship this change?\nTask: X works. It passed its checks and review on b.\n\nAnswers:\n1. Ship (Land the change)');
  expect(card).toEndWith('Document:\nApprove.\nnit a.ts:1 y -> rejected');
  expect(findingLines(card)).toBe(1);
});
