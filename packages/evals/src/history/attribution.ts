import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVALS_SHA_RE, largestDrops, narrowByRecords, sourceConfidence, type Attribution, type AttributionAnswer, type AttributionClass, type Candidate, type CommitRef, type Endpoint, type Footing, type RecordedProbe, type RunRow, type VerdictFlip } from '@codecast/shared/contracts/evalsApi';
import { plural } from '@platform/cli-kit/text';

import { readProbe } from '../bisect/reading';
import { git, gitLog, onMainLine, resolveCommit } from '../git';
import { askedSet, batchStarts, batchVerdict, footingChange, footingOf, majority, scoreOrZero, verdictFlips } from '../commands/verdict';
import { DRY_RUN_SCRIPT_REL, publicFreezesDir, treeRoot } from '../paths';
import { readHeads, type HeadsFile } from '../provenance';
import { surfaceMeta } from '../registry';
import { separate } from '../stats';
import { surfaceDir } from '../surface';
import { epochsOf, folderPromptReader, promptPairs, timeline, type PromptReader } from './epochs';
import { flipsBetween, gradedSet } from './flips';

// Attribution from records (Tier 0): free and instant. Given a bad batch B
// and a good batch G on one surface, the first of a fixed list of causes that
// differs between them is the answer: the footing (model or judge ruler),
// the frozen moment, live reads, the source, and otherwise noise. For a
// source change it names the candidate commits between G and B that touch
// what the surface declares, then narrows them for free with every recorded
// batch already inside the range. Dirty reps with no patch cannot be
// replayed: they make the answer "unattributable", never a guessed commit.

/** The git the attribution reads. repoGit is the real one; tests hand in a fake. */
export interface AttributionGit {
  /** The full sha of a commit name, or null. */
  resolve(name: string): string | null;
  isAncestor(a: string, b: string): boolean;
  /** Commits on the ancestry path after `good` up to `bad`, oldest first; only those touching `paths` when given. */
  path(good: string, bad: string, paths: string[] | null): CommitRef[];
  /** The files under `paths` that differ between two commits. */
  changed(a: string, b: string, paths: string[]): string[];
  /** A file's text at a commit, or null. */
  show(sha: string, path: string): string | null;
}

/** The repo's git, argv only, never a shell string. */
export function repoGit(root = treeRoot()): AttributionGit {
  const run = (args: string[]) => git(root, args);
  return {
    resolve: (name) => resolveCommit(name, root),
    isAncestor: (a, b) => run(['merge-base', '--is-ancestor', a, b]).ok,
    path: (good, bad, paths) => gitLog(['--reverse', '--ancestry-path', `${good}..${bad}`, ...(paths ? ['--', ...paths] : [])], onMainLine, root).map(({ parents: _, ...c }) => c),
    changed: (a, b, paths) => {
      const r = run(['diff', '--name-only', a, b, '--', ...paths]);
      return r.ok ? r.out.split('\n').filter(Boolean) : [];
    },
    show: (sha, path) => {
      const r = run(['show', `${sha}:${path}`]);
      return r.ok ? r.out : null;
    },
  };
}

/** A freeze file's fields that grade a rep rather than make up the moment: the per-freeze rubric. */
const RUBRIC_FIELDS = ['judge', 'label'] as const;
/** Fields that neither make up the moment nor grade it. */
const NOTE_FIELDS = ['notes', 'tags', 'name', 'createdAt'] as const;

/**
 * What changed in one committed freeze file between two versions: the moment
 * (anything the surface answers from), only its rubric (a per-freeze judge
 * line or label), or nothing that matters. A file that cannot be read on
 * either side counts as the moment, as a file change always did.
 */
