import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CompareResponse, FreezeInfo, FreezeResponse, MomentMessage, MovedEvent, RunRow, SimSessionSummary, StalenessWord, SurfaceInfo } from '@codecast/shared/contracts/evalsApi';
import type { ConvoMessage, Freeze } from '@platform/evals';
import { diffRuns } from '@platform/evals/render';

import { sessionsDir } from '../../../web/store/__tests__/sim/history';
import { codecastFreezeStore } from '../adapters/freezes';
import { PASS_AT } from '../adapters/judge';
import { describeFreeze, freezeMeta, loadLabel, loadSnapshot, productionReplyOf, type LoadedSnapshot } from '../adapters/resolver';
import { BadRequest, NotFound, type RunDetail } from '../core/query';
import { labelPath } from '../labels';
import { surfaceMeta } from '../registry';
import { agentsOf, callsOf, filesOf, guardOf, judgeOf, logTailOf, readJsonFile, replyOf, resultOf, runDir, runJsonOf, scoreOf, scoreVersionsOf, sendsOf } from './files';
import { latestSimSession, simSessions } from './simHistory';

// Codecast's own parts of the shared views (core/query.ts builds the rest):
// what only codecast's homes hold, its freeze stores and labels, its run
// folders, the staleness worker and the sim history. Nothing here writes.

// ── Freezes ────────────────────────────────────────────────────────────────

/**
 * A slow read kept in memory: the first call waits for it, and later calls
 * get the last answer at once while a read older than `maxAgeMs` runs in the
 * background (a failed one keeps the last answer). The api child runs at the
 * daemon's utility priority on a loaded machine, where a read that costs
 * 20 ms of CPU waits seconds for it, so a polled page must not wait on these.
 */
export function kept<T>(read: () => Promise<T>, maxAgeMs: number): () => Promise<T> {
  let last: { at: number; value: T } | null = null;
  let pending: Promise<T> | null = null;
  const start = (): Promise<T> =>
    (pending ??= read()
      .then((value) => {
        last = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        pending = null;
      }));
  return () => {
    if (!last) return start();
    if (Date.now() - last.at >= maxAgeMs) void start().catch(() => null);
    return Promise.resolve(last.value);
  };
}

/** Both freeze homes, read again at most every 5 s: the home page counts them per surface on every poll. */
const allFreezes = kept(() => codecastFreezeStore().list(), 5000);

/** Each surface's freezes counted by visibility, over both homes as last read. */
export async function freezeCounts(): Promise<(surface: string) => SurfaceInfo['freezes']> {
  const all = await allFreezes();
  return (surface) => {
    const mine = all.filter((f) => freezeMeta(f).surface === surface);
    const pub = mine.filter((f) => freezeMeta(f).visibility === 'public').length;
    return { public: pub, private: mine.length - pub };
  };
}

// ── Staleness ──────────────────────────────────────────────────────────────

/** The words from the worker (staleWorker.ts), or every surface fresh when it cannot answer. */
function askWorker(): Promise<Map<string, StalenessWord>> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./staleWorker.ts', import.meta.url).href);
    } catch {
      resolve(new Map());
      return;
    }
    const done = (words: Record<string, StalenessWord> | null) => {
      void worker.terminate();
      resolve(new Map(Object.entries(words ?? {})));
    };
    worker.onmessage = (e: MessageEvent<Record<string, StalenessWord> | null>) => done(e.data);
    worker.onerror = () => done(null);
    worker.postMessage(null);
  });
}

/**
 * Each surface's staleness word, asked again at most every 30 s. Asked in a
 * worker, because staleness() reads git synchronously and takes seconds
 * under load: the first overview starts it before it loads the index and
 * awaits it last, and later ones take the last answer.
 */
export const stalenessWords = kept(askWorker, 30_000);

// ── The sim home ───────────────────────────────────────────────────────────

const sessionDirOf = (id: string): string => join(sessionsDir(), id);

/** The newest failing sim run, as a "What moved" line, and the newest session: what the wall shows of the sim. */
export function simOverview(): { failure: MovedEvent | null; latest: SimSessionSummary | null } {
  const sessions = simSessions();
  return { failure: simFailureEvent(sessions), latest: latestSimSession(sessions) };
}

function simFailureEvent(sessions: ReturnType<typeof simSessions>): MovedEvent | null {
  for (const { session, runs } of sessions) {
    if (session.unsessioned) continue;
    const failed = runs.filter((r) => !r.passed && r.dir).at(-1);
    if (!failed) continue;
    const result = readJsonFile<{ invariant?: { id?: string } }>(join(sessionDirOf(session.id), failed.dir!, 'result.json'));
    return { at: session.startedAt, surface: null, kind: 'sim-failure', session: session.id, run: failed.dir!, scenario: failed.scenario, invariant: result?.invariant?.id ?? '' };
  }
  return null;
}

// ── One freeze ─────────────────────────────────────────────────────────────

