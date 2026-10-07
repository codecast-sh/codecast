import { HISTORY_COVER_LINES } from './tree';

/**
 * What one read may spend. Lines bound the compressed part (the cover); tokens
 * bound the whole read and split across its three parts. A read takes its
 * budget from the request, then the agent's profile, then these defaults.
 */
export interface ReadBudget {
  /** Most blocks the compressed part renders. Default 32. */
  coverLines?: number;
  /** The most lines any read may render; a larger `coverLines`, from a tool call or anywhere else, is cut to it. Default 96. */
  maxCoverLines?: number;
  /** Token ceiling for the whole read. Default 100,000. */
  tokens?: number;
  /** How the tokens split, in percent: raw lines, recent blocks, older blocks. Default 50/30/20. */
  split?: { raw: number; recent: number; older: number };
  /**
   * How far back raw lines reach before blocks take over. A scoped read
   * defaults to 14 days by age; a cross-scope feed fills by tokens and the
   * blocks begin where its oldest kept line ends.
   */
  rawWindow?: { kind: 'age'; ms: number } | { kind: 'tokens' };
}

export const SCOPED_RAW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** A line budget above this is read as this. */
export const MAX_COVER_LINES = 1024;

export interface ResolvedBudget {
  coverLines: number;
  maxCoverLines: number;
  tokens: number;
  rawTokens: number;
  recentTokens: number;
  olderTokens: number;
  rawWindow?: { kind: 'age'; ms: number } | { kind: 'tokens' };
}

export const DEFAULT_BUDGET = {
  coverLines: HISTORY_COVER_LINES,
  maxCoverLines: 96,
  tokens: 100_000,
  split: { raw: 50, recent: 30, older: 20 },
} as const;

