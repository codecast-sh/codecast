import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixturesDir, REPO_ROOT } from '../paths';
import { readTree, type Tree } from './cast/tree';
import { capturesDir, writeCaptures } from './capture';
import { heldOut } from './fidelity';
import { grow, judge, staticCheck } from './grow';

// grow hands a model prod text and runs what it writes. These hold the three
// walls around that edit: it may not load anything new or run anything at
// load, its scoring and tests run in the closed world rather than here, and
// it never lands in the tracked file, least of all carrying real data.

const TREE_FILE = join(fixturesDir(), 'fakes', 'cli-tree.json');
const tree = readTree(TREE_FILE) as Tree;
const VERBS = join(import.meta.dir, 'cast', 'verbs.ts');
const original = readFileSync(VERBS, 'utf8');
const SEND = 'const there = exists(ctx.w, short);';
/** Answers a send to the synthetic captures' dead peer as they did: a real fidelity gain. */
const better = original.replace(SEND, `if (to.endsWith('peer')) return fail(\`Not sent. \${to} was killed.\`);\n  ${SEND}`);
const roster = { roles: {}, people: {} };

let home = '';
let before: string | undefined;
const sessions = Array.from({ length: 40 }, (_, i) => `jx7s${String(i).padStart(3, '0')}`);
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fakes-grow-'));
  before = process.env.CODECAST_EVALS_HOME;
  process.env.CODECAST_EVALS_HOME = home;
  const at = new Date().toISOString();
  for (const s of sessions) writeCaptures(capturesDir(home), s, [{ session: s, seq: 0, at, argv: ['send', 'jx7peer', `note-${s}`], out: 'Not sent. jx7peer was killed.\n', exit: 1 }]);
});
afterAll(() => {
  if (before === undefined) delete process.env.CODECAST_EVALS_HOME;
  else process.env.CODECAST_EVALS_HOME = before;
  rmSync(home, { recursive: true, force: true });
});

/** `unchecked`: past the static check, to show the walls behind it hold by themselves. */
const judgeOf = (candidate: string, privateText = '', unchecked = false) =>
  judge({ dir: mkdtempSync(join(home, 'judge-')), original, candidate, treeFile: TREE_FILE, roster, from: '', privateText, captures: capturesDir(home), ...(unchecked ? { check: () => null } : {}) });
/** `better` with a statement added at the start of the send handler's checks (scoring hits it) or past the peer (only the tests do). */
const inSend = (where: 'scoring' | 'tests', code: string) => better.replace(where === 'scoring' ? "if (to.endsWith('peer'))" : SEND, (at) => `${code}\n  ${at}`);

describe('grow: what a candidate may be', () => {
  test('the fake as it stands passes its own check', () => {
    expect(staticCheck(original, original)).toBeNull();
    expect(staticCheck(original, better)).toBeNull();
  });

  test('an import the original lacks, or one changed, is refused before anything runs', () => {
    expect(staticCheck(original, `import { spawnSync } from 'node:child_process';\n${original}`)).toMatch(/imports differ/);
    expect(staticCheck(original, original.replace("from './world';", "from '../capture';"))).toMatch(/imports differ/);
  });

  test('a top level that runs code at load is refused', () => {
    for (const line of ["Bun.spawnSync(['curl', 'https://example.com']);", 'const HOME = process.env.HOME;', "const T = require('node:fs').readFileSync('/etc/hosts', 'utf8');", 'void fetch("https://example.com");', 'const S = new Proxy({}, {});'])
      expect(staticCheck(original, `${original}\n${line}\n`)).toMatch(/top level runs code|reaches past the fake/);
    for (const line of ["const X = ok('loaded');", 'const Y = [1].map((n) => n + 1);'])
      expect(staticCheck(original, `${original}\n${line}\n`)).toMatch(/top level runs code/);
    expect(staticCheck(original, `${original}\nconst LOOKUP = new Set(['a', 'b']);\nconst RE = /x/g;\nconst F = (a: string) => a.trim();\n`)).toBeNull();
  });
});

describe('grow: what a candidate may reach, anywhere in it', () => {
  // Applied by a person, the edit runs in the harness with its real home, env and network: a handler body is as dangerous as the top level.
  const body = (code: string) => staticCheck(original, inSend('scoring', code));
  test('a handler that names a capability, imports at run time or walks to Function is refused', () => {
    for (const code of [
      "require('node:child_process').execSync('id');",
      "void import('node:fs');",
      'void process.env.HOME;',
      "Bun.spawnSync(['id']);",
      "void fetch('https://example.com');",
      'void globalThis.process;',
      'void global.process;',
      "eval('1');",
      "void new Function('return 1');",
      'void Reflect.ownKeys({});',
      'void import.meta.url;',
      "void ({} as any).constructor.constructor('return process')();",
      "void ok['constructor'];",
      "void ok.__proto__;",
      "const { constructor: c } = ok as any; void c;",
      "const k = ['con', 'structor'].join(''); void (ok as any)[k];",
      "void STATE_TAG[body];",
      'const process = 1; void process;',
      'const fetchIt = (fetch: number) => fetch; void fetchIt;',
      'const setTimeout = 1; void setTimeout;',
      'void setTimeout(() => 1, 1);',
      'void structuredClone({});',
      'void Object.getPrototypeOf(ok);',
    ])
      expect({ code, why: body(code) }).toEqual({ code, why: expect.stringMatching(/reaches past the fake|reads names|members of a global|computed key|shadows a global/) });
  });

  test('a handler that computes on plain data, and looks keys up with own(), passes', () => {
    for (const code of ['void Array.isArray(body);', 'void Math.max(1, 2);', 'void JSON.stringify(body);', "void own(STATE_TAG, String(body));", 'void Object.values(STATE_TAG);', 'void STATE_TAG.working;'])
      expect({ code, why: body(code) }).toEqual({ code, why: null });
  });
});

