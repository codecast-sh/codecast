import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { fmt } from '@platform/cli-kit/colors';
import { formatCheckLine, runDoctor, type DoctorCheck } from '@platform/cli-kit/doctor';

import { readLocalCredential } from '../../../cli/src/ccKeychain';
import { apiConfig } from '../adapters/convo';
import { codecastFreezeStore } from '../adapters/freezes';
import { hasSnapshot, loadLabel, loadSnapshot } from '../adapters/resolver';
import { CHEAP_MODEL, STRONG_MODEL } from '../../../convex/convex/lib/anthropic';
import { CALL_MODEL, PROSE_MODEL } from '../models';
import { DRY_RUN_SCRIPT, homePaths, LABELS_REMOTE, REPO_ROOT } from '../paths';
import { surfaces } from '../registry';
import { labelsRemoteProblem, labelsRepoVisibility } from '../labels';
import { snippetInstalled } from '../snippet';

// What `./evals` needs on this machine, and what is missing. `--init` makes
// EVALS_HOME and its labels repo (cloned from the private remote, or created
// private when it does not exist yet; founder decision sd-319).

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function labelsCheck(): ReturnType<DoctorCheck['run']> {
  const dir = homePaths().labels;
  if (!existsSync(join(dir, '.git'))) return { ok: false, detail: `${dir} is not a git repo`, fix: './evals doctor --init' };
  const problem = labelsRemoteProblem(dir);
  if (problem) return { ok: false, detail: problem, fix: `git -C ${dir} remote set-url origin git@github.com:${LABELS_REMOTE}.git` };
  const dirty = git(dir, ['status', '--porcelain']).stdout.trim();
  const ahead = git(dir, ['rev-list', '--count', '@{u}..HEAD']).stdout.trim();
  if (dirty || (ahead && ahead !== '0')) return { ok: false, detail: `labels have ${dirty ? 'uncommitted changes' : ''}${dirty && ahead !== '0' ? ' and ' : ''}${ahead && ahead !== '0' ? `${ahead} unpushed commit(s)` : ''}`, fix: `git -C ${dir} add -A && git -C ${dir} commit -m labels && git -C ${dir} push` };
  return { ok: true, detail: `${dir} tracks ${LABELS_REMOTE}, clean and pushed` };
}

