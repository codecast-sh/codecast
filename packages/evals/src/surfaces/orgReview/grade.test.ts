import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { routeGates, scoreOf } from '../../adapters/replay';
import { REPO_ROOT } from '../../paths';
import { gate, type AgentResult } from '../../surface';
import { servedReadKey } from '../../served';
import { assembleProposals } from './assemble';
import { buildBriefing, CHECK_SCRIPT } from './build';
import { checkProposal } from './checkProposal';
import { gradeAuto, refuseArchive, type GradeSets } from './grade';
import { meta } from './meta';
import { mergePresentation, parseRubric, parseVerdict, presentationRefusal, RUBRIC_DOC, runSnapshotDir } from './present';

// The org-review port, two ways. The first block is synthetic and runs in CI.
// The second regrades saved rounds from ~/.cache/org-eval with grade.py and
// with `./evals grade` and wants every field equal; it reads the founder's
// archive (never copied into git) and skips where that is absent, CI included.

setDefaultTimeout(300_000);

const INDEX = join(REPO_ROOT, 'packages', 'evals', 'src', 'index.ts');
const MIGRATE = join(import.meta.dir, 'migrate.ts');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

const role = (handle: string, extra: Record<string, unknown> = {}) => ({ change: { kind: 'role', handle, ...extra } });
const close = (task: string) => ({ change: { kind: 'task_status', task, status: 'done' } });

const WORLD = {
  workspace: { name: 'Acme' },
  projects: [
    { id: 'p1', short_id: 'pr-1', title: 'Alpha' },
    { id: 'p2', title: 'Beta' },
  ],
  coverage: { projects: [{ title: 'Alpha', lead: null }, { title: 'Beta', lead: 'ops-lead' }] },
  org: { roles: [{ handle: 'ops-lead', seat: { session: 'jx7aaaa' } }] },
  activity: { stale: { plans: [{ short_id: 'pl-1' }], tasks: [{ short_id: 'ct-1' }, { short_id: 'ct-2' }, { short_id: 'ct-3' }] } },
};
const SETS: GradeSets = { must_not_close: ['ct-9'], should_close: ['ct-1', 'ct-2', 'ct-3'], found_by_a_run: ['pl-1'], name_it: ['jx7bbbb'], never_name: ['jx7cccc'] };

