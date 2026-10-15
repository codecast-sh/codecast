import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import presenterBase from '../../../../cli/src/workflow/presenter.md' with { type: 'text' };
import type { Fixture } from '../../adapters/resolver';
import { REPO_ROOT } from '../../paths';
import { servedReadKey } from '../../served';
import type { AgentOptions, AgentResult, ReplayCtx, ReplayResult } from '../../surface';
import cardWrite, { branchOf, buildChangeRepo, cardDraftOf, cardWritePrompt, HARNESS_NOTE, repDirs, worktreeOf, worldSignals, type CardWriteSnap } from './index';
import { meta } from './meta';

const DIR = join(REPO_ROOT, 'packages', 'evals', 'fixtures', 'card-write');
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ kase: f.replace(/\.json$/, ''), fixture: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture & { snapshot: CardWriteSnap } }));
const snapOf = (kase: string) => fixtures.find((f) => f.kase === kase)!.fixture.snapshot;

const scratch = () => mkdtempSync(join(tmpdir(), 'card-write-'));

/** One write as the recording guard keeps it: argv NUL-separated, the piped body, copies of the files it named. */
function recordWrite(runSubdir: string, n: number, argv: string[], stdin?: string, files: Record<string, string> = {}) {
  const dir = join(runSubdir, 'writes', String(n));
  mkdirSync(join(dir, 'files'), { recursive: true });
  writeFileSync(join(dir, 'argv'), argv.map((a) => `${a}\0`).join(''));
  if (stdin !== undefined) writeFileSync(join(dir, 'stdin'), stdin);
  const tsv: string[] = [];
  Object.entries(files).forEach(([path, content], i) => {
    writeFileSync(join(dir, 'files', String(i + 1)), content);
    tsv.push(`${i + 1}\t${path}`);
  });
  if (tsv.length) writeFileSync(join(dir, 'files.tsv'), `${tsv.join('\n')}\n`);
}

const QUESTION = 'Should shoppers keep their discount when they change shipping?';
const PAGE = '<html><head><link rel="stylesheet" href="cast:decision-kit"></head><body><h2>What the shopper paid</h2><p>84.00 charged, 71.40 shown</p></body></html>';

/** A station run that posted a decision and pinned `fields` as its report. */
function presentedRun(fields: Record<string, unknown>, question = QUESTION): AgentResult {
  const runSubdir = scratch();
  const page = join(runSubdir, 'present', 'page.html');
  mkdirSync(join(runSubdir, 'present'), { recursive: true });
  writeFileSync(page, PAGE);
  recordWrite(runSubdir, 1, ['decide', question, '-o', 'Keep the discount at every step :: 41 charged too much last week', '-o', 'Leave it as it is :: shoppers keep being overcharged', '--context', '-', '--report', page], 'The discount dropped at the shipping step.\n', { [page]: PAGE });
  recordWrite(runSubdir, 2, ['state', '--status', 'done', '-'], `Posted.\n\n\`\`\`json\n${JSON.stringify({ question, page, ...fields })}\n\`\`\`\n`);
  return { runSubdir, said: ['Posted.'], turns: [['Posted.']], wrote: [[]], calls: [], costUsd: 0, modelUsage: {}, isError: false, exitCode: 0, model: meta.model, realMs: 0 };
}

const gatesOf = (snap: CardWriteSnap, agent: AgentResult) => Object.fromEntries(cardWrite.gates(snap, { reply: '', calls: [], agents: [agent] } as ReplayResult).map((g) => [g.id, g]));

describe('card-write fixtures', () => {
  test('each serves the problem, every finding it names, and a change whose counts are the card\'s', () => {
    for (const { kase, fixture } of fixtures) {
      const s = fixture.snapshot;
      expect(s.reads?.some((r) => r.argv.join(' ') === `task context ${s.task.short_id}`), kase).toBe(true);
      expect(worldSignals(s).length, kase).toBe(s.card.cause.signals);
      expect(s.repo.files.length, kase).toBe(s.card.diff.files);
      expect(s.card.recommend.verdict, kase).toBe('' as never);
    }
  });
});

describe('card-write prompt', () => {
  const snap = snapOf('all-green');
  const places = { worktree: '/w', runDir: '/r' };

  test('is the runner\'s briefing for the presenting station, the base presenter and the line\'s addendum, every place filled', () => {
    const prompt = cardWritePrompt(snap, places);
    expect(prompt).toContain(presenterBase.trim().split('\n')[0]!);
    expect(prompt).toContain(`cast task context ${snap.task.short_id}`);
    expect(prompt).toContain(`git diff main...${branchOf(snap.task.short_id)}`);
    expect(prompt).toContain(`path ${worktreeOf(snap.task.short_id)}`);
    expect(prompt).toContain('/r/present/');
    expect(prompt).toContain(`"task":"${snap.task.short_id}"`);
    expect(prompt).not.toMatch(/\$(card|task_id|default_branch|branch|worktree|run_dir)\b/);
  });

  test('a finished card loses exactly the words its author wrote', () => {
    const done = { ...snap.card, headline: 'H', context: 'C', wrong: 'W', change: 'X', recommend: { verdict: 'ship', why: 'Y' } } as typeof snap.card;
    expect(cardDraftOf(done)).toEqual(snap.card);
  });
});