describe('grow: where a candidate runs', () => {
  // Each writes outside its run dir: one on every send, so scoring hits it; one only past the captures' peer, so only the fake's tests do.
  for (const [where, at, failed] of [
    ['scoring', "if (to.endsWith('peer'))", /fails in the sandbox/],
    ['tests', SEND, /tests fail with it/],
  ] as const)
    test(`its ${where} run in the closed world: a handler that writes outside its run dir fails there, and the write never lands`, () => {
      const mark = join(mkdtempSync(join(tmpdir(), 'grow-escape-')), 'mark');
      const r = judgeOf(better.replace(at, `require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x');\n  ${at}`), '', true);
      expect(staticCheck(original, better.replace(at, `require('node:fs');\n  ${at}`))).toMatch(/reaches past the fake/);
      expect(existsSync(mark)).toBe(false);
      expect(r.accepted).toBe(false);
      expect(r.why).toMatch(failed);
      expect(r.why).toMatch(/EPERM|operation not permitted/);
    }, 300_000);

  // The gates read what the candidate cannot write: a score file named by a nonce it never sees, and bun's own summary against the original's.
  const forged = 'console.log(JSON.stringify({ train: { n: 1, core: 1, exact: 1 }, test: { n: 1, core: 1, exact: 1 } })); process.exit(0);';
  test('a candidate that prints a perfect score and exits is not scored by it', () => {
    expect(staticCheck(original, inSend('scoring', forged))).toMatch(/reaches past the fake/);
    const r = judgeOf(inSend('scoring', forged), '', true);
    expect(r.accepted).toBe(false);
    expect(r.why).toMatch(/fails in the sandbox[\s\S]*no score written/);
  }, 300_000);

  test('a candidate that ends the test run with exit 0 mid-way does not pass the tests', () => {
    expect(staticCheck(original, inSend('tests', 'process.exit(0);'))).toMatch(/reaches past the fake/);
    const r = judgeOf(inSend('tests', 'process.exit(0);'), '', true);
    expect(r.accepted).toBe(false);
    expect(r.why).toMatch(/tests fail with it/);
  }, 300_000);

  test('a better candidate is scored in the sandbox above the original, and its tests run there too', () => {
    const r = judgeOf(better);
    expect(r.why).toMatch(/^train /);
    expect(r.accepted).toBe(true);
    expect(r.after!.train.core).toBeGreaterThan(0);
  }, 300_000);
});

describe('grow: what a kept edit may carry, and where it goes', () => {
  test('an edit quoting a string the captures hold, and the public tree does not, is refused', () => {
    const secret = ['quietly', 'shared', 'private', 'words', String(Date.now())].join(' ');
    const leaky = better.replace("const ASSIGNEE_NOTE", `const OVERHEARD = '${secret}';\nconst ASSIGNEE_NOTE`);
    const r = judgeOf(leaky, JSON.stringify([{ out: `they said ${secret}` }]));
    expect(r.accepted).toBe(false);
    expect(r.leaks?.map((l) => l.token)).toEqual([secret]);
  });

  test('a kept edit is written to the grow record as a patch, never over the tracked verbs.ts', async () => {
    const r = await grow({ tree, treeFile: TREE_FILE, roster, model: 'stub', misses: 100, isRead: () => false, sinceDays: 7, edit: async (work) => {
      await Bun.write(join(work, 'verbs.ts'), better);
      return { costUsd: 0 };
    } });
    expect(r.accepted).toBe(true);
    expect(readFileSync(VERBS, 'utf8')).toBe(original);
    expect(r.dir.startsWith(home)).toBe(true);
    expect(readFileSync(join(r.dir, 'verbs.after.ts'), 'utf8')).toBe(better);
    expect(spawnSync('git', ['apply', '--check', r.patch!], { cwd: REPO_ROOT, encoding: 'utf8' }).status).toBe(0);
  }, 300_000);

  // The model is shown train misses only: a held-out session's calls never reach misses.json, so the held-out score stays honest.
  test('a dry grow scores both splits and hands the model train misses alone', async () => {
    const r = await grow({ tree, treeFile: TREE_FILE, roster, model: 'm', misses: 100, isRead: () => false, sinceDays: 7, dry: true });
    const train = sessions.filter((s) => !heldOut(s));
    const held = sessions.filter((s) => heldOut(s));
    expect(r.before.train.n).toBe(train.length);
    expect(r.before.test.n).toBe(held.length);
    const misses = readFileSync(join(r.dir, 'agent', 'agent', 'work', 'misses.json'), 'utf8');
    for (const s of held) expect(misses).not.toContain(`note-${s}`);
    expect(train.some((s) => misses.includes(`note-${s}`))).toBe(true);
    expect(r.accepted).toBe(false);
  });
});
