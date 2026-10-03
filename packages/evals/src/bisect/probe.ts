import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Candidate, RenderClass, RunRow } from '@codecast/shared/contracts/evalsApi';

import { baseLoadErrors, checkArgs, dropBaseTree, prepareTreeAt, type TreeCheck } from '../commands/line';
import { repPassed } from '../adapters/replay';
import { batchSet, scoreOrZero } from '../commands/verdict';
import { BISECT_CADENCE } from '../commands/check';
import { gradedSet } from '../history/flips';
import { indexedRuns } from '../history/runIndex';
import { homePaths } from '../paths';
import { gitHead } from '../state';
import { median, separate } from '../stats';

// A probe runs `check` at one commit (and, for a dirty rep's edits, its
// patch) in a detached worktree, and reads what it recorded back from the run
// index. The search never trusts a probe's exit code for a verdict: the reps
// it wrote are the evidence, which is also what makes a bisect resumable (a
// probe whose reps are all on record is never run again).

/** Where a probe runs: a commit, plus a dirty rep's treePatch (EVALS_HOME/trees/<sha>.patch) on top. */
export interface Tree {
  sha: string;
  patch: string | null;
}

/** How a check ended: its surface did not load in the tree, or it ran and exited (with its last error line, when it printed one). */
export type CheckExit = { kind: 'load-error'; error: string } | { kind: 'exit'; code: number | null; error?: string };

/** The world a bisect acts on. The real one makes worktrees and spawns `check`; tests hand in a fake check. */
export interface ProbeEnv {
  surface: string;
  /** Run `check` in a tree; `tick` runs every few seconds while it does, so landed reps show before it ends. */
  check(tree: Tree, o: TreeCheck & { batch: string }, tick?: () => Promise<void>): Promise<CheckExit>;
  /** The surface's index rows, fresh. */
  rows(): Promise<RunRow[]>;
  /** What a rep asked the model with besides its prompts (each call's request.json less the prompt text). */
  params(runId: string): string;
  /** Where a check's output lines go. */
  out?: (line: string) => void;
}

const sha9 = (sha: string) => sha.slice(0, 9);

/** A tree as one word: `<sha9>`, or `<sha9>+<patch8>` for a patch on top. */
export const treeLabel = (t: Tree): string => `${sha9(t.sha)}${t.patch ? `+${t.patch.slice(0, 8)}` : ''}`;

export const treeOf = (c: Candidate): Tree => (c.kind === 'commit' ? { sha: c.commit.sha, patch: null } : { sha: c.base, patch: c.treePatch });

/** A candidate as one word, the form RenderClass.shas holds: a commit's sha, or `patch:<treePatch>` for a dirty batch's edits. */
export const candidateKey = (c: Candidate): string => (c.kind === 'commit' ? c.commit.sha : `patch:${c.treePatch}`);

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
        const child = Bun.spawn(argv, { cwd: made.wt, env: { ...process.env, CODECAST_EVALS_REPO_ROOT: made.wt }, stdout: 'pipe', stderr: 'pipe' });
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

/**
 * The batch a dry render of `tree` lands in. Keyed by the tool's head and
 * the tree, not by a bisect, so a plan's renders are reused by the start
 * that follows it and by later bisects on the same tool; a render that lacks
 * a freeze is topped up in place (check resumes a named batch).
 */
export const renderBatch = (tree: Tree, toolHead = gitHead()): string => `bisect-render-${sha9(toolHead)}~dry-${treeLabel(tree)}`;

/** One freeze's render in a batch: its most common promptSha and the request parameters of a rep that sent it. */
function renderKey(set: RunRow[], freezeId: string, params: ProbeEnv['params']): string | null {
  const reps = set.filter((r) => r.freezeId === freezeId && r.promptSha);
  if (!reps.length) return null;
  const n = new Map<string, number>();
  for (const r of reps) n.set(r.promptSha!, (n.get(r.promptSha!) ?? 0) + 1);
  const sha = [...n].sort((a, b) => b[1] - a[1])[0]![0];
  return `${sha}|${params(reps.find((r) => r.promptSha === sha)!.id)}`;
}

/** Every freeze's render key over a set of reps, or null when one is missing. */
export function renderKeys(set: RunRow[], focus: string[], params: ProbeEnv['params']): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const f of focus) {
    const k = renderKey(set, f, params);
    if (!k) return null;
    out[f] = k;
  }
  return out;
}

/** Told of each candidate's render: `ran` when it needed a dry check, false when its render was on record. */
export type RenderHook = (c: Candidate, batch: string, ran: boolean) => void;

/**
 * Tier 1: render every candidate dry on the focus freezes (free: canned model
 * output, real prompt files), and fold adjacent candidates whose renders
 * match on every focus freeze into one class: a replay cannot tell them
 * apart. Only neighbours fold, so the classes keep ancestry order and the
 * search can halve them. A candidate whose surface does not load, or whose
 * render crashed, is a class of its own marked skip. `n` is the class's
 * index; each candidate's renderClass is set to it.
 */