const momentOf = (m: ConvoMessage): MomentMessage => ({ n: m.n, id: m.id, at: m.at, channel: m.channel, room: m.room ?? null, isGroup: m.isGroup, direction: m.direction, from: m.from, to: m.to ?? null, text: m.text, status: (m as { status?: string | null }).status ?? null, ...(m.meta ? { meta: m.meta as Record<string, unknown> } : {}) });

/** A freeze by full id or a prefix the store resolves; NotFound when neither home holds it. */
export async function freezeById(id: string): Promise<Freeze> {
  let f: Freeze | null;
  try {
    f = await codecastFreezeStore().get(id);
  } catch (e) {
    throw new BadRequest(e instanceof Error ? e.message : String(e));
  }
  if (!f) throw new NotFound(`no freeze ${id}`);
  return f;
}

/** A freeze's page from its stores, labels and the reps that ran it; core/query.ts adds its epochs. */
export async function freezePage(id: string, rows: RunRow[]): Promise<Omit<FreezeResponse, 'epochs'>> {
  const f = await freezeById(id);
  const m = freezeMeta(f);
  const surface = String(m.surface ?? '');
  const reps = rows.filter((r) => r.freezeId === f.id);
  let loaded: LoadedSnapshot | undefined;
  try {
    loaded = loadSnapshot(f);
  } catch {
    loaded = undefined;
  }
  const label = loaded ? loadLabel(f, loaded) : existsSync(labelPath(surface, f.id)) ? loadLabel(f) : undefined;
  const labelSource: FreezeResponse['labelSource'] = loaded?.fixture?.label !== undefined ? 'inline' : label !== undefined ? 'labels' : null;
  // The moment the surface's own describe() renders; with no snapshot on this machine, the judge prompt a rep kept stands in.
  let moment = ((await describeFreeze(f).catch(() => null)) ?? []).map(momentOf);
  if (!moment.length) {
    const judged = reps.find((r) => existsSync(join(runDir(r.id), 'judge', 'prompt.md')));
    const prompt = judged ? judgeOf(runDir(judged.id))?.prompt : null;
    if (prompt) moment = [{ n: 1, id: 'judge-prompt', at: f.asOf, channel: 'judge', isGroup: false, direction: 'system', from: 'judge/prompt.md', text: prompt }];
  }
  const production = await productionReplyOf(f).catch(() => null);
  const info: FreezeInfo = {
    id: f.id,
    name: f.name,
    surface,
    visibility: m.visibility === 'public' ? 'public' : 'private',
    createdAt: f.createdAt,
    asOf: f.asOf,
    anchor: f.anchor,
    subject: { kind: String(f.subject.kind), id: f.subject.id, title: f.subject.title, subtitle: (f.subject as { subtitle?: string | null }).subtitle ?? null },
    trigger: f.trigger ?? null,
    notes: f.notes ?? null,
    judge: f.judge ?? null,
    tags: f.tags ?? [],
    freezeSha: reps.find((r) => r.freezeSha)?.freezeSha ?? null,
  };
  return {
    freeze: info,
    label: label ?? null,
    labelSource,
    moment,
    cutAt: moment.filter((x) => x.at <= f.asOf).length,
    production: production ? { messages: production.messages.map(momentOf), verdict: production.verdict ? { score: production.verdict.score, pass: production.verdict.pass, reasoning: production.verdict.reasoning ?? null } : null } : null,
    runs: reps,
  };
}

// ── One run ────────────────────────────────────────────────────────────────

/** A rep's folder as the run page reads it; core/query.ts adds the row and its neighbours. */
export async function runFolder(row: RunRow): Promise<RunDetail> {
  const dir = runDir(row.id);
  const meta = surfaceMeta(row.surface);
  const run = runJsonOf(dir, row, meta?.route ?? 'call');
  const score = scoreOf(dir);
  let criteria: string | null = meta?.criteria ?? null;
  if (!score) criteria = (await freezeById(row.freezeId).catch(() => null))?.judge ?? criteria;
  return {
    run,
    result: resultOf(dir),
    score,
    scoreVersions: scoreVersionsOf(dir),
    rubric: score ? null : { criteria, passMark: PASS_AT },
    sends: sendsOf(dir),
    calls: callsOf(dir),
    agents: agentsOf(dir, run.model || row.model),
    judge: judgeOf(dir),
    guard: guardOf(dir),
    files: filesOf(dir),
    logTail: logTailOf(dir),
    extra: row.surface === 'org-review' ? { gradeAuto: readJsonFile(join(dir, 'grade-auto.json')) ?? undefined, hashes: readJsonFile(join(dir, 'hashes.json')) ?? undefined } : null,
  };
}

/** Two reps' judge verdicts weighed and their replies, as the compare page shows them. */
export const runPair = (a: string, b: string): Pick<CompareResponse, 'diff' | 'replies'> => ({
  diff: diffRuns({ verdict: scoreOf(runDir(a)) }, { verdict: scoreOf(runDir(b)) }),
  replies: { a: replyOf(runDir(a)), b: replyOf(runDir(b)) },
});
