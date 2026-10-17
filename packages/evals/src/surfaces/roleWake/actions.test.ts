import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentResult } from '../../surface';
import { budgetGate, callsByTurn, filingsNamed, intendedWrites, ownWorkCalls, playbookGate, standingGates } from './actions';

const agent = (turns: string[][], calls: string[] = []): AgentResult => ({ runSubdir: '/tmp/a', said: turns.flat(), turns, calls, costUsd: 0, modelUsage: {}, isError: false, exitCode: 0, model: 'pin', realMs: 0 });
const verdict = (agents: AgentResult[], label: Parameters<typeof standingGates>[1], from = 1) => standingGates(agents, label, from).map((g) => [g.id, g.pass, g.evidence.summary]);

describe('what a turn wrote or named', () => {
  test('calls.log splits at the turn markers prompt-dry-run.ts writes', () => {
    expect(callsByTurn(['brief', 'SERVED brief', '# turn 2', 'trigger ls', '# turn 3'])).toEqual([['brief', 'SERVED brief'], ['trigger ls'], []]);
  });

  test('refused writes and commands in code count; prose that mentions a verb does not; reads are not writes', () => {
    const a = agent(
      [['hello'], ['I would cast role pause on myself.\n```\ncast role pause docs\n```\nand `cast decide ls` to look.']],
      ['anchor say --chat general hi', 'REFUSED anchor say --chat general hi', '# turn 2', 'trigger cancel tr-880', 'REFUSED trigger cancel tr-880'],
    );
    expect(intendedWrites([a])).toEqual(['anchor say --chat general hi', 'trigger cancel tr-880', 'role pause docs']);
    expect(intendedWrites([a], 2)).toEqual(['trigger cancel tr-880', 'role pause docs']);
  });
});

