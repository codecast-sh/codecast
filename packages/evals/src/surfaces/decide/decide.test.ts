import { describe, expect, test } from 'bun:test';

import { cardOfCommand, renderCard, sessionText, shellWords } from './index';

// sd-1098's command as the session ran it (jx7c5mj:86).
const REAL = `cast decide "Test 'warm a cold A before pitching' with a randomized holdout?" \\
  -o "Run a holdout :: Half of the As get one check-in first; the other half get pitched as now." \\
  -o "Ship it as the default :: Every cold A gets the check-in first, with no control group." \\
  -o "Leave it :: Keep pitching cold As as now (11% yes)." \\
  --context - <<'EOF2'
The situation lens (ct-68184, four iterations, about $90) measured every pitch.

The shipping rules say no split tests unless you ask for one.
EOF2`;

describe('reading cast decide out of a command', () => {
  test('a multi-line ask with a heredoc context', () => {
    const card = cardOfCommand(REAL)!;
    expect(card.question).toBe("Test 'warm a cold A before pitching' with a randomized holdout?");
    expect(card.options.map((o) => o.label)).toEqual(['Run a holdout', 'Ship it as the default', 'Leave it']);
    expect(card.options[2]!.description).toBe('Keep pitching cold As as now (11% yes).');
    expect(card.context).toBe('The situation lens (ct-68184, four iterations, about $90) measured every pitch.\n\nThe shipping rules say no split tests unless you ask for one.');
  });

  test('a cd prefix, inline context, advisory default and a trailing pipe', () => {
    const card = cardOfCommand(`cd ~/src/x && cast decide 'Pick one?' -o "A :: does a" -o B --advisory --default 2 --context "Line \\"one\\"." 2>&1 | tail -3`)!;
    expect(card).toEqual({ question: 'Pick one?', options: [{ label: 'A', description: 'does a' }, { label: 'B' }], context: 'Line "one".', advisory: true, default: 2 });
  });

  test('edit and cancel are not asks', () => {
    expect(cardOfCommand('cast decide edit --context "x"')).toBeNull();
    expect(cardOfCommand('cast decide cancel')).toBeNull();
    expect(shellWords('echo hi')).toBeNull();
  });

  test('the card renders the way the queue reads it', () => {
    expect(renderCard(cardOfCommand(REAL)!)).toStartWith("Question: Test 'warm a cold A before pitching' with a randomized holdout?\n\nAnswers:\n1. Run a holdout (Half");
  });
});

describe('the session the replay carries', () => {
  test('keeps the first message and the newest rows, tool calls and output included', () => {
    const rows = [
      { line: 1, role: 'user', content: 'the ask', timestamp: 1 },
      { line: 2, role: 'assistant', content: 'x'.repeat(200_000), timestamp: 2 },
      { line: 3, role: 'assistant', content: '', timestamp: 3, tool_calls: [{ name: 'Bash', input: JSON.stringify({ command: 'ls' }) }] as never },
      { line: 4, role: 'user', content: '', timestamp: 4, tool_results: [{ content: 'a.ts' }] as never },
    ];
    const text = sessionText(rows);
    expect(text).toStartWith('[1] USER: the ask');
    expect(text).toContain('[… 1 earlier messages left out]');
    expect(text).toContain('[3] YOU ran Bash:\nls');
    expect(text).toContain('[4] TOOL OUTPUT:\na.ts');
  });
});
