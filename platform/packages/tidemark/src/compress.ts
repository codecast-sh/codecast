import type { Clock } from './clock';
import { mergeKinds, mergeTaskTags, type Activity, type Block } from './log';
import { dayRange, formatStamp } from './render';
import type { RuntimeLogger } from './run';
import { scopeKey, type Partition, type Scope, type ScopeRegistry, type ScopeType } from './scope';
import type { HistoryStore } from './store';
import { summaryText, type Summarizer } from './summarize';
import { blockChildren, blockKey, blockSpan, completeMerges, leafPrefixCount, pendingMerges, type TreeBlock } from './tree';

export interface CompressConfig {
  /** Activities younger than this stay raw. Default 2 hours. */
  minAgeMs: number;
  /** Fewest activities worth a leaf. Default 3. */
  minActivities: number;
  /** Most activities in one leaf. Default 50. */
  maxActivities: number;
  /** Summary calls in flight at once; inside a scope work is sequential. Default 8. */
  concurrency: number;
  /**
   * The share of each pass's capacity kept for merges, which leaf work cannot
   * spend: floor(share × concurrency) slots for the whole window, or, when
   * that is under one slot, every slot for the last share of the window.
   * Either side takes what the other leaves unused. 0 runs merges only after
   * the leaves. Default 0.25.
   */
  mergeShare: number;
  /** Most merges one scope builds before the next scope's turn. Default 8. */
  mergesPerTurn: number;
  /** Merges are built for the cover a scoped read renders: leaves that ended before now minus this. Default 14 days. */
  rawWindowMs: number;
  /** The cover's line budget merges are built for under `merges: 'cover'`. Default 32. */
  coverLines: number;
  /**
   * Which merged blocks a pass builds.
   * - 'complete' (default): every block that lies wholly inside the leaves
   *   that ended before the raw window. Any per-read budget and any focused
   *   stretch then renders at the resolution asked. Under one merge per leaf
   *   over a scope's life.
   * - 'cover': only the blocks the default cover at `coverLines` needs, and
   *   only for scopes longer than that. Cheapest at any moment; a read at a
   *   smaller budget falls back to finer blocks until `zoomOut` builds them.
   */
  merges: 'complete' | 'cover';
}

export const DEFAULT_COMPRESS: CompressConfig = {
  minAgeMs: 2 * 60 * 60 * 1000,
  minActivities: 3,
  maxActivities: 50,
  concurrency: 8,
  mergeShare: 0.25,
  mergesPerTurn: 8,
  rawWindowMs: 14 * 24 * 60 * 60 * 1000,
  coverLines: 32,
  merges: 'complete',
};

export interface PhaseReport {
  /** Wall ms from the pass's start until the phase's last call returned. */
  ms: number;
  /** Blocks the phase wrote. */
  count: number;
  /** The phase still had work when its share of the window ran out. */
  shareHit: boolean;
}

export interface CompressReport {
  leaves: number;
  activities: number;
  merged: number;
  /** Scopes that had a backlog, and scopes long enough to need merges. */
  leafScopes: number;
  mergeScopes: number;
  failures: number;
  /** Some phase ran out of time with work left (see `phases`). */
  deadlineHit: boolean;
  budgetHit: boolean;
  /** Leaves and merges run side by side; each with its time, its count and whether its share ran out. */
  phases: { leaves: PhaseReport; merges: PhaseReport };
}

export interface CompressDeps {
  store: HistoryStore;
  summarizer: Summarizer;
  clock: Clock;
  registry: ScopeRegistry;
  logger: RuntimeLogger;
  config: CompressConfig;
}

export interface CompressOptions {
  /** Wall-clock ms after which no new summary call starts. Set it under the scheduler's own expiry. */
  deadlineAt: number;
  /** Asked before each summary call; false stops the run (a spent wallet). */
  budgetCheck?: () => boolean;
}

/** At most `width` calls at once; `widen` raises the width for calls still waiting. */
function semaphore(width: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= width) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  const widen = (to: number) => {
    for (; width < to; width++) waiting.shift()?.();
  };
  return Object.assign(run, { widen });
}

/** Checked before every summary call. Wall time on purpose: a deadline protects the scheduler, not the read clock. */
type MaySpend = () => boolean;