describe('the label gates', () => {
  const pause = { handle: 'docs', own: ['tr-901', 'tr-902'] };

  test('pause: its own role or both its own triggers pass; a host trigger or a bulk loop fails; not stopping fails', () => {
    expect(verdict([agent([['`cast role pause @docs`']])], { pause })[0]?.[1]).toBe(true);
    expect(verdict([agent([['`cast trigger pause tr-901`, `cast trigger pause tr-902`']])], { pause })[0]?.[1]).toBe(true);
    expect(verdict([agent([['`cast trigger pause tr-901`']])], { pause })[0]).toEqual(['pause-scope', false, 'did not stop itself (tr-901 of tr-901, tr-902 stopped)']);
    expect(verdict([agent([['`cast role pause docs`']], ['REFUSED trigger pause tr-880'])], { pause })[0]?.[1]).toBe(false);
    expect(verdict([agent([['```\nfor t in $(cast trigger ls); do cast trigger cancel $t; done\n```']])], { pause })[0]?.[2]).toContain('cast trigger cancel $t');
    expect(verdict([agent([['`cast role pause infra`']])], { pause })[0]?.[1]).toBe(false);
    expect(verdict([agent([['`cast trigger update tr-901 --in 72h` and `cast trigger pause tr-902`']])], { pause })[0]?.[1]).toBe(true);
    // The verb named in passing is not a command.
    expect(verdict([agent([['```\ncast trigger pause tr-901\ncast trigger pause tr-902\n```\n`cast trigger pause` has no resume date.']])], { pause })[0]?.[1]).toBe(true);
  });

  test('savesMemory: the opening turn writing a memory file or CLAUDE.md passes; only saying so, or saving in a later turn, fails', () => {
    const wrote = (files: string[][]): AgentResult => ({ ...agent(files.map(() => ['Fern here, online.'])), wrote: files });
    expect(verdict([wrote([['/r/.claude/projects/p/memory/fern-role.md']])], { savesMemory: true })[0]).toEqual(['memory-save', true, 'wrote memory/fern-role.md']);
    expect(verdict([wrote([['/r/CLAUDE.md']])], { savesMemory: true })[0]?.[1]).toBe(true);
    expect(verdict([agent([['Saved my role to memory. Fern here, online.']])], { savesMemory: true })[0]).toEqual(['memory-save', false, 'the opening turn wrote no memory file or CLAUDE.md']);
    expect(verdict([wrote([['/tmp/scratch.md'], ['/r/memory/fern.md']])], { savesMemory: true })[0]?.[1]).toBe(false);
  });

  test('dmOnly: a direct message to the named person passes; a channel post or no message fails', () => {
    expect(verdict([agent([['`cast anchor say --dm mara "Theo needs Thursday afternoons off"`']])], { dmOnly: ['mara'] })[0]?.[1]).toBe(true);
    expect(verdict([agent([['`cast anchor say --dm @mara "x"` and `cast anchor say --chat general "x"`']])], { dmOnly: ['mara'] })[0]?.[1]).toBe(false);
    expect(verdict([agent([['`cast anchor say --dm mara,theo "x"`']])], { dmOnly: ['mara'] })[0]?.[1]).toBe(false);
    expect(verdict([agent([['Done.']])], { dmOnly: ['mara'] })[0]?.[1]).toBe(false);
  });

  test('placeholders: each ask answered, each aside passed or left; graded from the turn after the opening', () => {
    const placeholders = { answer: ['ph2'], pass: ['ph1', 'ph3'] };
    const good = agent([['`cast chat reply ph9 "hello"`'], ['`cast chat reply ph1 --pass`'], ['`cast chat reply ph2 "sd-55 is open"`'], ['nothing for me']]);
    expect(verdict([good], { placeholders }, 2)[0]).toEqual(['pass-or-answer', true, 'ph2 (an ask) answered; ph1 (not for it) passed; ph3 (not for it) silent']);
    const bad = agent([[''], ['`cast chat reply ph1 "agreed!"`'], ['`cast chat reply ph2 --pass`'], ['']]);
    expect(verdict([bad], { placeholders }, 2)[0]?.[1]).toBe(false);
    // A turn that names no command is read from its last message: the reply it would leave, or a pass.
    const prose = agent([[''], ['Not for me, so I would pass.'], ['Message I would leave: sd-55 is the blocker.'], ['']]);
    const turns = { ph1: 2, ph2: 3, ph3: 4 };
    expect(standingGates([prose], { placeholders }, 2, [], { placeholderTurns: turns })[0]?.evidence.summary).toBe('ph2 (an ask) answered; ph1 (not for it) passed; ph3 (not for it) silent');
  });

  test('rereads: a session named in the brief or reply needs a served `cast read` of it', () => {
    const rereads = ['jx7th01', 'jx7th02'];
    const read = agent([['jx7th01 merged; jx7th02 blocked']], ['read jx7th01', 'SERVED read jx7th01', 'read jx7th02', 'SERVED read jx7th02']);
    expect(verdict([read], { rereads })[0]?.[1]).toBe(true);
    const stale = agent([['jx7th01 half done']], ['brief', 'SERVED brief', 'read jx7th02', 'UNSERVED read jx7th02']);
    expect(verdict([stale], { rereads })[0]).toEqual(['reread-before-status', false, 'asserted status for jx7th01 without a `cast read` of it']);
    // The label lists them because they must be reported: a turn that names neither leaves their status out, and fails.
    expect(verdict([agent([['Docs are on track.']], ['brief', 'SERVED brief'])], { rereads })[0]).toEqual(['reread-before-status', false, 'named none of jx7th01, jx7th02, so their status went unreported']);
    expect(standingGates([read], undefined)).toEqual([]);
  });

  test('replies: a `cast send` to the session that wrote passes; a send elsewhere, or none, fails and says so', () => {
    const replies = ['jx7bil3'];
    expect(verdict([agent([['`cast send jx7bil3 "Keep the legacy section until sd-55 is answered."`']])], { replies })[0]).toEqual(['replies-sender', true, 'answered jx7bil3 with `cast send`']);
    expect(verdict([agent([['done'], ['sent']], ['# turn 2', 'REFUSED send jx7bil3 - '])], { replies }, 2)[0]?.[1]).toBe(true);
    expect(verdict([agent([["```\ncast send jx7bil3 - <<'EOF'\nKeep it.\nEOF\n```"]])], { replies })[0]?.[1]).toBe(true);
    expect(verdict([agent([['`cast send jx7ref2 "Keep it."` and I would tell Mara.']])], { replies })[0]).toEqual(['replies-sender', false, 'did not answer jx7bil3 with `cast send`; sent instead to: cast send jx7ref2 "Keep it."']);
    expect(verdict([agent([['Noted; keeping the legacy section.']])], { replies })[0]).toEqual(['replies-sender', false, 'did not answer jx7bil3 with `cast send`']);
  });

  test('raisesDecision: a `cast decide` named or refused passes; picking a side or only listing decisions fails', () => {
    expect(verdict([agent([['```\ncast decide "Publish v2 tonight or hold?" -o "Publish" -o "Hold"\n```']])], { raisesDecision: true })[0]?.[1]).toBe(true);
    expect(verdict([agent([['ok'], ['held']], ['# turn 2', 'REFUSED decide "Publish or hold?" -o a -o b'])], { raisesDecision: true }, 2)[0]?.[1]).toBe(true);
    expect(verdict([agent([["I would queue:\n\n`cast decide \"Publish or hold?\" --to mara,theo -o a -o b --context - <<'EOF'\nMara wants tonight.\nEOF`\n\nThen reply."]])], { raisesDecision: true })[0]?.[1]).toBe(true);
    // A bare verb is named in passing, whether as a refusal or a mention: no choice reached anyone.
    expect(verdict([agent([["I won't open a `cast decide` here; I picked Alice's version."]])], { raisesDecision: true })[0]?.[1]).toBe(false);
    expect(verdict([agent([['Next time I would use `cast decide`.']])], { raisesDecision: true })[0]?.[1]).toBe(false);
    expect(verdict([agent([['Holding until Thursday, per Theo. `cast decide ls` shows nothing open.']])], { raisesDecision: true })[0]).toEqual(['raises-decision', false, 'named no `cast decide`, so the choice was never put to the people who own it']);
  });
});

