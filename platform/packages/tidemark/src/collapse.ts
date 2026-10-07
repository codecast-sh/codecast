import type { Activity } from './log';
import { singleScope, type ScopeSelector } from './scope';

/**
 * Read-side folding of machine noise. Nothing here decides what is noise: the
 * host's policy does. The mechanism is two folds: stories (many activities of
 * one kind in one bucket become one line with a handle that reopens them) and
 * the census (routine work in a cross-scope read becomes one counted line).
 */
export interface CollapsePolicy {
  /**
   * Same key = one "(xN) … [story: handle]" line. Null keeps the activity as
   * its own line. A key should bucket one kind over one stretch of time,
   * because the story handle reopens by kind and time.
   */
  aggregateKey?(a: Activity): string | null;
  /** Folded into the census line where the census applies. */
  routine?(a: Activity): boolean;
  /** Whether a leaf holding exactly these kinds is routine, and folds into the block census. */
  routineBlock?(kinds: readonly string[]): boolean;
  /** Where the census applies. Default: reads that span more than one scope. */
  appliesTo?(select: ScopeSelector): boolean;
}

export const censusApplies = (policy: CollapsePolicy | undefined, select: ScopeSelector): boolean =>
  !!policy && (policy.appliesTo ? policy.appliesTo(select) : singleScope(select) === null);

/** An aggregateKey that buckets the given kinds by UTC hour, and `byDay` kinds by UTC day. */
export function bucketKinds(byHour: Iterable<string>, byDay: Iterable<string> = []): (a: Activity) => string | null {
  const hour = new Set(byHour);
  const day = new Set(byDay);
  return (a) => {
    const iso = new Date(a.atMs).toISOString();
    if (day.has(a.kind)) return `${a.kind}_${iso.slice(0, 10)}`;
    if (hour.has(a.kind)) return `${a.kind}_${iso.slice(0, 13)}`;
    return null;
  };
}

export interface ActivityGroup {
  /** True when the activity's kind is bucketed; whether it collapsed several rows is `count > 1`. */
  bucketed: boolean;
  kind: string;
  count: number;
  first: Activity;
  last: Activity;
  /** Up to three distinct summaries. */
  summaries: string[];
}

/** Group an oldest-first read into lines: one per unbucketed activity, one per bucket at its first appearance. */
export function aggregate(ascending: readonly Activity[], policy?: CollapsePolicy): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  const result: ActivityGroup[] = [];
  for (const a of ascending) {
    const key = policy?.aggregateKey?.(a) ?? null;
    if (key === null) {
      result.push({ bucketed: false, kind: a.kind, count: 1, first: a, last: a, summaries: [a.summary] });
      continue;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (a.atMs > existing.last.atMs) existing.last = a;
      if (a.atMs < existing.first.atMs) existing.first = a;
      if (existing.summaries.length < 3 && !existing.summaries.includes(a.summary)) existing.summaries.push(a.summary);
    } else {
      const group: ActivityGroup = { bucketed: true, kind: a.kind, count: 1, first: a, last: a, summaries: [a.summary] };
      groups.set(key, group);
      result.push(group);
    }
  }
  return result;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `YYYY-MM-DD HH:MM-HH:MM`, or both ends dated when the stretch crosses a day (UTC). */
export function spanStamp(firstMs: number, lastMs: number): string {
  return day(firstMs) === day(lastMs) ? `${day(firstMs)} ${hhmm(firstMs)}-${hhmm(lastMs)}` : `${day(firstMs)} ${hhmm(firstMs)} to ${day(lastMs)} ${hhmm(lastMs)}`;
}

/** A collapsed group as one line. `handle` is the story handle that reopens it. */
export function formatStoryLine(group: ActivityGroup, handle: string): string {
  return `[${day(group.first.atMs)} ${hhmm(group.first.atMs)}-${hhmm(group.last.atMs)}] ${group.kind} (x${group.count}): ${group.summaries.join(' | ')} [story: ${handle}]`;
}

export interface KindTally {
  kind: string;
  count: number;
  firstMs: number;
  lastMs: number;
}

