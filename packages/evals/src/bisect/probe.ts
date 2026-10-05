import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Candidate, RenderClass } from '@codecast/shared/contracts/evalsApi';

import { baseLoadErrors, checkArgs, dropBaseTree, prepareTreeAt, type TreeCheck } from '../commands/line';
import { renderBatch as renderBatchAt, renderClasses as renderClassesWith, treeLabel, type ProbeEnv as CoreProbeEnv, type RenderHook, type Tree } from '../core/bisect';
import { indexedRuns } from '../history/runIndex';
import { homePaths, REPO_ROOT } from '../paths';
import { gitHead } from '../state';

// A probe runs `check` at one commit (and, for a dirty rep's edits, its
// patch, EVALS_HOME/trees/<sha>.patch) in a detached worktree, and reads what
// it recorded back from the run index. The search never trusts a probe's
// exit code for a verdict: the reps it wrote are the evidence, which is also
// what makes a bisect resumable (a probe whose reps are all on record is
// never run again). Trees, render keys and Tier 1's classes are
// core/bisect.ts; the worktrees and the `check` they spawn are here.

export { candidateKey, mapToClass, missingReps, probeSet, renderKeys, treeLabel, treeOf } from '../core/bisect';
export type { CheckExit, RenderHook, Tree } from '../core/bisect';

/** The world a bisect acts on, its checks taking `check`'s options. The real one makes worktrees and spawns `check`; tests hand in a fake check. */
export type ProbeEnv = CoreProbeEnv<TreeCheck & { batch: string }>;

/** Each call's request less its prompt text, by call folder: a model or a parameter change keeps two renders apart. */
export function folderParams(runsDir = homePaths().runs) {
  return (runId: string): string => {
    const dir = join(runsDir, runId);
    if (!existsSync(dir)) return '';
    const calls = readdirSync(dir).filter((n) => /^call\d+$/.test(n)).sort();
    return calls
      .map((c) => {
        try {
          const { prompt: _p, system: _s, messages: _m, ...rest } = JSON.parse(readFileSync(join(dir, c, 'request.json'), 'utf8')) as Record<string, unknown>;
          return `${c}:${JSON.stringify(rest, Object.keys(rest).sort())}`;
        } catch {
          return `${c}:?`;
        }
      })
      .join(';');
  };
}

const POLL_MS = 10_000;

/**
 * The real env: each probe is a tree from prepareTreeAt (patch applied), a
 * load check (baseLoadErrors: a surface that does not load at that commit is
 * a skip, never a crash of the bisect), this checkout's tool running `check`
 * there with CODECAST_EVALS_REPO_ROOT at the tree, and the tree dropped.
 */
export function treeEnv(surface: string, o: { out?: (line: string) => void; log?: string } = {}): ProbeEnv {
  return {
    surface,
    out: o.out,
    rows: () => indexedRuns({ surface }),
    params: folderParams(),
    async check(tree, args, tick) {
      const patch = tree.patch ? join(homePaths().trees, `${tree.patch}.patch`) : undefined;
      if (patch && !existsSync(patch)) return { kind: 'load-error', error: `the edits ${tree.patch!.slice(0, 8)} are not in EVALS_HOME/trees` };
      let wt: string | null = null;
      try {
        const made = prepareTreeAt(tree.sha, { patch, prefix: 'bisect-' });
        wt = made.wt;
        const err = baseLoadErrors(made.wt, made.tool, [surface]).get(surface);
        if (err) return { kind: 'load-error', error: err };
        const { batch, ...rest } = args;
        const argv = ['bun', join(made.tool, 'packages', 'evals', 'src', 'index.ts'), ...checkArgs([surface], batch, rest)];
        const child = Bun.spawn(argv, { cwd: made.wt, env: { ...process.env, CODECAST_EVALS_REPO_ROOT: made.wt, CODECAST_EVALS_HARNESS_ROOT: REPO_ROOT }, stdout: 'pipe', stderr: 'pipe' });
        const log = o.log ? createWriteStream(o.log, { flags: 'a' }) : null;
        let error: string | undefined;
        const line = (l: string) => {
          log?.write(`${l}\n`);
          o.out?.(l);
          if (/error/i.test(l)) error = l.trim().split(`${made.wt}/`).join('');
        };
        const pump = async (stream: ReadableStream<Uint8Array>) => {
          const dec = new TextDecoder();
          let rest = '';
          for await (const chunk of stream) {
            rest += dec.decode(chunk, { stream: true });
            const lines = rest.split('\n');
            rest = lines.pop() ?? '';
            for (const l of lines) line(l);
          }
          if (rest) line(rest);
        };
        const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
        const timer = tick ? setInterval(() => void tick().catch(() => {}), POLL_MS) : null;
        try {
          const code = await child.exited;
          await pumps;
          return { kind: 'exit', code, ...(code !== 0 && error ? { error } : {}) };
        } finally {
          if (timer) clearInterval(timer);
          log?.end();
        }
      } catch (e) {
        return { kind: 'load-error', error: `the tree at ${treeLabel(tree)} could not be built: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
      } finally {
        if (wt) dropBaseTree(wt);
      }
    },
  };
}

// ── Tier 1: dry render probes ───────────────────────────────────────────────

/** The batch a dry render of `tree` lands in, keyed by the tool's head (this checkout's by default). */
export const renderBatch = (tree: Tree, toolHead = gitHead()): string => renderBatchAt(tree, toolHead);

/** Tier 1 over the candidates (core/bisect.ts renderClasses), keyed by this checkout's head unless told another. */
export const renderClasses = (env: ProbeEnv, candidates: Candidate[], focus: string[], o: { toolHead?: string; onRender?: RenderHook } = {}): Promise<RenderClass[]> => renderClassesWith(env, candidates, focus, { ...o, toolHead: o.toolHead ?? gitHead() });