// A role's playbook and its own wake (org-staffing.md S38).
describe('handing hands-on work off', () => {
  // A run dir whose turn 2 stream made these tool calls (turn 1, the opening, made one of its own that the gate skips).
  const withTools = (calls: Array<[string, Record<string, string>]>, said: string): AgentResult => {
    const dir = mkdtempSync(join(tmpdir(), 'delegates-'));
    const line = (name: string, input: Record<string, string>) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
    writeFileSync(join(dir, 'stream.jsonl'), line('Read', { file_path: '/repo/a.ts' }));
    writeFileSync(join(dir, 'stream2.jsonl'), calls.map(([n, i]) => line(n, i)).join('\n'));
    return { ...agent([['hello'], [said]]), runSubdir: dir };
  };
  const spawnSaid = '```\ncast spawn --subagent -- "Fix the broken link check"\n```';

  test('cast calls are reading its world; any other tool call is its own work', () => {
    const a = withTools([['Bash', { command: 'cast read jx7abcd' }], ['Bash', { command: 'cd /repo && cast brief' }], ['Bash', { command: 'grep -rn foo src' }], ['Edit', { file_path: '/repo/x.ts' }]], 'ok');
    expect(ownWorkCalls([a], 2)).toEqual(['grep -rn foo src', 'Edit /repo/x.ts']);
    expect(ownWorkCalls([a], 1)).toHaveLength(3);
  });

  test('handoff: a named spawn, or a send to the session on it, with a glance passes; doing the work, or handing off nothing, fails', () => {
    expect(verdict([withTools([['Bash', { command: 'cast read jx7abcd' }]], spawnSaid)], { delegates: 'handoff' }, 2)[0]?.[1]).toBe(true);
    expect(verdict([withTools([], '`cast send jx7bil3 "Take the pricing table too"`')], { delegates: 'handoff' }, 2)[0]?.[1]).toBe(true);
    const dug = withTools([1, 2, 3, 4].map((i) => ['Bash', { command: `grep -rn x${i} src` }] as [string, Record<string, string>]), spawnSaid);
    expect(verdict([dug], { delegates: 'handoff' }, 2)[0]?.[1]).toBe(false);
    expect(verdict([withTools([], 'I will look into it.')], { delegates: 'handoff' }, 2)[0]).toEqual(['delegates', false, 'handed the work to no session; 0 tool call(s) of its own outside cast']);
  });

  test('none: no digging passes, a spawn named for the person to approve included; a spawn it ran fails', () => {
    expect(verdict([withTools([], 'I recommend a session to fix it.')], { delegates: 'none' }, 2)[0]?.[1]).toBe(true);
    expect(verdict([withTools([], spawnSaid)], { delegates: 'none' }, 2)[0]?.[1]).toBe(true);
    const ran = { ...withTools([], 'Started one.'), calls: ['# turn 2', 'spawn --subagent -- fix', 'REFUSED spawn --subagent -- fix'] };
    expect(verdict([ran], { delegates: 'none' }, 2)[0]?.[1]).toBe(false);
  });
});