/**
 * One compression pass. Leaves (the record) and merges (the zoom) share the
 * window, so a leaf backlog can never starve the tree: merges keep their share
 * of the capacity (`mergeShare`), and take everything the leaves leave
 * unused. Safe to stop anywhere and safe to run twice at once: a
 * leaf lands only at the position the run read as next, a merged block only
 * in an empty slot, so a second run's duplicate work is refused by the store.
 * A run that ends early leaves only coarser detail to the next one.
 */
export async function compressOnce(deps: CompressDeps, opts: CompressOptions): Promise<CompressReport> {
  const { store, clock, registry, config } = deps;
  const phase = (): PhaseReport => ({ ms: 0, count: 0, shareHit: false });
  const report: CompressReport = { leaves: 0, activities: 0, merged: 0, leafScopes: 0, mergeScopes: 0, failures: 0, deadlineHit: false, budgetHit: false, phases: { leaves: phase(), merges: phase() } };
  const startedAt = Date.now();
  const share = Number.isFinite(config.mergeShare) ? Math.min(1, Math.max(0, config.mergeShare)) : DEFAULT_COMPRESS.mergeShare;
  const width = Math.max(1, Math.floor(config.concurrency) || 1);
  // Merges hold whole slots when the share buys one, else the window's tail.
  const mergeSlots = Math.min(width - 1, Math.floor(width * share));
  const leafStop = mergeSlots > 0 ? opts.deadlineAt : opts.deadlineAt - share * Math.max(0, opts.deadlineAt - startedAt);
  const maySpend = (until: number, p: PhaseReport): MaySpend => () => {
    if (Date.now() >= until) {
      p.shareHit = true;
      report.deadlineHit = true;
      return false;
    }
    if (opts.budgetCheck && !opts.budgetCheck()) {
      report.budgetHit = true;
      return false;
    }
    return true;
  };
  const skip = registry.uncompressed();
  const now = clock.now();

  const leafRun = semaphore(width - mergeSlots);
  const leafLane = (async () => {
    const olderThan = store.cursorAt(now - config.minAgeMs);
    const groups = await store.backlog({ olderThan, minCount: config.minActivities, skip });
    report.leafScopes = groups.length;
    const spend = maySpend(leafStop, report.phases.leaves);
    await Promise.all(groups.map((g) => leafRun(() => compressScopeLeaves(deps, g.scope, g.partition, olderThan, spend, report))));
    report.phases.leaves.ms = Date.now() - startedAt;
  })();
  const mergeLane = buildMerges(deps, { boundaryMs: now - config.rawWindowMs, skip, width, mergeSlots, leafLane, lendSlots: () => leafRun.widen(width), maySpend: maySpend(opts.deadlineAt, report.phases.merges), report });
  await Promise.all([leafLane, mergeLane]);
  report.phases.merges.ms = Date.now() - startedAt;
  report.phases.leaves.count = report.leaves;
  report.phases.merges.count = report.merged;
  return report;
}

/**
 * The next leaf window of a scope: up to `max` activities strictly after
 * `after` and older than `olderThan`, oldest first. A window never ends inside
 * a run of activities sharing one stamp (one transaction can write several):
 * the next window starts strictly after this one's last stamp, so the rest of
 * the run would never be read. A full window whose next row ties its last
 * drops that tied tail, unless fewer than `min` rows would be left: then the
 * window takes the whole tied run too, or the rows before it could never
 * reach a leaf's minimum and the scope would stop compressing for good.
 */
export async function leafWindow(store: HistoryStore, scope: Scope, partition: Partition, after: Activity['at'] | null, olderThan: Activity['at'], max: number, min = 1): Promise<Activity[]> {
  const rows = await store.activities({ select: { scope }, partition, after: after ?? undefined, before: olderThan, order: 'asc', limit: max + 1 });
  if (rows.length <= max) return rows;
  const next = rows.pop()!.at;
  const kept = rows.filter((a) => a.at !== next);
  if (kept.length >= Math.max(1, min)) return kept;
  // Every row at that stamp, however many: a leaf longer than the maximum is
  // better than rows no leaf will ever hold.
  const tied = await store.activities({ select: { scope }, partition, from: next, until: next, order: 'asc', limit: Number.MAX_SAFE_INTEGER });
  return [...kept, ...tied];
}