describe('card-write change repository', () => {
  test('holds the base on main and the change on the line\'s branch, so the brief\'s git diff shows it', () => {
    const snap = snapOf('failing-check');
    const dir = buildChangeRepo(join(scratch(), 'worktree'), snap);
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' }).stdout;
    expect(git('diff', '--name-only', `main...${branchOf(snap.task.short_id)}`).trim().split('\n').sort()).toEqual(snap.repo.files.map((f) => f.path).sort());
    expect(git('show', `main:src/cart/merge.ts`)).toBe(snap.repo.files[0]!.before!);
    expect(Date.parse(git('log', '-1', '--format=%cI').trim())).toBeLessThan(Date.parse(snap.captured_at));
  });
});

describe('card-write replay', () => {
  test('runs the station as an agent with the recording guard, its worktree served at the path the brief asks for', async () => {
    const snap = snapOf('all-green');
    const runDir = scratch();
    let sent: AgentOptions | undefined;
    const ctx = {
      dry: true,
      model: meta.model,
      runDir,
      freeze: {} as ReplayCtx['freeze'],
      call: async () => {
        throw new Error('card-write makes no single calls');
      },
      async agent(opts: AgentOptions) {
        sent = opts;
        return presentedRun({ recommend: 'ship', why: 'The proof is green.', covers: ['sg-501'] });
      },
    } satisfies ReplayCtx;
    const out = await cardWrite.replay(snap, ctx);
    expect(sent!.guard).toEndWith('packages/cli/scripts/line-present-replay-bin');
    expect(sent!.model).toBe(meta.model);
    expect(sent!.prompt.endsWith(HARNESS_NOTE)).toBe(true);
    const served = (argv: string[]) => readFileSync(join(sent!.serveDir!, 'reads', `${servedReadKey(argv)}.out`), 'utf8');
    expect(served(['ws', 'path', worktreeOf(snap.task.short_id)]).trim()).toBe(repDirs(runDir).repo);
    expect(served(['signal', 'show', 'sg-501'])).toContain('SAVE15');
    expect(served(['decide', 'kit'])).toContain('decision-kit');
    expect(served(['task', 'show', snap.task.short_id])).toBe(snap.reads![0]!.out);
    expect(served(['signal', 'ls', '--task', snap.task.short_id]).trim().split('\n').map((l) => l.split(' ')[0])).toEqual(['sg-501', 'sg-502', 'sg-503']);
    expect(out.reply).toContain(`Question: ${QUESTION}`);
    expect(out.reply).toContain('What the shopper paid');
  });
});

describe('card-write gates', () => {
  test('a report the record backs holds every gate', () => {
    const g = gatesOf(snapOf('all-green'), presentedRun({ recommend: 'ship', why: 'The failing test now passes.', covers: ['sg-501', 'sg-503'] }));
    expect(Object.values(g).filter((x) => !x.pass).map((x) => `${x.id}: ${x.evidence.summary}`)).toEqual([]);
  });

  test('ship over a failing check is refused, as the run refuses it', () => {
    const g = gatesOf(snapOf('failing-check'), presentedRun({ recommend: 'ship', why: 'Carts merge now.', covers: ['sg-611'] }));
    expect(g['facts-agree']!.pass).toBe(false);
    expect(g['facts-agree']!.evidence.summary).toContain('failing checks');
    expect(gatesOf(snapOf('failing-check'), presentedRun({ recommend: 'revise', why: 'Carts merge, but the wishlist broke.', covers: ['sg-611'] }))['facts-agree']!.pass).toBe(true);
  });

  test('a finding the problem does not hold, a question pinned other than posted, and no report each fail their gate', () => {
    const snap = snapOf('all-green');
    expect(gatesOf(snap, presentedRun({ recommend: 'ship', why: 'w', covers: ['sg-999'] }))['covers-known']!.pass).toBe(false);
    const swapped = presentedRun({ recommend: 'ship', why: 'w', covers: [] });
    recordWrite(swapped.runSubdir, 3, ['state', '--status', 'done', '-'], `x\n\n\`\`\`json\n${JSON.stringify({ question: 'Something else?', recommend: 'ship', why: 'w', covers: [], page: '/nope' })}\n\`\`\`\n`);
    expect(gatesOf(snap, swapped)['question-as-posted']!.pass).toBe(false);
    const none = { ...presentedRun({}), runSubdir: scratch() };
    const g = gatesOf(snap, none);
    expect(g['decision-posted']!.pass).toBe(false);
    expect(g['report-pinned']!.pass).toBe(false);
  });

  test('an internal id on the card fails, wherever it sits', () => {
    const g = gatesOf(snapOf('all-green'), presentedRun({ recommend: 'ship', why: 'w', covers: [] }, 'Ship ct-9101 for shoppers?'));
    expect(g['no-internal-ids']!.pass).toBe(false);
  });
});
