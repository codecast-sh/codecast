import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { fmt } from '@platform/cli-kit/colors';
import { formatCheckLine, runDoctor, type DoctorCheck } from '@platform/cli-kit/doctor';

import { readLocalCredential } from '../../../cli/src/ccKeychain';
import { evalsApiKey } from '../adapters/apiCall';
import { apiConfig } from '../adapters/convo';
import { codecastFreezeStore } from '../adapters/freezes';
import { hasSnapshot, loadLabel, loadSnapshot } from '../adapters/resolver';
import { CALL_MODEL, PROD_DEFAULT_MODEL, PROSE_MODEL, sendsThinkingOff, STRONG_MODEL } from '../models';
import { DRY_RUN_SCRIPT, homePaths, LABELS_REMOTE, REPO_ROOT } from '../paths';
import { surfaces } from '../registry';
import type { SurfaceMeta } from '../surface';
import { labelsRemoteProblem, labelsRepoVisibility } from '../labels';
import { snippetInstalled } from '../snippet';

// What `./evals` needs on this machine, and what is missing. `--init` makes
// EVALS_HOME and its labels repo (cloned from the private remote, or created
// private when it does not exist yet; founder decision sd-319).

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/**
 * The call surfaces whose prod call is not on CALL_MODEL, each with the model prod asks:
 * the Changes prose on PROSE_MODEL (changes.test.ts holds the two to their builders), the
 * line's ground step on STRONG_MODEL (lineGround.ts), and the two that replay a person's
 * own Claude Code session (cast decide, the review station) on that person's default.
 */
const PROD_CALL_MODEL: Record<string, string> = {
  'changes-story': PROSE_MODEL,
  'changes-edition': PROSE_MODEL,
  ground: STRONG_MODEL,
  decide: PROD_DEFAULT_MODEL,
  'review-note': PROD_DEFAULT_MODEL,
};

/** The model prod calls a call surface on: its entry above, else CALL_MODEL. */
export const prodCallModel = (id: string): string => PROD_CALL_MODEL[id] ?? CALL_MODEL;

/** The "model pins" check over a set of surfaces: every call surface pins the model its prod call uses. */
export function modelPinsCheck(all: Pick<SurfaceMeta, 'id' | 'route' | 'model'>[]): { ok: boolean; detail: string } {
  const calls = all.filter((s) => s.route === 'call');
  const off = calls.filter((s) => s.model !== prodCallModel(s.id));
  if (off.length) return { ok: false, detail: `off their prod model: ${off.map((s) => `${s.id}=${s.model}, prod calls ${prodCallModel(s.id)}`).join('; ')}` };
  const by = [...new Set(calls.map((s) => s.model))].map((m) => `${m} (${calls.filter((s) => s.model === m).length})`).join(', ');
  return { ok: true, detail: `call surfaces pin the models prod calls: ${by}` };
}

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
    // Every pin comes from prod's own homes (models.ts).
    run: () => modelPinsCheck(surfaces()),
  },
  {
    name: 'evals API key',
    run: () => {
      // Call reps post prod's exact request with this key; without it, check skips the models prod posts with thinking off.
      const skipped = surfaces().filter((s) => s.route === 'call' && sendsThinkingOff(s.model)).map((s) => s.id);
      return evalsApiKey()
        ? { ok: true, detail: 'call reps post straight to the Messages API' }
        : { ok: false, warn: true, detail: `no key: check skips ${skipped.join(', ') || 'no surface'}`, fix: 'security add-generic-password -s codecast-evals-anthropic-key -a evals -w <key>' };
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