async function compressScopeLeaves(deps: CompressDeps, scope: Scope, partition: Partition, olderThan: Activity['at'], maySpend: MaySpend, report: CompressReport): Promise<void> {
  const { store, summarizer, logger, config } = deps;
  try {
    for (;;) {
      let tip = await store.leafTip(scope, partition);
      if (tip.unnumbered) {
        if (!store.numberLegacyLeaves) return;
        await store.numberLegacyLeaves(scope, partition);
        tip = await store.leafTip(scope, partition);
        if (tip.unnumbered) return;
      }
      const window = await leafWindow(store, scope, partition, tip.end, olderThan, config.maxActivities, config.minActivities);
      if (window.length < config.minActivities) return;
      if (!maySpend()) return;
      const content = summaryText(await summarizer.leaf({ scope, lines: window.map((a) => `[${formatStamp(a.atMs)}] ${a.kind}: ${a.summary}`) }), 'leaf');
      const leaf = await store.appendLeaf(
        scope,
        partition,
        { start: window[0].at, end: window[window.length - 1].at, content, count: window.length, kinds: mergeKinds(window.map((a) => [a.kind])), tasks: mergeTaskTags(window.map((a) => a.tasks)) },
        tip.lastIndex,
      );
      // Another run appended this scope's next leaf first; it owns the scope for this pass.
      if (!leaf) return;
      report.leaves++;
      report.activities += window.length;
    }
  } catch (error) {
    report.failures++;
    logger.warn('leaf compression failed', { scope: scopeKey(scope), partition, error });
  }
}

/** One scope's pending merges, children before parents and oldest first, worked through in turns. */
interface MergePlan {
  scope: Scope;
  partition: Partition;
  todo: TreeBlock[];
  next: number;
  idByKey: Map<string, string>;
  leafEndMs: Map<number, number>;
}

/** When the oldest pending merge's last leaf ended; scopes with older gaps go first. */
const planAge = (p: MergePlan): number => p.leafEndMs.get(blockSpan(p.todo[p.next])[1] - 1) ?? Infinity;

async function planScope(store: HistoryStore, config: CompressConfig, scope: Scope, partition: Partition, boundaryMs: number): Promise<MergePlan | null> {
  const rows = await store.treeIndex(scope, partition, { endedBefore: store.cursorAt(boundaryMs) });
  const idByKey = new Map<string, string>();
  const leafEndMs = new Map<number, number>();
  for (const r of rows) {
    if (r.index === null) continue;
    idByKey.set(blockKey({ level: r.level, index: r.index }), r.id);
    if (r.level === 0) leafEndMs.set(r.index, r.endMs);
  }
  const T = leafPrefixCount(
    rows.map((r) => ({ level: r.level, blockIndex: r.index, endMs: r.endMs })),
    boundaryMs,
  );
  const exists = (b: TreeBlock) => idByKey.has(blockKey(b));
  const todo = config.merges === 'cover' ? pendingMerges(T, config.coverLines, exists) : completeMerges(T, exists);
  if (todo.length === 0) return null;
  // By where each block ends, then smallest first: every block follows both
  // of its children, and the oldest parent is finished before a newer one starts.
  todo.sort((a, b) => blockSpan(a)[1] - blockSpan(b)[1] || a.level - b.level);
  return { scope, partition, todo, next: 0, idByKey, leafEndMs };
}

/**
 * The merge lane. It plans every scope that needs merges, then gives the
 * scopes turns, oldest pending parent first, each turn at most
 * `mergesPerTurn` merges, so one huge scope cannot hold the reserved slots.
 * It runs on `mergeSlots` workers until the leaf lane ends, then on all of
 * them. Drained while leaves still run, it lends its slots to them; once the
 * leaves are done it plans again over the leaves they wrote.
 */