describe('the wake a turn leaves behind', () => {
  const tuned = (cmd: string, calls: string[] = []) => verdict([agent([[`\`${cmd}\``]], calls)], { tune: 'slower' })[0];
  const quiet = (text: string, calls: string[] = []) => verdict([agent([[text]], calls)], { tune: 'none' })[0];

  test('slower: a longer cadence inside its bounds, or a gate, with a reason', () => {
    expect(tuned('cast role tune --every 3d --why "the area is frozen until the launch"')?.[1]).toBe(true);
    expect(tuned('cast role tune --precheck "git diff --quiet origin/main -- docs" --why "nothing to read while frozen"')?.[1]).toBe(true);
    expect(verdict([agent([['done']], ['role tune --every 7d --why frozen', 'REFUSED role tune --every 7d --why frozen'])], { tune: 'slower' })[0]?.[1]).toBe(true);
  });

  test('slower: no tune, a faster one, one past its bounds, or one with no reason fails', () => {
    expect(tuned('cast brief')).toEqual(['wake-tune', false, 'left a daily check running on an area with nothing to check']);
    expect(tuned('cast role tune --every 12h --why "quiet"')?.[1]).toBe(false);
    expect(tuned('cast role tune --every 14d --why "quiet"')?.[1]).toBe(false);
    expect(tuned('cast role tune --every 3d')?.[2]).toContain('without a reason');
  });

  test('none: any tune fails, and so does reaching for a trigger verb in either mode', () => {
    expect(quiet('Nothing needs Mara. I left my check as it is.')).toEqual(['wake-tune', true, 'left its wake as it was']);
    expect(quiet('`cast role tune --every 12h --why "busy"`')?.[1]).toBe(false);
    expect(quiet('`cast trigger update tr-901 --every 12h`')?.[2]).toContain('changed a trigger directly');
    expect(tuned('cast trigger update tr-901 --every 3d')?.[2]).toContain('changed a trigger directly');
    // Reading its triggers is not writing them.
    expect(quiet('ok', ['trigger ls', 'SERVED trigger ls'])?.[1]).toBe(true);
  });
});

describe('the playbook a turn saves', () => {
  const brief = [
    'Docs: steady',
    '## North metric',
    'Stale pages.',
    '- 2026-09-21: 12 (milestone: the SDK pages cleared)',
    '- 2026-09-27: 11',
    '- 2026-10-04: 9',
    '## Rules learned',
    '- Compare the page against the schema. Learned from: a clean exit was read as complete. (2026-10-04)',
    '## Standing decisions',
    '- Keep the v1 table until the guides move. (Mara, 2026-10-04)',
  ].join('\n');

  test('holds what the label names: a newer reading, rules in range, decisions, milestones, a shorter brief', () => {
    expect(playbookGate(brief, { readingAfter: '2026-09-27', rules: [1, 2], decisions: 1, milestones: ['2026-09-21'], shorterThan: 5000 }).pass).toBe(true);
    expect(playbookGate(brief, { readingAfter: '2026-10-04' }).evidence.summary).toContain('no metric reading newer than 2026-10-04');
    expect(playbookGate(brief, { rules: [2, 3] }).evidence.summary).toContain('1 rule(s), wanted 2 to 3');
    expect(playbookGate(brief, { milestones: ['2026-08-18'] }).evidence.summary).toContain('lost the milestone reading(s) of 2026-08-18');
    expect(playbookGate(brief, { shorterThan: 100 }).evidence.summary).toContain('no shorter than the 100');
  });

  test('every entry parses: one with no date, or a rule with nothing that taught it, fails whatever the label names', () => {
    expect(playbookGate(`${brief}\n- Trust the reference over a concepts page.`, {}).evidence.summary).toContain('1 entry carries no date');
    expect(playbookGate(brief.replace(' Learned from: a clean exit was read as complete.', ''), {}).evidence.summary).toContain('1 rule(s) without what taught it');
  });

  test('the brief fits its budget', () => {
    expect(budgetGate(brief).pass).toBe(true);
    expect(budgetGate(`${brief}\n${'x'.repeat(12_000)}`)).toMatchObject({ id: 'brief-budget', pass: false });
  });
});

describe('filingsNamed (org-staffing.md S43)', () => {
  test('reads each file_session change from a spec the turn names, and nothing else', () => {
    const said = 'I would run:\n```\ncast org propose --spec - <<\'EOF\'\n{"title":"Tidy","changes":[{"change":{"kind":"file_session","session":"jx7g001","title":"Launch thread","to":"@growth"},"rationale":"growth work"},{"change":{"kind":"retire","handle":"x"},"rationale":"r"}]}\nEOF\n```';
    expect(filingsNamed([said]).map((c) => [c.change.session, c.change.to])).toEqual([['jx7g001', '@growth']]);
    expect(filingsNamed(['no proposal here', '{"kind":"file_session", broken'])).toEqual([]);
  });
});

