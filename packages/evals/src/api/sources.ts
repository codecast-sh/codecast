import { stat } from 'node:fs/promises';

import type { HealthResponse, RunRow, SimFailureMoved } from '@codecast/shared/contracts/evalsApi';
import { BadRequest, type EvalsSources } from '@platform/evals/query';

import { listBisects } from '../bisect/state';
import { codecastVerdict } from '../commands/verdict';
import { codecastAttributionMeta, repoGit } from '../history/attribution';
import { folderPromptReader } from '../history/epochs';
import { flipExamples } from '../history/flips';
import { indexedRuns, indexProgress, refreshRunIndex, runIndexPath } from '../history/runIndex';
import { evalsHome, REPO_ROOT } from '../paths';
import { surfaces } from '../registry';
import { gitHead } from '../state';
import type { SurfaceMeta } from '../surface';
import { readBisect, runningBisect, settlePendingBisects } from './bisects';
import { BadSha, commitDetail, commitsBetween, commitsTouching, verifiedSha } from './git';
import { simJobs } from './simHistory';
import { freezeCounts, freezePage, runFolder, runPair, simOverview, stalenessWords } from './views';

// What codecast's homes hold, as the shared views read them
// (@platform/evals/query EvalsSources): the run index, the registry, both
// freeze homes, the run folders, the repo's git, the bisect journals and the
// sim home. The api child answers the shared routes from these and codecast's
// own routes in handlers.ts, so both read one index.

const startedAt = new Date().toISOString();
let refreshed = false;
let current: { version: string; rows: RunRow[] } | null = null;

/**
 * The index, at most 2 s old: one readdir and parallel stats when nothing
 * moved. The same array comes back until the index changes, so the views
 * can keep answers per array (the shared handler's rows memo). Any refresh that
 * changes the index rewrites runs.jsonl, including the per-surface ones
 * flipExamples runs, so the file's mtime and size are its version. Requests
 * that arrive together (a page and its /changes poller) join the one load in
 * flight: refreshRunIndex runs a sweep per caller once the index is past its
 * age.
 */
let loading: Promise<RunRow[]> | null = null;
export const rows = (): Promise<RunRow[]> => (loading ??= loadRows().finally(() => (loading = null)));

async function loadRows(): Promise<RunRow[]> {
  await refreshRunIndex({ maxAgeMs: 2000 });
  refreshed = true;
  const st = await stat(runIndexPath()).catch(() => null);
  const version = st ? `${st.mtimeMs}:${st.size}` : 'none';
  if (current?.version !== version) current = { version, rows: await indexedRuns({ maxAgeMs: Number.MAX_SAFE_INTEGER }) };
  return current.rows;
}

function health(): HealthResponse {
  const p = indexProgress();
  // The first build can take minutes on a cold home: start it, never wait for it here.
  if (!refreshed && p.phase === 'idle') void rows().catch(() => null);
  const head = gitHead(REPO_ROOT);
  return {
    root: REPO_ROOT,
    evalsHome: evalsHome(),
    gitHead: head === 'unknown' ? null : head,
    runsIndexed: p.rows,
    index: { state: p.phase !== 'idle' ? (refreshed ? 'warm' : 'building') : refreshed ? 'warm' : 'cold', done: p.done, total: p.total || null },
    pid: process.pid,
    startedAt,
  };
}

/** A sha git refused, as the shared views' bad request. */
function shaChecked<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof BadSha) throw new BadRequest(e.message);
    throw e;
  }
}

export const codecastSources = {
  health,
  rows,
  surfaces,
  /** The surface header's own fields beside the shared ones. */
  info: (m) => ({ criteria: m.criteria ?? null, sources: m.sources, reps: m.reps, maxUsdPerRep: m.maxUsdPerRep }),
  // The prompt reader and the repo's git are made per use: their folders come from the environment (paths.ts).
  get prompts() {
    return folderPromptReader();
  },
  freezes: { counts: freezeCounts, get: freezePage },
  /** The staleness worker's words; a surface it leaves out reads `fresh`. */
  staleness: async () => {
    const words = await stalenessWords();
    return (id) => words.get(id) ?? 'fresh';
  },
  run: runFolder,
  pair: runPair,
  flipExamples,
  git: {
    verify: (sha) => void shaChecked(() => verifiedSha(sha)),
    touching: commitsTouching,
    between: commitsBetween,
    commit: (sha, surface, whole) => shaChecked(() => commitDetail(sha, surface, whole)),
    get attribution() {
      return repoGit();
    },
    meta: codecastAttributionMeta,
  },
  bisects: {
    summaries: () => listBisects(),
    settle: settlePendingBisects,
    running: runningBisect,
    get: (id, since) => readBisect(id, since),
  },
  // A rescore moves a rep too, and the core signature has no score versions; the sim's jobs ride the same feed.
  changes: {
    sig: (r) => String(r.scoreVersions),
    extra: (since) => ({ jobs: simJobs().filter((j) => Date.parse(j.updatedAt) > since) }),
  },
  /** The sim home on the wall: its newest failure as a What moved line, and its newest session. */
  overview: () => {
    const { failure, latest } = simOverview();
    return { moved: failure ? [failure] : [], fields: { sim: latest } };
  },
} satisfies EvalsSources<RunRow, SurfaceMeta, SimFailureMoved>;

/** Codecast's verdict policy: a rep passes by repPassed and is judged on its ruler (commands/verdict.ts). */
export const codecastPolicy = codecastVerdict.policy;
