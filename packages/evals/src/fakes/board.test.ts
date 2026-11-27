import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { fixturesDir } from '../paths';
import { answer } from './cast';
import { boardElements } from './cast/board';
import { readTree, type Tree } from './cast/tree';
import { newWorld, type FakeBoard } from './cast/world';

// The board fake a Scribe replay writes into (ct-102408): the real board verbs
// against one doc's elements, the call, and the objects a huddle files.
const tree = readTree(join(fixturesDir(), 'fakes', 'scribe-tree.json')) as Tree;

const board = (): FakeBoard => ({
  doc: 'docfakeboard0000000000001',
  title: 'Huddle board',
  rev: 1,
  elements: { el_person: { kind: 'sticky', fields: { x: 2000, y: 0, w: 200, h: 120, text: 'my own note', color: 'yellow' }, rev: 1, by: 'u:person1', at: 0 } },
  comments: [],
  checkpoints: [],
  log: [],
});

const world = () => newWorld({ self: 'jx7scrb', board: board(), call: { id: 'cl-9', title: 'A huddle', started: 'Nov 23 11:18 AM', speakers: ['Ana', 'Ben'] }, listings: { priorities: [' #1  pri-7  Budgets   critical'], tasks: ['  ◎ ct-5 Budget alerts', '  ◎ ct-6 Deploy flow'], plans: [], goals: '# Goals' } });

const ask = (w: ReturnType<typeof newWorld>, argv: string[], stdin = '') => {
  const a = answer(argv, stdin, w, tree);
  if (a === null) throw new Error(`no answer for ${argv.join(' ')}`);
  return a;
};

describe('board fake', () => {
  test('call board and calls name the doc and the call', () => {
    const w = world();
    expect(ask(w, ['call', 'board']).out).toContain('doc:docfakeboard0000000000001');
    expect(ask(w, ['calls']).out).toContain('cl-9');
  });

  test('place with a frame ref writes through the real verb, stamped as the session', () => {
    const w = world();
    const a = ask(w, ['board', 'place', 'docfakeboard0000000000001', 'grid', '--cols', '3', '--at', '0,0', '--frame-ref', 'ct-5'], 'sticky:yellow One\nsticky:blue Two\n');
    expect(a.exit).toBe(0);
    const els = boardElements(w);
    const frame = els.find((e) => e.kind === 'frame');
    expect(frame?.ref).toBe('ct-5');
    expect(els.filter((e) => e.kind === 'sticky' && e.by === 's:jx7scrb')).toHaveLength(2);
    expect(els.find((e) => e.key === 'el_person')?.by).toBe('u:person1');
    const json = JSON.parse(ask(w, ['board', 'read', 'docfakeboard0000000000001', '--json']).out);
    expect(json.elements.length).toBe(els.length);
  });

  test('frame --collapse folds the notes; apply and rm edit the doc', () => {
    const w = world();
    ask(w, ['board', 'place', 'docfakeboard0000000000001', 'grid', '--at', '0,0', '--frame-ref', 'ct-5'], 'sticky One\nsticky Two\n');
    const notes = boardElements(w).filter((e) => e.kind === 'sticky' && e.by !== 'u:person1').map((e) => e.key);
    const f = ask(w, ['board', 'frame', 'docfakeboard0000000000001', 'Working notes', ...notes, '--collapse']);
    expect(f.exit).toBe(0);
    const inner = boardElements(w).find((e) => e.kind === 'frame' && e.title === 'Working notes');
    expect(inner?.collapsed).toBeTruthy();
    expect(ask(w, ['board', 'apply', 'docfakeboard0000000000001'], JSON.stringify([{ k: notes[0], set: { text: 'One!' } }])).exit).toBe(0);
    expect(ask(w, ['board', 'rm', 'docfakeboard0000000000001', 'el_nope']).exit).toBe(1);
    expect(ask(w, ['board', 'cursor', 'docfakeboard0000000000001', '--key', inner!.key, '--status', 'updating']).out).toBe('ok\n');
  });

  test('a huddle files under its frame, and the call lists what it filed', () => {
    const w = world();
    expect(ask(w, ['task', 'create', 'Read Ramp limits', '--from-call', 'cl-9', '--under', 'pri-7', '--assignee', 'Ana']).out).toContain('Created ct-');
    expect(ask(w, ['task', 'create', 'x', '--under', 'in-3']).exit).toBe(1);
    expect(ask(w, ['priorities', 'create', 'Budgets in software', '--owner', '@ana', '--from-call', 'cl-9']).out).toContain('Created pri-301');
    expect(ask(w, ['plan', 'create', 'Ramp', '-g', 'g', '--from-call', 'cl-9']).out).toContain('Created plan pl-1201');
    const t = Object.values(w.tasks)[0]!;
    expect([t.from_call, t.under, t.assignee]).toEqual(['cl-9', 'pri-7', 'Ana']);
    expect(ask(w, ['call', 'cl-9']).out).toContain('Read Ramp limits');
    expect(ask(w, ['task', 'update', t.id, '-t', 'Read Ramp card limits', '--assignee', 'Ben', '-d', 'agreed']).out).toBe(`ok Updated ${t.id}\n`);
    expect([t.title, t.assignee, t.description]).toEqual(['Read Ramp card limits', 'Ben', 'agreed']);
    expect(ask(w, ['task', 'ls', '-q', 'budget']).out).toContain('ct-5');
    expect(ask(w, ['task', 'ls', '-q', 'budget']).out).not.toContain('ct-6');
    expect(ask(w, ['priorities', 'ls']).out).toContain('pri-301');
  });
});