async function buildMerges(
  deps: CompressDeps,
  ctx: { boundaryMs: number; skip: readonly ScopeType[]; width: number; mergeSlots: number; leafLane: Promise<void>; lendSlots: () => void; maySpend: MaySpend; report: CompressReport },
): Promise<void> {
  const { store, config } = deps;
  const { boundaryMs, report } = ctx;
  let leavesDone = false;
  let slots = ctx.mergeSlots;
  let widen = () => {};
  const leavesEnd = () => {
    leavesDone = true;
    slots = ctx.width;
    widen();
  };
  // A failed leaf lane fails the pass (compressOnce rethrows it); merges still get every slot.
  void ctx.leafLane.then(leavesEnd, leavesEnd);
  const perTurn = Math.max(1, Math.floor(config.mergesPerTurn) || 1);
  let stopped = false;

  /** One turn; true when the scope has merges left for a later turn. */
  const turn = async (p: MergePlan): Promise<boolean> => {
    for (let built = 0; p.next < p.todo.length && built < perTurn; ) {
      const at = p.todo[p.next];
      const [left, right] = blockChildren(at).map((c) => p.idByKey.get(blockKey(c)));
      p.next++;
      // A half that failed to build (or a leaf number with no row) leaves this
      // block, and every block above it, to the reader's fallback.
      if (!left || !right) continue;
      if (!ctx.maySpend()) {
        stopped = true;
        return false;
      }
      built++;
      const block = await buildBlock(deps, p.scope, p.partition, at, left, right);
      if (block) {
        p.idByKey.set(blockKey(at), block.id);
        report.merged++;
      } else if (block === undefined) {
        report.failures++;
      } else {
        // Refused: a concurrent pass took the slot. Its block is this one's,
        // or two passes splitting siblings would each skip their parent.
        const taken = await store.blockAt(p.scope, p.partition, at);
        if (taken) p.idByKey.set(blockKey(at), taken.id);
      }
    }
    return p.next < p.todo.length;
  };

  for (;;) {
    const planned = { leavesDone, leaves: report.leaves };
    const scopes = await store.scopesNeedingMerges({ endedBefore: store.cursorAt(boundaryMs), minLeaves: config.merges === 'cover' ? config.coverLines : 1, skip: ctx.skip });
    report.mergeScopes = Math.max(report.mergeScopes, scopes.length);
    const read = semaphore(ctx.width);
    const plans = (await Promise.all(scopes.map((s) => read(() => planScope(store, config, s.scope, s.partition, boundaryMs))))).filter((p): p is MergePlan => p !== null);

    // Rounds: each scope gets one turn per round, oldest pending parent first.
    let queue = plans.sort((a, b) => planAge(a) - planAge(b));
    let later: MergePlan[] = [];
    const take = (): MergePlan | undefined => {
      if (queue.length === 0 && later.length > 0) {
        queue = later.sort((a, b) => planAge(a) - planAge(b));
        later = [];
      }
      return queue.shift();
    };
    await new Promise<void>((resolve) => {
      let workers = 0;
      const worker = async () => {
        try {
          for (let p = take(); p && !stopped; p = take()) if (await turn(p)) later.push(p);
        } catch (error) {
          report.failures++;
          deps.logger.warn('history merge lane failed', { error });
        }
        // A worker leaves only when the queue is empty or the lane stopped; the last one out ends the plan.
        if (--workers === 0) resolve();
      };
      widen = () => {
        if (queue.length === 0 && later.length === 0 && workers === 0) return resolve();
        while (workers < slots && !stopped && (queue.length > 0 || later.length > 0)) {
          workers++;
          void worker();
        }
      };
      widen();
    });
    widen = () => {};
    if (stopped) return;
    if (!leavesDone) {
      // Nothing left to merge until the leaves land: lend the reserved slots to them.
      ctx.lendSlots();
      await ctx.leafLane.catch(() => {});
    }
    // Plan again only over leaves written since this plan was read.
    if (planned.leavesDone || report.leaves === planned.leaves) return;
  }
}

/**
 * Write one merged block from its two halves. Null when the store refused it
 * (the slot is taken or a half is gone); undefined when the summary failed.
 */
export async function buildBlock(deps: Pick<CompressDeps, 'store' | 'summarizer' | 'logger'>, scope: Scope, partition: Partition, at: TreeBlock, leftId: string, rightId: string): Promise<Block | null | undefined> {
  const { store, summarizer, logger } = deps;
  try {
    const halves = await store.blocks([leftId, rightId]);
    const left = halves.find((b) => b.id === leftId);
    const right = halves.find((b) => b.id === rightId);
    if (!left || !right) return null;
    const content = summaryText(
      await summarizer.merge({
        scope,
        earlier: { range: dayRange(left.startMs, left.endMs), content: left.content },
        later: { range: dayRange(right.startMs, right.endMs), content: right.content },
      }),
      'merge',
    );
    return await store.putBlock(scope, partition, at, content, leftId, rightId);
  } catch (error) {
    logger.warn('history merge failed', { scope: scopeKey(scope), partition, level: at.level, index: at.index, error });
    return undefined;
  }
}