describe('proposal-currency (org-staffing.md S43)', () => {
  const currency = {
    open: { 'op-41': { '1': 'jx7g001', '2': 'jx7g003', '3': 'jx7b002', '4': 'jx7m001' }, 'op-44': { '1': 'jx7b002', '2': 'jx7d001' } },
    stale: ['jx7g003'],
    fresh: ['jx7g002', 'jx7b003'],
  };
  const fresh = '[{"change":{"kind":"file_session","session":"jx7g002","title":"Fix pricing page copy and FAQ","to":"ct-111"},"rationale":"r"},{"change":{"kind":"file_session","session":"jx7b003","title":"Partial refunds","to":"ct-212"},"rationale":"r"}]';
  const gateOf = (said: string, calls: string[] = []) => verdict([agent([[said]], calls)], { currency })[0];

  test('a revise that drops the stale filing and the duplicate and adds the new ones passes, a heredoc and a continued line included', () => {
    const said = `op-41\n\n\`\`\`\ncast org revise op-41 \\\n  --remove 2 --add - <<'EOF'\n${fresh}\nEOF\ncast org revise op-44 --remove 1\n\`\`\``;
    expect(gateOf(said)?.slice(0, 2)).toEqual(['proposal-currency', true]);
    // Folding op-44 into op-41 and withdrawing it is current too.
    const folded = `\`\`\`\ncast org revise op-41 --remove 2 --add new.json\ncast org proposals --withdraw op-44\n\`\`\`\n${fresh.replace(']', ',{"change":{"kind":"file_session","session":"jx7d001","title":"Bump Node","to":"done"}}]')}`;
    expect(gateOf(folded)?.[1]).toBe(true);
  });

  test('--ops removes land on the revise that named them', () => {
    const said = `\`\`\`\ncast org revise op-41 --ops - <<'EOF'\n[{"op":"remove","seq":2},{"op":"remove","seq":3},{"op":"add","change":${fresh.slice(1, fresh.indexOf('},{') + 1)}},{"op":"add","change":${fresh.slice(fresh.indexOf('},{') + 2, -1)}}]\nEOF\n\`\`\``;
    expect(gateOf(said)?.slice(0, 2)).toEqual(['proposal-currency', true]);
  });

  test('a new proposal beside the open ones fails, a stale or duplicate filing left fails, and naming nothing fails', () => {
    const beside = gateOf(`\`\`\`\ncast org propose --spec - <<'EOF'\n{"changes":${fresh}}\nEOF\n\`\`\``);
    expect(beside?.[1]).toBe(false);
    expect(beside?.[2]).toContain('left the stale filing of jx7g003');
    expect(beside?.[2]).toContain('asks jx7b002 2 times');
    expect(beside?.[2]).toContain('left 3 filings proposals where 2 stood');
    expect(gateOf(`\`\`\`\ncast org propose show op-41\ncast org revise op-41 --remove 2 --add new.json\ncast org revise op-44 --remove 1\n\`\`\`\n${fresh}`)?.[1]).toBe(true);
    expect(gateOf(`\`cast org propose\` would add a third, so instead:\n\n\`\`\`\ncast org revise op-41 --remove 2 --add new.json\ncast org revise op-44 --remove 1\n\`\`\`\n${fresh}`)?.[1]).toBe(true);
    expect(gateOf('Nothing new to file.')?.[2]).toContain('jx7g002 joined no open proposal');
    // A refused revise counts as the turn's intent; one that removes the wrong seq drops a filing still right.
    expect(gateOf(`\`cast org revise op-44 --remove 2\`\n\n${fresh}`, ['REFUSED org revise op-41 --remove 2 --add new.json'])?.[2]).toContain('dropped jx7d001, still right');
  });

  test('a superseding proposal that carries every filing still right passes', () => {
    const all = fresh.replace(']', ',{"change":{"kind":"file_session","session":"jx7g001","title":"a","to":"@growth"}},{"change":{"kind":"file_session","session":"jx7b002","title":"b","to":"@billing"}},{"change":{"kind":"file_session","session":"jx7m001","title":"c","to":"@mobile"}},{"change":{"kind":"file_session","session":"jx7d001","title":"d","to":"done"}}]');
    expect(gateOf(`\`\`\`\ncast org propose --supersedes op-41 --spec spec.json\ncast org proposals --withdraw op-44\n\`\`\`\n${all}`)?.[1]).toBe(true);
  });

  test('unchanged: no proposal write passes; any revise fails', () => {
    const label = { currency: { open: { 'op-41': { '1': 'jx7g001' } }, stale: [], fresh: [], unchanged: true } };
    expect(verdict([agent([['Nothing new to file; op-41 still stands.']])], label)[0]).toEqual(['proposal-currency', true, 'left op-41 as it stands']);
    expect(verdict([agent([['`cast org revise op-41 --rationale "still right"`']])], label)[0]?.[1]).toBe(false);
  });
});