export async function renderClasses(env: ProbeEnv, candidates: Candidate[], focus: string[], o: { toolHead?: string; onRender?: RenderHook } = {}): Promise<RenderClass[]> {
  const toolHead = o.toolHead ?? gitHead();
  const keys: Array<{ c: Candidate; key: Record<string, string> | null; skip: string | null }> = [];
  let rows = await env.rows();
  for (const c of candidates) {
    const tree = treeOf(c);
    const batch = renderBatch(tree, toolHead);
    let key = renderKeys(batchSet(rows, batch), focus, env.params);
    let skip: string | null = null;
    if (!key) {
      o.onRender?.(c, batch, true);
      const exit = await env.check(tree, { batch, dry: true, reps: 1, freeze: focus, cadence: BISECT_CADENCE, notes: `bisect render of ${treeLabel(tree)}` });
      rows = await env.rows();
      if (exit.kind === 'load-error') skip = exit.error;
      else {
        key = renderKeys(batchSet(rows, batch), focus, env.params);
        if (!key) skip = `the dry render at ${treeLabel(tree)} recorded no prompt for every freeze (exit ${exit.code}${exit.error ? `: ${exit.error}` : ''})`;
      }
    } else o.onRender?.(c, batch, false);
    keys.push({ c, key: skip ? null : key, skip });
  }
  const classes: RenderClass[] = [];
  const same = (a: Record<string, string> | null, b: Record<string, string> | null) => !!a && !!b && focus.every((f) => a[f] === b[f]);
  for (const k of keys) {
    const last = classes.at(-1);
    const prev = keys[keys.indexOf(k) - 1];
    if (last && !last.skip && !k.skip && prev && same(prev.key, k.key)) {
      last.shas.push(candidateKey(k.c));
      last.representative = candidateKey(k.c);
    } else classes.push({ n: classes.length, shas: [candidateKey(k.c)], representative: candidateKey(k.c), promptShas: k.key ?? {}, skip: k.skip });
    k.c.renderClass = classes.length - 1;
  }
  return classes;
}

/**
 * Tier 1's legacy mapping: an endpoint that ran on uncommitted edits with no
 * patch, whose render equals a class's on every focus freeze, ran what that
 * class runs. The bad side takes the newest matching class and the good side
 * the oldest, so a render that recurs never narrows past what it proves.
 * Null when nothing matches.
 */
export function mapToClass(side: RunRow[], classes: RenderClass[], focus: string[], params: ProbeEnv['params'], which: 'good' | 'bad'): number | null {
  const key = renderKeys(side, focus, params);
  if (!key) return null;
  const hits = classes.filter((c) => !c.skip && focus.every((f) => c.promptShas[f] === key[f])).map((c) => c.n);
  return hits.length ? (which === 'bad' ? hits.at(-1)! : hits[0]!) : null;
}

// ── Classifying a replay probe ──────────────────────────────────────────────

/** A probe's reading before the unsure rule: `split` asks for 2 more reps per freeze. */
export type Reading = 'good' | 'bad' | 'split';

/**
 * How a probe's reps read. In flip mode, each focus freeze's majority over
 * its reps (a tie is neither), and the probe is bad when most focus freezes
 * fail as they did on the bad side, good when most pass as on the good side.
 * In score mode, the focus scores against the good control's: separated
 * worse is bad, too few to separate is a split, otherwise good.
 */
export function readProbe(set: RunRow[], focus: string[], mode: 'flip' | 'score', goodControl: RunRow[]): Reading {
  const ran = set.filter((r) => focus.includes(r.freezeId));
  if (mode === 'score') {
    const s = separate(ran.map(scoreOrZero), goodControl.filter((r) => focus.includes(r.freezeId)).map(scoreOrZero));
    return s.kind === 'worse' ? 'bad' : s.kind === 'too-few' ? 'split' : 'good';
  }
  const votes = focus.map((f) => {
    const reps = ran.filter((r) => r.freezeId === f);
    const passed = reps.filter(repPassed).length;
    return !reps.length || passed * 2 === reps.length ? 0 : passed * 2 > reps.length ? 1 : -1;
  });
  const [good, bad] = [votes.filter((v) => v > 0).length, votes.filter((v) => v < 0).length];
  return bad * 2 > focus.length ? 'bad' : good * 2 > focus.length ? 'good' : 'split';
}

/**
 * The unsure rule: a probe still split after its extra reps sides with the
 * control its focus median sits nearer, the bad one on a tie, and is marked
 * unsure so the answer's confidence drops.
 */
export function unsureSide(set: RunRow[], focus: string[], good: RunRow[], bad: RunRow[]): 'good' | 'bad' {
  const med = (s: RunRow[]) => median(s.filter((r) => focus.includes(r.freezeId)).map(scoreOrZero));
  const [p, g, b] = [med(set), med(good), med(bad)];
  if (!Number.isFinite(p) || !Number.isFinite(g) || !Number.isFinite(b)) return 'bad';
  return Math.abs(p - g) < Math.abs(p - b) - 1e-9 ? 'good' : 'bad';
}

/** A probe batch's graded reps (one per seed; crashes and dry reps left out). */
export const probeSet = (rows: RunRow[], batch: string): RunRow[] => gradedSet(rows, batch);

/** The seeds a batch still lacks for `reps` per freeze: a crashed seed counts as missing, as check's resume runs it again. */
export function missingReps(rows: RunRow[], batch: string, freezes: string[], reps: number): number {
  const have = new Set(batchSet(rows, batch).filter((r) => r.status !== 'crash').map((r) => `${r.freezeId}:${r.seed}`));
  let n = 0;
  for (const f of freezes) for (let s = 1; s <= reps; s++) if (!have.has(`${f}:${s}`)) n++;
  return n;
}