export interface Census {
  /** Activities (raw read) or blocks (summary sections) folded. */
  total: number;
  firstMs: number;
  lastMs: number;
  kinds: KindTally[];
}

/** Tally items into one census, or null when there are none. Kinds come largest first. */
export function tally(items: ReadonlyArray<{ kind: string; firstMs: number; lastMs: number; count: number }>): Census | null {
  if (items.length === 0) return null;
  const byKind = new Map<string, KindTally>();
  let total = 0;
  let firstMs = items[0].firstMs;
  let lastMs = items[0].lastMs;
  for (const item of items) {
    total += item.count;
    if (item.firstMs < firstMs) firstMs = item.firstMs;
    if (item.lastMs > lastMs) lastMs = item.lastMs;
    const seen = byKind.get(item.kind);
    if (seen) {
      seen.count += item.count;
      if (item.firstMs < seen.firstMs) seen.firstMs = item.firstMs;
      if (item.lastMs > seen.lastMs) seen.lastMs = item.lastMs;
    } else {
      byKind.set(item.kind, { ...item });
    }
  }
  return { total, firstMs, lastMs, kinds: [...byKind.values()].sort((a, b) => b.count - a.count) };
}

export interface Partitioned<T> {
  /** Rendered line by line, in input order. */
  signal: T[];
  /** Folded into the census. */
  routine: T[];
  census: Census | null;
}

/** Split a read into what is read line by line and what is only counted. */
export function partitionRoutine(ascending: readonly Activity[], policy: CollapsePolicy | undefined, applies: boolean): Partitioned<Activity> {
  if (!applies || !policy?.routine) return { signal: [...ascending], routine: [], census: null };
  const signal: Activity[] = [];
  const routine: Activity[] = [];
  for (const a of ascending) (policy.routine(a) ? routine : signal).push(a);
  return { signal, routine, census: tally(routine.map((a) => ({ kind: a.kind, firstMs: a.atMs, lastMs: a.atMs, count: 1 }))) };
}

/** The same split one tier up, over leaves. A leaf with no recorded kinds is kept, never guessed away. */
export function partitionRoutineBlocks<T extends { startMs: number; endMs: number; kinds?: string[] }>(blocks: readonly T[], policy: CollapsePolicy | undefined, applies: boolean): Partitioned<T> {
  if (!applies || !policy?.routineBlock) return { signal: [...blocks], routine: [], census: null };
  const signal: T[] = [];
  const routine: T[] = [];
  for (const b of blocks) (b.kinds && b.kinds.length > 0 && policy.routineBlock(b.kinds) ? routine : signal).push(b);
  const census = tally(routine.flatMap((b) => (b.kinds ?? []).map((kind) => ({ kind, firstMs: b.startMs, lastMs: b.endMs, count: 1 }))));
  // Each kind line counts the blocks holding it; the headline is the block count.
  if (census) census.total = routine.length;
  return { signal, routine, census };
}

/** The raw read's census line. Each kind carries its own story handle. */
export function formatActivityCensus(census: Census, storyHandle: (k: KindTally) => string): string {
  const kinds = census.kinds.map((k) => `${k.kind} x${k.count} [story: ${storyHandle(k)}]`).join(' | ');
  return `[${spanStamp(census.firstMs, census.lastMs)}] routine activity (x${census.total}), collapsed: high-volume machine work with no decision by a person in any of it. ${kinds}`;
}

/** The summary sections' census line. Counts are blocks holding the kind, not events, and it says so. */
export function formatBlockCensus(census: Census, storyHandle: (k: KindTally) => string): string {
  const kinds = census.kinds.map((k) => `${k.kind} (in ${k.count}) [story: ${storyHandle(k)}]`).join(' | ');
  return (
    `[${spanStamp(census.firstMs, census.lastMs)}] ${census.total} routine summary blocks, collapsed: every event under them is routine machine work, so their summaries said only that it happened. ` +
    `Kinds present, by how many of these blocks hold them: ${kinds}\n` +
    `(To read the real events behind any kind, open its story handle: it returns the primary rows, not a summary.)`
  );
}