export function freezeFileChange(before: string | null, after: string | null): 'moment' | 'rubric' | null {
  const parse = (t: string | null): Record<string, unknown> | null => {
    try {
      const v = t === null ? null : (JSON.parse(t) as unknown);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const [a, b] = [parse(before), parse(after)];
  if (!a || !b) return before !== null && before === after ? null : 'moment';
  const pick = (o: Record<string, unknown>, keep: (k: string) => boolean) => JSON.stringify(Object.keys(o).filter(keep).sort().map((k) => [k, o[k]]));
  const rubric = (k: string) => (RUBRIC_FIELDS as readonly string[]).includes(k);
  const note = (k: string) => (NOTE_FIELDS as readonly string[]).includes(k);
  if (pick(a, (k) => !rubric(k) && !note(k)) !== pick(b, (k) => !rubric(k) && !note(k))) return 'moment';
  return pick(a, rubric) !== pick(b, rubric) ? 'rubric' : null;
}

/** A public freeze's committed snapshot, as a repo path (its pointer's meta.snapshot), or null. */
function publicSnapshotPath(freezeId: string): string | null {
  try {
    const snapshot = (JSON.parse(readFileSync(join(publicFreezesDir(), `${freezeId}.json`), 'utf8')) as { meta?: { snapshot?: string } }).meta?.snapshot;
    return snapshot ? `packages/evals/${snapshot}` : null;
  } catch {
    return null;
  }
}

/** What a surface's prompt rests on beyond its declared sources: the frozen moments, the judge and the model pins. */
export const ATTRIBUTION_EXTRA_PATHS = ['packages/evals/fixtures', 'packages/evals/freezes', 'packages/evals/src/adapters/judge.ts', 'packages/evals/src/models.ts'];

/**
 * The paths a surface declares, on today's registry and on each named
 * commit's (the repo paths quoted in its meta.ts then), plus what every
 * prompt rests on (ATTRIBUTION_EXTRA_PATHS).
 */
export function declaredPaths(surface: string, shas: string[], git: AttributionGit): string[] {
  const dir = `packages/evals/src/surfaces/${surfaceDir(surface)}`;
  const then = shas.flatMap((sha) => [...(git.show(sha, `${dir}/meta.ts`) ?? '').matchAll(/['"`](packages\/[^'"`$]+)['"`]/g)].map((m) => m[1]!));
  return [...new Set([...(surfaceMeta(surface)?.sources ?? []), ...then, dir, DRY_RUN_SCRIPT_REL, ...ATTRIBUTION_EXTRA_PATHS])].sort();
}

export interface AttributionInput {
  surface: string;
  /** The surface's index rows. */
  rows: RunRow[];
  /** A batch name or a sha; found from the records when left out. */
  good?: string;
  bad?: string;
  /** Limit to these freezes (ids or id prefixes). */
  freezes?: string[];
  /** Search every commit in the range, not only those touching what the surface declares. */
  allCommits?: boolean;
  git?: AttributionGit;
  heads?: HeadsFile | null;
  reader?: PromptReader;
  /** The paths a candidate must touch; declaredPaths by default. */
  paths?: string[];
}

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 9) : 'none');

const modal = <T>(xs: T[]): T | null => {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

interface Side {
  end: Endpoint;
  /** The graded reps: one per seed, crashes and dry reps left out. */
  set: RunRow[];
}

/**
 * An endpoint from a batch's graded reps: the commit most of them ran on, its
 * main-line twin, and whether any ran on edits. A head heads.json has no entry
 * for sits nowhere known yet, so it has no twin rather than standing for
 * itself on main; with no heads.json at all the head stands for itself.
 */
function sideOfBatch(rows: RunRow[], batch: string, heads: HeadsFile | null): Side {
  const set = gradedSet(rows, batch);
  const reps = set.length ? set : rows.filter((r) => r.batch === batch);
  const sha = modal(reps.map((r) => r.gitHead).filter((h): h is string => !!h)) ?? '';
  const onHead = reps.filter((r) => r.gitHead === sha);
  return {
    end: {
      batch,
      sha,
      mainSha: modal(onHead.map((r) => r.mainSha).filter((h): h is string => !!h)) ?? (onHead.some((r) => r.offBranch) || (heads && !heads.heads[sha]) ? null : sha || null),
      dirty: reps.some((r) => r.dirty),
      treePatch: reps.find((r) => r.treePatch)?.treePatch ?? null,
      footing: set[0] ? footingOf(set[0]) : { model: null, ruler: null },
      at: batchStarts(rows).get(batch) ?? null,
    },
    set,
  };
}

/** An endpoint named by a batch or a sha. A sha stands for the newest clean batch that ran on it, or for the bare commit when none did. */
function sideOf(rows: RunRow[], ref: string, git: AttributionGit, heads: HeadsFile | null): Side {
  if (rows.some((r) => r.batch === ref)) return sideOfBatch(rows, ref, heads);
  if (!EVALS_SHA_RE.test(ref)) throw new Error(`${ref} is neither a batch of this surface nor a sha`);
  const sha = git.resolve(ref);
  if (!sha) throw new Error(`${ref} is not a commit in this repo`);
  const ran = timeline(rows)
    .filter(({ reps }) => reps.some((r) => r.gitHead === sha) && !reps.some((r) => r.dirty) && askedSet(rows, reps[0]!.batch!).length)
    .at(-1);
  if (ran) return sideOfBatch(rows, ran.batch, heads);
  const entry = heads?.heads[sha];
  return { end: { batch: null, sha, mainSha: entry ? entry.mainSha : sha, dirty: false, treePatch: null, footing: { model: null, ruler: null }, at: null }, set: [] };
}

/** The newest batch a regression shows in: it separated worse against its baseline, or a freeze broke. */
function newestRed(rows: RunRow[], surface: string): string | undefined {
  const meta = { id: surface, model: surfaceMeta(surface)?.model ?? '' };
  return timeline(rows)
    .reverse()
    .map((b) => b.batch)
    .find((batch) => {
      if (!askedSet(rows, batch).length) return false;
      const v = batchVerdict(meta, batch, rows);
      return v.regression || v.flips.some((f) => f.direction === 'broke');
    });
}

/** The newest batch before `bad` on its footing in which each of `freezes` passed by majority. */
function goodBefore(rows: RunRow[], bad: Side, freezes: string[]): string | null {
  const t = bad.end.at ?? '';
  for (const { batch, at } of timeline(rows).reverse()) {
    if (batch === bad.end.batch || at >= t) continue;
    const set = askedSet(rows, batch).filter((r) => freezes.includes(r.freezeId));
    if (!freezes.every((f) => set.some((r) => r.freezeId === f))) continue;
    if (set.some((r) => footingChange(footingOf(r), footingOf(bad.set.find((x) => x.freezeId === r.freezeId) ?? r)))) continue;
    const m = majority(set);
    if (freezes.every((f) => m.get(f))) return batch;
  }
  return null;
}

/** For a fall in score with no flip: the contract's rule, shared with the fixture world. */
export { largestDrops };

/** How a recorded batch reads against the endpoints: the bisect's own probe rule (readProbe), a split read as unsure. */
function classify(set: RunRow[], good: RunRow[], focus: string[], mode: Attribution['mode']): RecordedProbe['verdict'] {
  const reading = readProbe(set, focus, mode, good);
  return reading === 'split' ? 'unsure' : reading;
}

/** Why a side's records cannot stand for one commit, or null. */
function unreplayable(name: string, s: Side, heads: HeadsFile | null): string | null {
  if (s.end.dirty && !s.end.treePatch) return `${name} ${s.end.batch ?? short(s.end.sha)} ran on uncommitted edits to ${short(s.end.sha)} that nothing recorded can replay`;
  if (!s.end.mainSha) {
    const entry = heads?.heads[s.end.sha];
    if (!entry) return `${name}'s head ${short(s.end.sha)} is not in heads.json yet, so where it sits is unknown: ./evals pin --backfill maps it`;
    return `${name}'s head ${short(s.end.sha)} is on no branch and has no main-line twin${entry?.reason ? ` (${entry.reason})` : ''}${entry?.near ? `; nearest on main: ${short(entry.near)}` : ''}`;
  }
  return null;
}

/** The source answer: the candidate commits between the endpoints, narrowed by every recorded batch inside the range. */
function sourceAnswer(input: AttributionInput, git: AttributionGit, heads: HeadsFile | null, good: Side, bad: Side, focus: string[], mode: Attribution['mode']): Extract<AttributionAnswer, { kind: 'source' }> {
  const [g, b] = [good.end.mainSha ?? good.end.sha, bad.end.mainSha ?? bad.end.sha];
  const reasons = [unreplayable('good', good, heads), unreplayable('bad', bad, heads)].filter((x): x is string => !!x);
  if (!reasons.length && g !== b && !git.isAncestor(g, b)) reasons.push(`good ${short(g)} is not an ancestor of bad ${short(b)}`);
  const all = g === b ? [] : git.path(g, b, null);
  const touching = input.allCommits ? all : g === b ? [] : git.path(g, b, input.paths ?? declaredPaths(input.surface, [g, b], git));
  const patch: Candidate | null = bad.end.dirty && bad.end.treePatch ? { kind: 'patch', base: bad.end.sha, treePatch: bad.end.treePatch, renderClass: null } : null;
  const epochs = epochsOf(input.rows, input.surface, input.reader ?? folderPromptReader()).filter((e) => e.firstBatchAt > (good.end.at ?? '') && e.firstBatchAt <= (bad.end.at ?? '￿'));
  const base = { kind: 'source' as const, epochs, noDeclaredSourceMoved: !input.allCommits && !touching.length && !patch, rangeCommits: all.length };
  const commits = (from: number, to: number): Candidate[] => touching.filter((c) => { const i = all.findIndex((x) => x.sha === c.sha); return i > from && i <= to; }).map((commit) => ({ kind: 'commit', commit, renderClass: null }));
  if (reasons.length) return { ...base, confidence: 'unattributable', candidates: [...commits(-1, all.length - 1), ...(patch ? [patch] : [])], narrowedBy: [], reason: reasons.join('; ') };
  // Every recorded batch whose head lies inside the range, on the bad side's footing, that ran a focus freeze and can be replayed.
  const at = new Map(all.map((c, i) => [c.sha, i]));
  const narrowedBy: Array<RecordedProbe & { at: number; clean: boolean }> = [];
  for (const { batch } of timeline(input.rows)) {
    if (batch === good.end.batch || batch === bad.end.batch) continue;
    const s = sideOfBatch(input.rows, batch, heads);
    const i = at.get(s.end.mainSha ?? '');
    const ran = s.set.filter((r) => focus.includes(r.freezeId));
    if (i === undefined || !ran.length || (s.end.dirty && !s.end.treePatch)) continue;
    if (ran.some((r) => footingChange(footingOf(r), footingOf(bad.set.find((x) => x.freezeId === r.freezeId) ?? r)))) continue;
    narrowedBy.push({ batch, sha: s.end.sha, verdict: classify(s.set, good.set, focus, mode), reps: ran.length, at: i, clean: !s.end.dirty });
  }
  const { goodAt, badAt, keepPatch } = narrowByRecords(all.length, narrowedBy);
  const candidates = [...commits(goodAt, badAt), ...(patch && keepPatch ? [patch] : [])];
  return { ...base, confidence: sourceConfidence(candidates.length), candidates, narrowedBy: narrowedBy.map(({ at: _, clean: __, ...p }) => p), reason: null };
}

/**
 * Tier 0 attribution for a regression on one surface. Endpoints left out are
 * found from the records: B is the newest batch that separated worse or
 * broke a freeze, G the newest earlier batch on its footing in which each
 * broken freeze passed. Examples (reply text) are left to flipExamples.
 */
export function attribute(input: AttributionInput): Attribution {
  const git = input.git ?? repoGit();
  const heads = input.heads === undefined ? readHeads() : input.heads;
  const reader = input.reader ?? folderPromptReader();
  const rows = input.rows.filter((r) => r.surface === input.surface);
  const only = (f: string) => !input.freezes?.length || input.freezes.some((p) => f.startsWith(p));
  const badRef = input.bad ?? newestRed(rows, input.surface);
  if (!badRef) throw new Error(`no ${input.surface} batch separated worse or broke a freeze; name the good and bad batches`);
  const bad = sideOf(rows, badRef, git, heads);
  const meta = { id: input.surface, model: surfaceMeta(input.surface)?.model ?? '' };
  const broke = (flips: VerdictFlip[]) => flips.filter((f) => f.direction === 'broke' && only(f.freezeId));
  let goodRef = input.good;
  if (!goodRef && bad.end.batch) {
    const v = batchVerdict(meta, bad.end.batch, rows);
    const f = broke(v.flips).map((x) => x.freezeId);
    goodRef = (f.length ? goodBefore(rows, bad, f) : v.baseline?.batches.at(-1)) ?? undefined;
  }
  if (!goodRef) throw new Error(`no earlier ${input.surface} batch on ${bad.end.batch ?? short(bad.end.sha)}'s footing passed its broken freezes; name the good batch`);
  const good = sideOf(rows, goodRef, git, heads);
  const flipped = good.end.batch && bad.end.batch ? broke((() => { const r = flipsBetween(rows, good.end.batch, bad.end.batch); return r.ok ? r.flips : verdictFlips(bad.set, good.set); })()) : [];
  const mode: Attribution['mode'] = flipped.length ? 'flip' : 'score';
  const focus = flipped.length ? flipped.map((f) => f.freezeId) : largestDrops(good.set.filter((r) => only(r.freezeId)), bad.set.filter((r) => only(r.freezeId)));
  const of = (s: Side) => s.set.filter((r) => focus.includes(r.freezeId));
  const [gs, bs] = [of(good), of(bad)];
  const pair = (f: string) => [gs.find((r) => r.freezeId === f), bs.find((r) => r.freezeId === f)] as const;

  // Each class says truthfully whether it differs; the first that does is the answer.
  const checklist: Attribution['checklist'] = [];
  let answer: AttributionAnswer | null = null;
  const check = (cls: AttributionClass, differs: boolean, detail: string, then: () => AttributionAnswer) => {
    checklist.push({ class: cls, differs, detail });
    if (!answer && differs) answer = then();
  };

  // A public freeze's pointer and snapshot are committed: for reps that carry no freezeSha, git says whether they moved between
  // the two commits (one diff for every freeze), and reading both versions says what moved. A per-freeze judge line or label is
  // the rubric the rep is graded by (footing), not the moment the surface answered; a private freeze without freezeSha cannot be told.
  const changedFreezes: string[] = [];
  const rubricFreezes: string[] = [];
  let unknown = 0;
  let movedFiles: Set<string> | null = null;
  for (const f of focus) {
    const [g, b] = pair(f);
    if (g?.freezeSha && b?.freezeSha) {
      if (g.freezeSha !== b.freezeSha) changedFreezes.push(f);
    } else if (b?.visibility === 'public' && good.end.sha && bad.end.sha) {
      movedFiles ??= new Set(good.end.sha === bad.end.sha ? [] : git.changed(good.end.sha, bad.end.sha, ['packages/evals/freezes', 'packages/evals/fixtures']));
      const paths = [`packages/evals/freezes/${f}.json`, publicSnapshotPath(f)].filter((x): x is string => !!x && movedFiles!.has(x));
      const moved = paths.map((x) => freezeFileChange(git.show(good.end.sha!, x), git.show(bad.end.sha!, x)));
      if (moved.some((m) => m === 'moment')) changedFreezes.push(f);
      else if (moved.some((m) => m === 'rubric')) rubricFreezes.push(f);
    } else unknown++;
  }
  const ids = (fs: string[]) => fs.map((f) => f.slice(0, 8)).join(', ');

  // 1. Footing: the model, the judge's ruler, or a freeze's own rubric.
  let moved: { change: 'model' | 'judge'; a: Footing; b: Footing } | null = null;
  for (const f of focus) {
    const [g, b] = pair(f);
    const change = g && b ? footingChange(footingOf(g), footingOf(b)) : null;
    if (change) {
      moved = { change, a: footingOf(g!), b: footingOf(b!) };
      break;
    }
  }
  check(
    'footing',
    !!moved || rubricFreezes.length > 0,
    moved
      ? moved.change === 'model'
        ? `the model moved: ${moved.a.model ?? '?'} to ${moved.b.model ?? '?'}`
        : `the judge's ruler moved: ${moved.a.ruler ?? 'none'} to ${moved.b.ruler ?? 'none'}`
      : rubricFreezes.length
        ? `the per-freeze rubric changed on ${ids(rubricFreezes)} (its judge or label line, not the moment)`
        : `same model (${bad.end.footing.model ?? '?'}) and judge ruler on both sides`,
    () =>
      moved
        ? { kind: 'footing', change: moved.change, from: moved.change === 'model' ? moved.a.model : moved.a.ruler, to: moved.change === 'model' ? moved.b.model : moved.b.ruler }
        : { kind: 'footing', change: 'judge', from: `the rubric at ${short(good.end.sha)}`, to: `the rubric at ${short(bad.end.sha)}`, freezeIds: rubricFreezes },
  );

  // 2. Freeze: the frozen moment itself.
  check(
    'freeze',
    changedFreezes.length > 0,
    changedFreezes.length ? `the frozen moment changed on ${ids(changedFreezes)}` : `the frozen moments match${unknown ? ` (${unknown} private freeze(s) predate freezeSha and are taken as unchanged)` : ''}`,
    () => ({ kind: 'freeze', freezeIds: changedFreezes }),
  );

  // 3. Live reads on the bad side: its verdict may rest on today's workspace, not the moment.
  const live = bs.filter((r) => r.liveReads > 0);
  const reads = live.reduce((t, r) => t + r.liveReads, 0);
  check('live-reads', live.length > 0, live.length ? `${live.length} bad rep(s) read the live workspace (${reads} reads): not reproducible` : 'no bad rep read the live workspace', () => ({ kind: 'live-reads', reps: live.length, reads }));

  // 4. Source: what the reps ran (sourceHashDisk), what they rendered (promptSha), and for legacy reps the commit.
  const sideHash = (s: RunRow[], k: 'sourceHashDisk' | 'promptSha', f?: string) => modal(s.filter((r) => !f || r.freezeId === f).map((r) => r[k]).filter((x): x is string => !!x));
  const disk = [sideHash(gs, 'sourceHashDisk'), sideHash(bs, 'sourceHashDisk')];
  const diskMoved = !!disk[0] && !!disk[1] && disk[0] !== disk[1];
  const promptMoved = focus.filter((f) => {
    const [a, b] = [sideHash(gs, 'promptSha', f), sideHash(bs, 'promptSha', f)];
    return !!a && !!b && a !== b;
  });
  const legacy = !disk[0] || !disk[1];
  // A call surface's model sees its rendered prompt and nothing else: when every freeze weighed rendered the same prompt on both
  // sides, no commit in between changed what the model saw, so a moved commit is not a source change (an agent's tools still can be).
  const samePrompts = surfaceMeta(input.surface)?.route === 'call' && focus.length > 0 && focus.every((f) => !!sideHash(gs, 'promptSha', f) && sideHash(gs, 'promptSha', f) === sideHash(bs, 'promptSha', f));
  const headMoved = legacy && !samePrompts && good.end.sha !== bad.end.sha;
  // With no freeze weighed (neither a flip nor a freeze both sides graded) nothing fell, so no commit has a drop to explain,
  // and every candidate would render alike on an empty freeze set: a moved commit alone is not a source answer.
  const weighedAny = focus.length > 0;
  check(
    'source',
    weighedAny && (diskMoved || promptMoved.length > 0 || headMoved),
    !weighedAny ? `no freeze graded on both sides fell${good.end.sha !== bad.end.sha ? ` (the commit moved, ${short(good.end.sha)} to ${short(bad.end.sha)})` : ''}: nothing for a commit to explain` : [
      diskMoved ? 'the declared sources the reps ran differ' : legacy ? '' : 'the declared sources the reps ran match',
      promptMoved.length ? `the rendered prompt changed on ${ids(promptMoved)}` : '',
      headMoved ? `the commit moved: ${short(good.end.sha)} to ${short(bad.end.sha)}` : '',
      !diskMoved && samePrompts ? `same rendered prompts on every ${mode === 'flip' ? 'flipped' : 'weighed'} freeze${legacy && good.end.sha !== bad.end.sha ? ` (the commit moved, ${short(good.end.sha)} to ${short(bad.end.sha)}, but not what the model saw)` : ''}` : '',
    ]
      .filter(Boolean)
      .join('; ') || 'same commit and same rendered prompts',
    () => sourceAnswer({ ...input, rows, reader }, git, heads, good, bad, focus, mode),
  );

  // 5. Noise: nothing differs, so the separation says how sure the fall is. It weighs the focus freezes' reps alone, and says so.
  const separation = separate(bs.map(scoreOrZero), gs.map(scoreOrZero));
  const weighed = `on the ${plural(focus.length, mode === 'flip' ? 'flipped freeze' : 'weighed freeze')} only`;
  const reading = !focus.length ? 'no freeze graded on both sides, so no fall to weigh' : separation.kind === 'too-few' ? `too few reps to separate ${weighed}` : `${separation.kind}, p=${separation.p.toFixed(4)} ${weighed}`;
  check('noise', !answer, `${answer ? 'not the answer' : 'nothing else differs'}: ${reading}`, () => ({ kind: 'noise', separation }));

  // The rendered prompt, whatever the answer, per focus freeze. A flip shows the reps its own lists lead with (verdictFlips puts
  // the reps that agree with each side's verdict first), as every other flip on the pages does; a fall in score with no flip
  // takes the good side's newest rep against the bad side's first. Unchanged files stay in, so a page can say the prompts
  // held still rather than that nothing was there to compare.
  const promptDiffs = focus.flatMap((f) => {
    const flip = flipped.find((x) => x.freezeId === f);
    const g = flip ? flip.before[0] : gs.filter((r) => r.freezeId === f).sort((x, y) => (x.stamp < y.stamp ? 1 : -1))[0]?.id;
    const b = flip ? flip.after[0] : bs.filter((r) => r.freezeId === f).sort((x, y) => (x.stamp < y.stamp ? -1 : 1))[0]?.id;
    return g && b ? promptPairs(reader, f, g, b, false) : [];
  });
  return { surface: input.surface, good: good.end, bad: bad.end, mode, flipped, checklist, answer: answer!, promptDiffs, examples: [] };
}
