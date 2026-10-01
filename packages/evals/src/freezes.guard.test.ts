import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditPublicTree } from './adapters/freezes';
import { REPO_ROOT } from './paths';

// The repo is public: what packages/evals commits must be synthetic. This
// runs in CI over the real tree, and proves itself on a planted bad file.

const PKG = join(REPO_ROOT, 'packages', 'evals');

describe('committed freezes and fixtures', () => {
  test('the tree is clean', () => {
    expect(auditPublicTree(PKG)).toEqual([]);
  });

  test('a planted bad freeze fails, naming each problem', () => {
    const copy = mkdtempSync(join(tmpdir(), 'evals-guard-'));
    for (const d of ['freezes', 'fixtures']) cpSync(join(PKG, d), join(copy, d), { recursive: true });
    mkdirSync(join(copy, 'fixtures', 'echo'), { recursive: true });
    writeFileSync(join(copy, 'fixtures', 'echo', 'ok.json'), JSON.stringify({ asOf: '2026-01-01T00:00:00.000Z', snapshot: { text: 'hi' } }));
    const good = { id: 'f1', name: 'echo ok', createdAt: '2026-01-01T00:00:00.000Z', anchor: { kind: 'message', id: 'fixture:ok' }, subject: { kind: 'synthetic', id: 'echo:ok', title: 'echo ok' }, asOf: '2026-01-01T00:00:00.000Z', tags: [], meta: { surface: 'echo', visibility: 'public', snapshot: 'fixtures/echo/ok.json' } };
    writeFileSync(join(copy, 'freezes', 'good.json'), JSON.stringify(good));
    expect(auditPublicTree(copy)).toEqual([]);

    const bad = { ...good, id: 'f2', subject: { kind: 'session', id: 'jx7abcdefghijklmnopqrstuvwxyz012', title: 'x' }, meta: { ...good.meta, conversation_id: 'x', snapshot: 'fixtures/echo/none.json' }, notes: 'n'.repeat(301) };
    writeFileSync(join(copy, 'freezes', 'bad.json'), JSON.stringify(bad));
    writeFileSync(join(copy, 'fixtures', 'echo', 'leak.json'), JSON.stringify({ asOf: '2026-01-01T00:00:00.000Z', snapshot: { text: 'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' } }));
    const problems = auditPublicTree(copy).join('\n');
    expect(problems).toContain('freezes/bad.json: a committed freeze cannot carry "meta.conversation_id"');
    expect(problems).toContain('freezes/bad.json: subject.kind is session, not synthetic');
    expect(problems).toContain('freezes/bad.json: meta.snapshot "fixtures/echo/none.json" is not a committed fixture');
    expect(problems).toContain('freezes/bad.json: notes is 301 characters');
    expect(problems).toContain('freezes/bad.json: looks like a Convex document id');
    expect(problems).toContain('fixtures/echo/leak.json: carries a secret');
  });
});