describe('org-review, synthetic', () => {
  test('assemble merges op files by number, prefixes each summary, drops asks', () => {
    const dir = tmp('org-assemble-');
    mkdirSync(join(dir, 'proposals'));
    const op = (n: number, body: object) => writeFileSync(join(dir, 'proposals', `op-${n}.json`), JSON.stringify(body));
    op(10, { summary_md: 'ten', changes: [close('ct-3')], asks: [{ title: 'x', seqs: [1] }] });
    op(2, { title: 'Second', mode: 'init', summary_md: 'two', changes: [close('ct-2')] });
    op(1, { summary_md: null, changes: [close('ct-1')] });
    const out = assembleProposals(dir);
    expect(out).toEqual({ title: 'Second', summary_md: '[op-1] None\n\n[op-2] two\n\n[op-10] ten', mode: 'init', changes: [close('ct-1'), close('ct-2'), close('ct-3')], proposals: 3 });
    expect(JSON.parse(readFileSync(join(dir, 'proposal.json'), 'utf8'))).toEqual(out);
  });

  test('records band on recall of what the inputs flag, and a wrong close zeroes it', () => {
    const two = gradeAuto({ changes: [close('ct-1'), close('ct-2')] }, WORLD, SETS, new Set());
    expect(two.records).toMatchObject({ grade: 2, recall: '2 of 4', right_close: ['ct-1', 'ct-2'], missed: ['ct-3', 'pl-1'] });
    const three = gradeAuto({ changes: [close('ct-1'), close('ct-2'), close('ct-3')] }, WORLD, SETS, new Set());
    expect(three.records.grade).toBe(3);
    const wrong = gradeAuto({ changes: [close('ct-1'), close('ct-2'), close('ct-3'), close('ct-9')] }, WORLD, SETS, new Set());
    expect(wrong.records).toMatchObject({ grade: 0, wrong_close: ['ct-9'] });
  });

  test('sessions, phantom handles, coverage, repeats and words', () => {
    const g = gradeAuto(
      { summary_md: '  A new @growth-lead joins ops-lead; the old infra-lead is gone.\n', changes: [role('growth-lead', { scope: { projects: ['pr-1'] }, seat: { existing: 'jx7bbbb' } }), role('ops-lead', { seat: { existing: 'jx7aaaa' } })] },
      WORLD,
      SETS,
      new Set(['infra-lead']),
    );
    expect(g.sessions).toEqual({ grade: 3, named_ok: ['jx7bbbb'], named_bad: [], named_missing: [] });
    expect(g.roles_named).toEqual({ grade: 0, phantom: ['infra-lead'], mentioned: ['growth-lead', 'infra-lead', 'ops-lead'] });
    expect(g.coverage).toEqual({ before: '1 of 2', after: '2 of 2', still_without_lead: [] });
    expect(g.repeats).toEqual({ seats: ['jx7aaaa'], handles: ['ops-lead'] });
    expect(g.summary_words).toBe(10);
    expect(gradeAuto({ changes: [] }, WORLD, SETS, new Set()).summary_words).toBe(1);
  });

  test('checkProposal names the errors the agent loops on', () => {
    expect(checkProposal({ title: 'x', summary_md: 'y', changes: [{ change: { kind: 'nope' } }] }).errors.length).toBeGreaterThan(0);
  });

  test('the briefing is the prod prompt plus a note that points at checkProposal.ts; promptSha leaves the note out', () => {
    const a = buildBriefing({ inputsText: JSON.stringify(WORLD), workspace: 'acme', served: 'acme-base1', proposalsDir: '/tmp/run-a/proposals', frozen: ['org'] });
    const b = buildBriefing({ inputsText: JSON.stringify(WORLD), workspace: 'acme', served: 'acme-base1', proposalsDir: '/tmp/run-b/proposals', frozen: ['org'] });
    expect(a.briefing.startsWith(a.prompt)).toBe(true);
    expect(a.briefing).toContain(`bun ${CHECK_SCRIPT} <that file>`);
    expect(a.briefing).toContain('/tmp/run-a/proposals/op-<n>.json');
    expect(a.prompt).toContain('Acme');
    expect(a.hashes.promptSha).toBe(b.hashes.promptSha);
    expect(a.hashes.prompt).toBe(a.hashes.promptSha.slice(0, 12));
    expect(existsSync(CHECK_SCRIPT)).toBe(true);
  });

  test('stale watches the prompt text and the spec, not only the builder that wraps them', () => {
    for (const p of ['packages/shared/contracts/headOfPeoplePrompt.ts', 'packages/shared/contracts/orgProposal.ts', 'packages/cli/src/orgInitRun.ts']) {
      expect(meta.sources).toContain(p);
      expect(existsSync(join(REPO_ROOT, p))).toBe(true);
    }
  });

  test("the brief the prompt asks the analyzer to write is its own; any other write still fails", () => {
    const agent = (calls: string[]): AgentResult => ({ runSubdir: '/tmp/a', said: [], turns: [[]], calls, costUsd: 0, modelUsage: { [meta.model]: { outputTokens: 1 } }, isError: false, exitCode: 0, model: meta.model, realMs: 0 });
    const writes = (line: string) => routeGates(meta, { calls: [], agents: [agent([line])] }).find((g) => g.id === 'no-unexpected-writes')!.pass;
    expect(writes('REFUSED brief edit -')).toBe(true);
    expect(writes('REFUSED brief edit - --team Union')).toBe(true);
    expect(writes('REFUSED brief --team Union edit -')).toBe(true);
    expect(writes('REFUSED task update ct-1 -s done')).toBe(false);
    expect(writes('REFUSED briefing edit -')).toBe(false);
  });

  test('grading and capture refuse a dir inside the archive, and only there', () => {
    const archive = tmp('org-archive-');
    mkdirSync(join(archive, 'union', 'round-1', 's1'), { recursive: true });
    expect(() => refuseArchive(join(archive, 'union', 'round-1', 's1'), archive)).toThrow('untouched archive');
    expect(() => refuseArchive(archive, archive)).toThrow('untouched archive');
    expect(() => refuseArchive(tmp('org-copy-'), archive)).not.toThrow();
  });

  test("a run's snapshot is the one its hashes.json names, by served and workspace", () => {
    const home = tmp('org-snaps-');
    const prev = process.env.CODECAST_EVALS_HOME;
    process.env.CODECAST_EVALS_HOME = home;
    try {
      for (const ws of ['union', 'codecast']) {
        const d = join(home, 'snapshots', 'org-review', `${ws}-base3`);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'captured.json'), JSON.stringify({ workspace: ws }));
      }
      const run = (hashes: object) => {
        const d = tmp('org-run-');
        writeFileSync(join(d, 'hashes.json'), JSON.stringify(hashes));
        return runSnapshotDir(d);
      };
      const snaps = join(home, 'snapshots', 'org-review');
      expect(run({ served: 'codecast-base3', workspace: 'codecast' })).toBe(join(snaps, 'codecast-base3'));
      expect(run({ served: 'base3', workspace: 'codecast' })).toBe(join(snaps, 'codecast-base3'));
      expect(run({ served: 'base3', workspace: 'union' })).toBe(join(snaps, 'union-base3'));
      // An old round that names no workspace and a served name two workspaces share is ambiguous.
      expect(run({ served: 'base3' })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CODECAST_EVALS_HOME;
      else process.env.CODECAST_EVALS_HOME = prev;
    }
  });

  test('the rubric is read from org-eval.md, and a verdict maps to one check per line', () => {
    const rubric = parseRubric(readFileSync(RUBRIC_DOC, 'utf8'));
    expect(rubric.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rubric[6]!.text).toBe('Phone: the same, at 390 wide.');
    const checks = parseVerdict(['looked at it', '{"lines": [{"n": 1, "score": 3, "reasoning": "clear"}, {"n": 7, "score": 1}]}'], rubric);
    expect(checks.map((c) => [c.id, c.score])).toEqual([['presentation:1', 1], ['presentation:2', 0], ['presentation:3', 0], ['presentation:4', 0], ['presentation:5', 0], ['presentation:6', 0], ['presentation:7', 1 / 3]]);
  });

  test('presentation checks are shown but never move the substance score a rep is compared on', () => {
    const rubric = parseRubric(readFileSync(RUBRIC_DOC, 'utf8'));
    const checks = parseVerdict(['{"lines": [{"n": 1, "score": 0}, {"n": 2, "score": 0}]}'], rubric);
    const dir = mkdtempSync(join(tmpdir(), 'org-present-'));
    try {
      const substance = scoreOf([gate('ok', true, 'clean')], [{ id: 'records', ask: 'records', weight: 1, score: 1 }, { id: 'coverage', ask: 'coverage', weight: 1, score: 0.5 }]);
      writeFileSync(join(dir, 'score.json'), JSON.stringify(substance));
      const merged = mergePresentation(dir, checks)!;
      expect(merged.score).toBe(substance.score);
      expect(merged.checks.filter((c) => c.id.startsWith('presentation:'))).toHaveLength(rubric.length);
      expect(JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8')).score).toBe(0.75);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('presentation refuses with one line when the dev server or the bridge is missing', async () => {
    const noServer = await presentationRefusal({ url: 'http://127.0.0.1:9', bridgeFile: '/nonexistent' });
    expect(noServer).toContain('nothing answers on http://127.0.0.1:9');
    expect(noServer!.split('\n')).toHaveLength(1);
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      const noBridge = await presentationRefusal({ url: `http://127.0.0.1:${server.port}`, bridgeFile: '/nonexistent/bridge.json' });
      expect(noBridge).toContain("founder's Chrome");
      expect(noBridge!.split('\n')).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test('a dry check replays a snapshot freeze end to end and grades the run folder', () => {
    const home = tmp('org-home-');
    const snap = join(home, 'snapshots', 'org-review', 'acme-base1');
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, 'org-inputs.json'), JSON.stringify(WORLD));
    writeFileSync(join(snap, 'frozen'), 'org\n');
    writeFileSync(join(snap, 'captured.json'), JSON.stringify({ argv: [], captured_at: '2026-01-01T00:00:00.000Z', workspace: 'acme' }));
    mkdirSync(join(home, 'labels', 'org-review', 'acme'), { recursive: true });
    writeFileSync(join(home, 'labels', 'org-review', 'acme', 'grade-sets.json'), JSON.stringify(SETS));
    const env = { ...process.env, CODECAST_EVALS_HOME: home, CODECAST_DIR: tmp('org-nocast-'), NO_COLOR: '1' };
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(['bun', INDEX, ...args], { env });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const created = run('freeze', 'create', 'org-review@acme-base1', '--json');
    expect(created.err).toBe('');
    const f = JSON.parse(created.out);
    expect(f.meta).toMatchObject({ surface: 'org-review', visibility: 'private', snapshot: 'org-review/acme-base1', workspace: 'acme' });
    const missing = run('freeze', 'create', 'org-review@nope');
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain('no org-review snapshot nope here (have: acme-base1)');

    run('check', 'org-review', '--dry', '--reps', '1', '--freeze', f.id.slice(0, 8));
    const runs = readdirSync(join(home, 'runs')).filter((n) => n.startsWith('org-review-'));
    expect(runs).toHaveLength(1);
    const dir = join(home, 'runs', runs[0]!);
    const score = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'));
    const gates = Object.fromEntries(score.gates.map((g: { id: string; pass: boolean }) => [g.id, g.pass]));
    // A dry agent writes no proposal: the wiring holds and the run says so.
    expect(gates).toMatchObject({ 'frozen-reads': true, 'spec-parses': false, 'no-wrong-close': true });
    expect(score.checks.map((c: { id: string }) => c.id)).toEqual(['records', 'sessions', 'roles_named', 'coverage', 'repeats', 'summary_words']);
    const hashes = JSON.parse(readFileSync(join(dir, 'hashes.json'), 'utf8'));
    expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).promptSha).toBe(hashes.promptSha);
    expect(readFileSync(join(dir, 'agent1', 'prompt.md'), 'utf8')).toContain(`${dir}/proposals/op-<n>.json`);
    expect(JSON.parse(readFileSync(join(dir, 'grade-auto.json'), 'utf8')).records.recall).toBe('0 of 4');

    // The same folder regrades through `./evals grade`, which finds the freeze in its run.json.
    const regraded = run('grade', 'org-review', dir, '--json');
    expect(JSON.parse(regraded.out).gates.map((g: { id: string }) => g.id)).toEqual(['spec-parses', 'no-wrong-close', 'no-never-name', 'no-phantom-handle', 'frozen-reads']);
  });
});