export const CHECKS: DoctorCheck[] = [
  {
    name: 'platform mirror',
    run: () => (existsSync(join(REPO_ROOT, 'platform', 'packages', 'evals', 'package.json')) ? { ok: true, detail: '@platform/evals resolves from platform/packages/evals' } : { ok: false, detail: 'platform/packages/evals is missing', fix: 'scripts/vendor-platform.sh' }),
  },
  {
    name: 'cast auth',
    run: () => {
      try {
        apiConfig();
        return { ok: true, detail: 'signed in; real moments can be read' };
      } catch (e) {
        return { ok: false, warn: true, detail: (e as Error).message, fix: 'cast auth' };
      }
    },
  },
  { name: 'claude', run: () => (Bun.which('claude') ? { ok: true, detail: Bun.which('claude')! } : { ok: false, detail: 'claude is not on PATH; no replay can run', fix: 'install Claude Code' }) },
  {
    name: 'login',
    run: () =>
      process.platform !== 'darwin'
        ? { ok: false, warn: true, detail: 'no keychain here: the harness needs --account <profile> for a saved setup token' }
        : readLocalCredential()
          ? { ok: true, detail: 'a Claude Code login is in the keychain' }
          : { ok: false, detail: 'no Claude Code login in the keychain', fix: 'run `claude` once and sign in' },
  },
  { name: 'EVALS_HOME', run: () => (existsSync(homePaths().root) ? { ok: true, detail: homePaths().root } : { ok: false, detail: `${homePaths().root} does not exist`, fix: './evals doctor --init' }) },
  { name: 'labels repo', run: labelsCheck, dependsOn: ['EVALS_HOME'], timeoutMs: 15_000 },
  {
    name: 'freezes here',
    run: async () => {
      const all = await codecastFreezeStore().list();
      const missing = all.filter((f) => !hasSnapshot(f));
      const unlabelled = all.filter((f) => {
        if (f.judge || !hasSnapshot(f)) return false;
        try {
          return loadLabel(f, loadSnapshot(f)) === undefined;
        } catch {
          return false;
        }
      });
      const detail = `${all.length} freezes; ${missing.length} without a snapshot here, ${unlabelled.length} with neither label nor criteria`;
      return missing.length ? { ok: false, warn: true, detail, fix: `missing: ${missing.map((f) => f.id.slice(0, 8)).join(', ')}` } : { ok: true, detail };
    },
  },
  {
    name: 'harness pins --model',
    run: () => {
      // Spawn only when the harness refuses an unpinned run; an older harness would start a real, unpinned claude.
      if (!readFileSync(DRY_RUN_SCRIPT, 'utf8').includes('--model is required')) return { ok: false, detail: 'prompt-dry-run.ts runs without --model (U3 has not landed)', fix: 'land U3: --model required, --call, --max-output-tokens' };
      const dir = mkdtempSync(join(tmpdir(), 'evals-doctor-'));
      writeFileSync(join(dir, 'p.md'), 'Reply with the word ok.');
      const r = spawnSync('bun', [DRY_RUN_SCRIPT, '--run', join(dir, 'run'), '--prompt', join(dir, 'p.md')], { encoding: 'utf8', timeout: 30_000 });
      return r.status === 2 ? { ok: true, detail: 'prompt-dry-run.ts without --model exits 2' } : { ok: false, detail: `prompt-dry-run.ts without --model exited ${r.status}` };
    },
    timeoutMs: 35_000,
  },
  {
    name: 'model pins',
    run: () => {
      // Every call surface pins a model prod calls with (the cheap one, or the strong one the Changes prose asks; changes.test.ts holds each to its builder).
      const prod = new Set([CHEAP_MODEL, STRONG_MODEL]);
      const calls = surfaces().filter((s) => s.route === 'call');
      const off = calls.filter((s) => !prod.has(s.model));
      const by = [...prod].map((m) => `${m} (${calls.filter((s) => s.model === m).length})`).join(', ');
      return CALL_MODEL === CHEAP_MODEL && PROSE_MODEL === STRONG_MODEL && !off.length ? { ok: true, detail: `call surfaces pin the models prod calls: ${by}` } : { ok: false, detail: `off the prod models: ${off.map((s) => `${s.id}=${s.model}`).join(', ') || 'models.ts pins'}` };
    },
  },
  { name: 'agent snippet', run: () => (snippetInstalled() === 'current' ? { ok: true, detail: 'AGENTS.md carries the current reference' } : { ok: false, warn: true, detail: `AGENTS.md section ${snippetInstalled()}`, fix: './evals snippet install' }) },
];

/** Makes EVALS_HOME and its labels repo: clone the private remote, or create it private first. */
function init(): void {
  const home = homePaths();
  for (const d of [home.root, home.freezes, home.snapshots, home.runs, home.html]) mkdirSync(d, { recursive: true });
  if (existsSync(join(home.labels, '.git'))) return;
  const visibility = labelsRepoVisibility();
  if (visibility === null) {
    console.log(`creating the private repo ${LABELS_REMOTE}`);
    const created = spawnSync('gh', ['repo', 'create', LABELS_REMOTE, '--private', '--description', 'codecast eval labels (private; never in the public repo)'], { stdio: 'inherit' });
    if (created.status !== 0) throw new Error(`gh repo create ${LABELS_REMOTE} failed`);
  } else if (visibility !== 'PRIVATE') {
    throw new Error(`${LABELS_REMOTE} exists and is ${visibility}: labels go only to a private repo`);
  }
  const cloned = spawnSync('gh', ['repo', 'clone', LABELS_REMOTE, home.labels], { stdio: 'inherit' });
  if (cloned.status !== 0) throw new Error(`cloning ${LABELS_REMOTE} into ${home.labels} failed`);
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('what the evals need here, and what is missing')
    .option('--init', 'create EVALS_HOME and clone (or create, private) the labels repo')
    .action(async (flags: { init?: boolean }) => {
      if (flags.init) init();
      const report = await runDoctor(CHECKS, { product: 'evals', version: '0.1.0', onCheck: (c) => console.log(formatCheckLine(c, { color: { success: fmt.success, warning: fmt.warning, error: fmt.error, muted: fmt.muted } })) });
      if (!report.ok) process.exitCode = 1;
      // The first failure's fix, then the first warning's; with nothing to fix, the status view.
      const fix = (status: string) => report.checks.find((c) => c.status === status && c.fix)?.fix;
      console.log(`\nNext: ${fix('fail') ?? fix('warn') ?? './evals'}`);
    });
}