const whole = (n: unknown, fallback: number, min: number, max: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;

/**
 * Layer budgets, first defined field wins, and make them safe: a line budget
 * is a whole number from 1 to MAX_COVER_LINES, tokens are zero or more, and a
 * split with a negative, missing or non-finite part, or one summing past 100,
 * falls back to the default split. A nonsense value never widens a read.
 */
export function resolveBudget(...layers: Array<ReadBudget | undefined>): ResolvedBudget {
  const pick = <K extends keyof ReadBudget>(k: K): ReadBudget[K] | undefined => {
    for (const l of layers) if (l && l[k] !== undefined) return l[k];
    return undefined;
  };
  const asked = whole(pick('coverLines'), DEFAULT_BUDGET.coverLines, 1, MAX_COVER_LINES);
  const ceiling = pick('maxCoverLines');
  const maxCoverLines = whole(ceiling, DEFAULT_BUDGET.maxCoverLines, 1, MAX_COVER_LINES);
  const coverLines = Math.min(asked, maxCoverLines);
  const tokens = whole(pick('tokens'), DEFAULT_BUDGET.tokens, 0, Number.MAX_SAFE_INTEGER);
  const wanted = pick('split');
  const parts = wanted ? [wanted.raw, wanted.recent, wanted.older] : [];
  const valid = parts.length === 3 && parts.every((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0) && parts[0] + parts[1] + parts[2] <= 100;
  const split = valid ? wanted! : DEFAULT_BUDGET.split;
  const window = pick('rawWindow');
  const rawWindow =
    window && window.kind === 'age'
      ? Number.isFinite(window.ms) && window.ms >= 0
        ? window
        : undefined
      : window;
  return {
    coverLines,
    maxCoverLines,
    tokens,
    rawTokens: Math.floor((tokens * split.raw) / 100),
    recentTokens: Math.floor((tokens * split.recent) / 100),
    olderTokens: Math.floor((tokens * split.older) / 100),
    rawWindow,
  };
}

/**
 * Pick which lines of an oldest-to-newest read fit a token budget, filling
 * from the NEWEST end and stopping at the first line that does not fit. A
 * reader always sees a contiguous block of its most recent lines; when the
 * read overflows, the OLDEST lines drop, never the newest.
 */
export function fillBudgetNewestFirst(lineTokens: readonly number[], budget: number): { kept: boolean[]; tokensUsed: number; keptCount: number } {
  const kept = new Array<boolean>(lineTokens.length).fill(false);
  let tokensUsed = 0;
  let keptCount = 0;
  for (let i = lineTokens.length - 1; i >= 0; i--) {
    if (tokensUsed + lineTokens[i] > budget) break;
    kept[i] = true;
    tokensUsed += lineTokens[i];
    keptCount++;
  }
  return { kept, tokensUsed, keptCount };
}

/** A cover cut to its token budgets: what each section keeps, and what was cut. */
export interface CoverFit<T> {
  recent: T[];
  older: T[];
  /** Blocks cut from the middle, between the first block and the kept stretch ending now. */
  dropped: number;
  /** Set when the first block alone is larger than the whole cover budget: the tokens it may still show. */
  clipFirstTo?: number;
}

/**
 * A cover (oldest first) as its two sections: the run of leaves at the recent
 * end, and everything before it, merged blocks first. The first block, the one
 * reaching back to the first leaf, always survives: it is charged first,
 * against its own section's budget and then the other's, and when it alone is
 * larger than both together it is kept and `clipFirstTo` says how much of it
 * fits. The rest keep to their section budgets from the newest end, and a
 * recent run cut short leaves nothing older to place. So what is kept is the
 * first block plus one contiguous stretch ending now, and what is cut comes
 * from the middle, oldest after the first, first.
 */
export function budgetCover<T extends { level: number }>(planned: readonly T[], tokensOf: (row: T) => number, recentBudget: number, olderBudget: number): CoverFit<T> {
  if (planned.length === 0) return { recent: [], older: [], dropped: 0 };
  let split = planned.length;
  while (split > 0 && planned[split - 1].level === 0) split--;
  const first = planned[0];
  const firstIsRecent = split === 0;
  const total = Math.max(0, recentBudget) + Math.max(0, olderBudget);
  const firstTokens = tokensOf(first);
  const charge = Math.min(firstTokens, total);
  let recentLeft = recentBudget;
  let olderLeft = olderBudget;
  if (firstIsRecent) {
    const own = Math.min(charge, Math.max(0, recentLeft));
    recentLeft -= own;
    olderLeft -= charge - own;
  } else {
    const own = Math.min(charge, Math.max(0, olderLeft));
    olderLeft -= own;
    recentLeft -= charge - own;
  }
  const fit = (rows: readonly T[], budget: number): T[] => {
    const kept: T[] = [];
    let used = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      used += tokensOf(rows[i]);
      if (used > budget) break;
      kept.unshift(rows[i]);
    }
    return kept;
  };
  const recentRun = planned.slice(Math.max(split, 1));
  const recentKept = fit(recentRun, recentLeft);
  const olderKept = recentKept.length === recentRun.length ? fit(planned.slice(1, Math.max(split, 1)), olderLeft) : [];
  const recent = firstIsRecent ? [first, ...recentKept] : recentKept;
  const older = firstIsRecent ? [] : [first, ...olderKept];
  return { recent, older, dropped: planned.length - recent.length - older.length, ...(firstTokens > total ? { clipFirstTo: total } : {}) };
}

/** A cover at the resolution its token budget allows, and how it was cut to fit. */
export interface FittedCover<T> {
  /** The line budget the cover was planned at. */
  lines: number;
  /** The planned blocks, oldest first, before the cut. */
  blocks: T[];
  fit: CoverFit<T>;
}

/**
 * The cover a token budget allows. At `coverLines` when it fits whole;
 * otherwise the cover first gets coarser, at the most lines that fit whole
 * (found by bisection), and only when even the coarsest tiling does not fit
 * are blocks cut from the middle (budgetCover). `coverAt(lines)` plans and
 * loads the cover at a line budget, oldest first.
 */
export async function fitCover<T extends { level: number }>(
  coverLines: number,
  coverAt: (lines: number) => Promise<T[]> | T[],
  tokensOf: (row: T) => number,
  recentBudget: number,
  olderBudget: number,
): Promise<FittedCover<T>> {
  const at = async (lines: number): Promise<FittedCover<T>> => {
    const blocks = await coverAt(lines);
    return { lines, blocks, fit: budgetCover(blocks, tokensOf, recentBudget, olderBudget) };
  };
  const whole = (c: FittedCover<T>) => c.fit.dropped === 0 && c.fit.clipFirstTo === undefined;
  const chosen = await at(coverLines);
  if (whole(chosen)) return chosen;
  let coarsest = chosen;
  let fitting: FittedCover<T> | null = null;
  for (let lo = 1, hi = coverLines - 1; lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    const c = await at(mid);
    if (mid < coarsest.lines) coarsest = c;
    if (whole(c)) {
      fitting = c;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return fitting ?? coarsest;
}

/**
 * Split blocks ordered newest first into the recent and older sections by
 * token budget: recent fills first, then older, stopping at the first block
 * that fits neither.
 */
export function splitRecentOlder<T>(newestFirst: readonly T[], tokensOf: (row: T) => number, recentBudget: number, olderBudget: number): { recent: T[]; older: T[] } {
  const recent: T[] = [];
  const older: T[] = [];
  let recentUsed = 0;
  let olderUsed = 0;
  let recentPhase = true;
  for (const row of newestFirst) {
    const tokens = tokensOf(row);
    if (recentPhase) {
      if (recentUsed + tokens <= recentBudget) {
        recent.push(row);
        recentUsed += tokens;
        continue;
      }
      recentPhase = false;
    }
    if (olderUsed + tokens <= olderBudget) {
      older.push(row);
      olderUsed += tokens;
    } else {
      break;
    }
  }
  return { recent, older };
}

/**
 * Drop unnumbered leaves whose range overlaps a better leaf of the SAME scope
 * (legacy data could hold several summaries of one window). Preference: longer
 * summary, then newest written. Numbered leaves hold their own position and
 * pass through untouched. Survivors keep the input order.
 */
export function dedupeOverlappingLeaves<T extends { scopeKey: string; startMs: number; endMs: number; content: string; createdAtMs: number; index: number | null }>(input: readonly T[]): T[] {
  const legacy = input.filter((c) => c.index == null);
  const byPreference = [...legacy].sort((a, b) => b.content.length - a.content.length || b.createdAtMs - a.createdAtMs);
  const keptByScope = new Map<string, T[]>();
  const kept = new Set<T>();
  for (const leaf of byPreference) {
    const scopeKept = keptByScope.get(leaf.scopeKey) ?? [];
    if (scopeKept.some((k) => leaf.startMs <= k.endMs && k.startMs <= leaf.endMs)) continue;
    scopeKept.push(leaf);
    keptByScope.set(leaf.scopeKey, scopeKept);
    kept.add(leaf);
  }
  return input.filter((c) => c.index != null || kept.has(c));
}