const CACHE = join(homedir(), '.cache', 'org-eval');
const GRADE_PY = join(CACHE, 'bin', 'grade.py');
const haveArchive = existsSync(join(CACHE, 'union', 'round-36')) && existsSync(join(CACHE, 'union', 'round-35')) && existsSync(GRADE_PY) && Bun.which('python3') !== null;

describe.skipIf(!haveArchive)('org-review regrade against grade.py (founder archive)', () => {
  const root = tmp('org-regrade-');
  // grade.py finds its workspace from the run dir's path under ~/.cache/org-eval, so it runs with HOME at a
  // scratch dir whose union/ links to the real labels, served dirs and rounds (its pool) and holds the copies.
  // Nothing under ~/.cache/org-eval is written.
  const pyWs = join(root, 'pyhome', '.cache', 'org-eval', 'union');
  mkdirSync(join(pyWs, 'regrade'), { recursive: true });
  for (const n of readdirSync(join(CACHE, 'union')).filter((n) => n === 'grade-sets.json' || n === 'served' || n.startsWith('round-'))) symlinkSync(join(CACHE, 'union', n), join(pyWs, n));
  const home = join(root, 'evals-home');
  const env = { ...process.env, CODECAST_EVALS_HOME: home, CODECAST_DIR: tmp('org-nocast-'), NO_COLOR: '1' };
  const spawn = (cmd: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(cmd, { env: { ...env, ...extra } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  let freezeId = '';
  // Every file under the two rounds, with its size and mtime: grading must change none of them.
  const archiveStamp = () =>
    [35, 36].flatMap((r) => [...new Bun.Glob('**/*').scanSync({ cwd: join(CACHE, 'union', `round-${r}`), onlyFiles: true, dot: true })].sort().map((f) => {
      const st = statSync(join(CACHE, 'union', `round-${r}`, f));
      return `${r}/${f} ${st.size} ${st.mtimeMs}`;
    }));
  const stampBefore = archiveStamp();

  test('migrate copies labels and base8 into a scratch EVALS_HOME, and the freeze resolves', () => {
    const m = spawn(['bun', MIGRATE, '--no-commit']);
    expect(m.code).toBe(0);
    expect(existsSync(join(home, 'labels', 'org-review', 'union', 'grade-sets.json'))).toBe(true);
    expect(existsSync(join(home, 'snapshots', 'org-review', 'union-base8', 'org-inputs.json'))).toBe(true);
    // Each served read holds the legacy file's bytes unchanged, and the snapshot is read-only like `./evals snapshot`'s.
    const snap = join(home, 'snapshots', 'org-review', 'union-base8');
    const captured = JSON.parse(readFileSync(join(snap, 'captured.json'), 'utf8')) as { argv: string[][] };
    expect(captured.argv.map((a) => a.slice(0, 2).join(' '))).toEqual(['org inputs', 'org health', 'org ls']);
    for (const [argv, legacy] of captured.argv.map((a, i) => [a, ['org-inputs.json', 'org-health.json', 'org-ls.json'][i]!] as const)) {
      const key = servedReadKey(argv);
      expect(Buffer.compare(readFileSync(join(snap, 'reads', `${key}.out`)), readFileSync(join(CACHE, 'union', 'served', 'base8', legacy)))).toBe(0);
      expect(readFileSync(join(snap, 'reads', `${key}.exit`), 'utf8')).toBe('0\n');
    }
    expect(readFileSync(join(snap, 'frozen'), 'utf8')).toBe(`${meta.frozenVerbs!.join('\n')}\n`);
    for (const f of new Bun.Glob('**/*').scanSync({ cwd: snap, onlyFiles: true })) expect(statSync(join(snap, f)).mode & 0o777).toBe(0o444);
    const f = spawn(['bun', INDEX, 'freeze', 'create', 'org-review@union-base8', '--json']);
    expect(f.err).toBe('');
    freezeId = JSON.parse(f.out).id;
  });

  const regrade = (round: number, s: number) => {
    const src = join(CACHE, 'union', `round-${round}`, `s${s}`);
    const served = JSON.parse(readFileSync(join(src, 'hashes.json'), 'utf8')).served as string;
    const py = join(pyWs, 'regrade', `r${round}-s${s}`);
    cpSync(src, py, { recursive: true });
    rmSync(join(py, 'grade-auto.json'), { force: true });
    const p = spawn(['python3', GRADE_PY, py, served], { HOME: join(root, 'pyhome') });
    expect(p.code).toBe(0);
    const ts = join(root, 'ts', `r${round}-s${s}`);
    cpSync(src, ts, { recursive: true });
    // Each grader must write its own result, and the TS one must assemble proposal.json from proposals/ itself.
    for (const f of ['grade-auto.json', 'proposal.json']) rmSync(join(ts, f), { force: true });
    const g = spawn(['bun', INDEX, 'grade', 'org-review', ts, '--freeze', freezeId, '--json']);
    expect(g.err).toBe('');
    return {
      python: JSON.parse(readFileSync(join(py, 'grade-auto.json'), 'utf8')),
      ts: JSON.parse(readFileSync(join(ts, 'grade-auto.json'), 'utf8')),
      assembled: { python: JSON.parse(readFileSync(join(src, 'proposal.json'), 'utf8')), ts: JSON.parse(readFileSync(join(ts, 'proposal.json'), 'utf8')) },
      score: JSON.parse(g.out) as { pass: boolean; gates: Array<{ id: string; pass: boolean; evidence: { summary: string } }> },
    };
  };

  for (const s of [1, 2, 3]) {
    test(`round 36 s${s}: every field of grade-auto.json equals grade.py's, and no record is closed wrongly`, () => {
      const r = regrade(36, s);
      expect(r.ts).toEqual(r.python);
      expect(r.assembled.ts).toEqual(r.assembled.python);
      expect(r.score.gates.find((g) => g.id === 'no-wrong-close')!.pass).toBe(true);
    });
  }

  for (const s of [1, 2, 3]) {
    test(`round 35 s${s}: fails no-wrong-close on ct-49328`, () => {
      const r = regrade(35, s);
      expect(r.ts).toEqual(r.python);
      const wrong = r.score.gates.find((g) => g.id === 'no-wrong-close')!;
      expect(wrong.pass).toBe(false);
      expect(wrong.evidence.summary).toContain('ct-49328');
      expect(r.score.pass).toBe(false);
    });
  }

  test('./evals grade refuses a round inside the archive', () => {
    const g = spawn(['bun', INDEX, 'grade', 'org-review', join(CACHE, 'union', 'round-36', 's1'), '--freeze', freezeId, '--json']);
    expect(g.code).not.toBe(0);
    expect(g.err).toContain('untouched archive');
  });

  test('the archive is untouched', () => {
    expect(archiveStamp()).toEqual(stampBefore);
  });
});
