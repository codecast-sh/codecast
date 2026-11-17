import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { Command } from 'commander';

import { readTree } from '../fakes/cast/tree';
import { captureRoster, capturesDir, type Roster, capturesFrom, localTranscripts, pairsFromJsonl, readCaptures, remotePairs, writeCaptures, type Capture } from '../fakes/capture';
import { byVerb, CONTEXT, heldOut, scoreSession, type CallScore } from '../fakes/fidelity';
import { grow } from '../fakes/grow';
import { evalsHome, GUARD_CAST, writeJsonAtomic } from '../paths';

// `./evals fakes`: the record a fake `cast` is written from, and how faithful
// it is. capture pulls real calls and answers out of transcripts (nothing new
// records anything); fidelity replays held-out sessions through the fake and
// says, per verb, how often it answered as prod did.

export const fakesHome = (root = evalsHome()): string => join(root, 'fakes');
/** The CLI's command tree the fake parses with, as of the last capture. */
export const treePath = (root = evalsHome()): string => join(fakesHome(root), 'cli-tree.json');
/** The workspace's roles at the last capture, the roster a fake world is seeded with. */
export const rosterPath = (root = evalsHome()): string => join(fakesHome(root), 'roster.json');

/** Whether the dry-run guard takes an argv for a read: the one answer to that question (DRY_RUN_CLASSIFY). */
export function guardIsRead(): (argv: string[]) => boolean {
  const seen = new Map<string, boolean>();
  return (argv) => {
    const key = JSON.stringify(argv);
    if (!seen.has(key)) seen.set(key, spawnSync('bash', [GUARD_CAST, ...argv], { env: { ...process.env, DRY_RUN_CLASSIFY: '1' }, encoding: 'utf8' }).stdout.trim() === 'read');
    return seen.get(key)!;
  };
}

/** The installed CLI's command tree, read under an empty state dir so nothing signs in. */
async function snapshotTree(): Promise<number> {
  const state = mkdtempSync(join(tmpdir(), 'fakes-tree-'));
  try {
    const proc = Bun.spawn(['cast', 'agent-context', '--json'], { env: { ...process.env, CODECAST_DIR: state, CODECAST_NO_AUTO_UPDATE: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`cast agent-context --json exited ${code}`);
    mkdirSync(fakesHome(), { recursive: true });
    writeFileSync(treePath(), out);
    return JSON.parse(out).commands.length;
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

const misses_n = (opts: { misses: string; verb?: string }): number => (opts.verb ? Math.max(Number(opts.misses), 10) : Number(opts.misses));

const pct = (a: number, b: number): string => (b ? `${Math.round((100 * a) / b)}%` : '-');

export function registerFakes(program: Command): void {
  const fakes = program
    .command('fakes')
    .description('fake services written from real calls: capture the record, score the fake on held-out calls')
    .addHelpText('after', '\nThe loop: capture; fidelity --split train --misses 20 shows what the fake gets wrong; fix it in src/fakes/cast/verbs.ts; fidelity (held-out, --since 3 for the CLI as it is now) is the score.\nAgent reps run against the fake with ./evals check role-wake --fakes (or anchor-brief).');

  fakes
    .command('capture')
    .description('pull real cast calls and their answers from transcripts into EVALS_HOME/fakes/captures')
    .option('--no-local', "skip this machine's Claude Code transcripts")
    .option('--session <id...>', 'also read these sessions through cast read --full (any machine)')
    .option('--roles', "also read every role's standing session in your teams (the sessions role-wake replays)")
    .option('--limit <n>', 'newest messages read per --session', '3000')
    .action(async (opts: { local: boolean; session?: string[]; roles?: boolean; limit: string }) => {
      const dir = capturesDir();
      const seen = new Set<string>();
      let calls = 0;
      let sessions = 0;
      const keep = (session: string, caps: Capture[]) => {
        if (!caps.length) return;
        writeCaptures(dir, session, caps);
        calls += caps.length;
        sessions++;
      };
      const roster = await captureRoster();
      const remote = [...new Set([...(opts.session ?? []), ...(opts.roles ? Object.values(roster.roles).map((r) => r.session) : [])])];
      for (const id of remote) {
        try {
          keep(id, capturesFrom(id, await remotePairs(id, Number(opts.limit)), 'cast', seen));
        } catch (e) {
          console.log(`skipped ${id}: ${(e as Error).message.slice(0, 160)}`);
        }
      }
      if (opts.local) for (const f of localTranscripts()) keep(`local-${basename(f, '.jsonl')}`, capturesFrom(`local-${basename(f, '.jsonl')}`, pairsFromJsonl(readFileSync(f, 'utf8')), 'cast', seen));
      const commands = await snapshotTree();
      writeJsonAtomic(rosterPath(), roster);
      console.log(`${calls} calls from ${sessions} sessions in ${dir}`);
      console.log(`roster: ${Object.keys(roster.roles).length} roles, ${Object.keys(roster.people).length} people in ${rosterPath()}`);
      console.log(`command tree: ${commands} commands in ${treePath()}`);
    });

  fakes
    .command('fidelity')
    .description('replay held-out sessions through the fake: per verb, how often it answered as prod did')
    .option('--split <split>', 'test (held-out sessions, the score), train (the sessions a fake is grown on: read misses here), or all', 'test')
    .option('--from <source>', "local (this machine's transcripts), remote (sessions read with cast read), or all", 'all')
    .option('--since <days>', 'only calls from the last N days (the fake follows the CLI as it is now)')
    .option('--after <time>', "only calls made after this ISO time: a grow's `at`, so the score is on calls captured after the edit")
    .option('--verb <verb>', 'one verb, with each miss shown')
    .option('--misses <n>', 'show up to n misses', '0')
    .option('--json', 'machine-readable')
    .action((opts: { split: string; from: string; since?: string; after?: string; verb?: string; misses: string; json?: boolean }) => {
      const tree = readTree(treePath());
      if (!tree) throw new Error(`no command tree at ${treePath()}: run ./evals fakes capture first`);
      const all = readCaptures();
      if (!all.length) throw new Error(`no captures in ${capturesDir()}: run ./evals fakes capture first`);
      const since = opts.since ? new Date(Date.now() - Number(opts.since) * 86_400_000).toISOString() : '';
      if (!['test', 'train', 'all'].includes(opts.split)) throw new Error(`--split is test, train or all, not ${opts.split}`);
      const fromOk = (session: string) => opts.from === 'all' || session.startsWith('local-') === (opts.from === 'local');
      const test = all.filter((s) => s.length && fromOk(s[0]!.session) && (opts.split === 'all' || heldOut(s[0]!.session) === (opts.split === 'test')));
      const roster: Roster = existsSync(rosterPath()) ? JSON.parse(readFileSync(rosterPath(), 'utf8')) : { roles: {}, people: {} };
      const isRead = guardIsRead();
      const calls: CallScore[] = test
        .flatMap((s) => scoreSession(s, tree, roster, { isRead }))
        .filter((c) => !since || (c.at ?? '') >= since)
        .filter((c) => !opts.after || (c.at ?? '') > opts.after)
        .filter((c) => !opts.verb || c.verb === opts.verb);
      const verbs = byVerb(calls);
      if (opts.json) {
        console.log(JSON.stringify({ sessions: test.length, verbs, calls: calls.filter((c) => !c.core) }, null, 1));
        return;
      }
      const sum = verbs.reduce((a, v) => ({ n: a.n + v.n, answered: a.answered + v.answered, exact: a.exact + v.exact, core: a.core + v.core, exitN: a.exitN + v.exitN, exitAgree: a.exitAgree + v.exitAgree }), { n: 0, answered: 0, exact: 0, core: 0, exitN: 0, exitAgree: 0 });
      console.log(`${{ test: 'held-out', train: 'train', all: 'all' }[opts.split]} sessions: ${test.length} · calls to modelled verbs: ${sum.n}`);
      console.log(`${'verb'.padEnd(18)}${'calls'.padStart(6)}${'answered'.padStart(10)}${'exact'.padStart(8)}${'core'.padStart(8)}${'exit'.padStart(8)}`);
      for (const v of verbs) console.log(`${v.verb.padEnd(18)}${String(v.n).padStart(6)}${pct(v.answered, v.n).padStart(10)}${pct(v.exact, v.n).padStart(8)}${pct(v.core, v.n).padStart(8)}${`${pct(v.exitAgree, v.exitN)}`.padStart(8)}`);
      console.log(`${'all'.padEnd(18)}${String(sum.n).padStart(6)}${pct(sum.answered, sum.n).padStart(10)}${pct(sum.exact, sum.n).padStart(8)}${pct(sum.core, sum.n).padStart(8)}${pct(sum.exitAgree, sum.exitN).padStart(8)}`);
      console.log(`core drops what prod adds from outside the calls: ${CONTEXT.map((c) => c.why).join('; ')}`);
      if (misses_n(opts) && opts.split !== 'train') console.log('reading held-out misses spends them: grow the fake from --split train');
      const misses = calls.filter((c) => !c.core).slice(0, misses_n(opts));
      for (const m of misses) {
        console.log(`\n── ${m.session} #${m.seq}: cast ${m.argv.join(' ').slice(0, 160)}`);
        console.log(`real │ ${m.real.slice(0, 600).split('\n').join('\n     │ ')}`);
        console.log(`fake │ ${m.answered ? m.fake.slice(0, 600).split('\n').join('\n     │ ') : '(declined)'}`);
      }
    });

  fakes
    .command('grow')
    .description('a model edits a copy of verbs.ts from the train misses; scored and tested in a sandbox, the edit is kept (as a patch in the grow record, for a person to apply) only if it carries no real data, train fidelity rises, held-out does not drop and the tests pass')
    .option('--model <id>', 'the model that edits', 'claude-opus-5-5')
    .option('--misses <n>', 'train misses shown to it', '40')
    .option('--since <days>', 'learn from and score only calls of the last N days (the CLI as it is now)', '7')
    .option('--dry', 'write the brief and the misses, run no model')
    .action(async (opts: { model: string; misses: string; since: string; dry?: boolean }) => {
      const tree = readTree(treePath());
      if (!tree) throw new Error(`no command tree at ${treePath()}: run ./evals fakes capture first`);
      const roster: Roster = existsSync(rosterPath()) ? JSON.parse(readFileSync(rosterPath(), 'utf8')) : { roles: {}, people: {} };
      const r = await grow({ tree, treeFile: treePath(), roster, model: opts.model, misses: Number(opts.misses), isRead: guardIsRead(), sinceDays: Number(opts.since), dry: opts.dry });
      console.log(`before: train ${r.before.train.core}/${r.before.train.n} core, held-out ${r.before.test.core}/${r.before.test.n}`);
      if (r.after) console.log(`after:  train ${r.after.train.core}/${r.after.train.n} core, held-out ${r.after.test.core}/${r.after.test.n}`);
      console.log(`${r.accepted ? 'kept' : 'not kept'}: ${r.why}${r.costUsd ? ` ($${r.costUsd.toFixed(2)})` : ''}`);
      console.log(`record: ${r.dir}`);
      if (r.leaks?.length) for (const l of r.leaks) console.log(`  leak ${l.token} │ ${l.line.slice(0, 160)}`);
      if (r.accepted) {
        console.log(`the edit is not applied: read ${r.patch}, then apply it from the repo root with git apply ${r.patch}`);
        console.log(`the honest score comes later, on calls captured after the edit: ./evals fakes capture, then ./evals fakes fidelity --split all --after ${r.at}`);
      }
    });
}
