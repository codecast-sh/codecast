// Shrinking a failing delivery order (docs/architecture/multiplayer-sim-harness.md,
// section 3.12). `bun run sim --shrink <artifactDir>` runs this over the
// recorded --order line of a failure.
//
// Pure: the caller supplies `reproduces`, which replays one candidate (a
// subsequence of the recorded channels, by index) and says whether it fails
// the same way. The runner (scripts/sim.ts) makes each one a subprocess.
//
// Two phases:
// 1. The shortest prefix that still fails, by binary search. An order replay
//    runs as scripted once its list is used up (net.ts), so a prefix is
//    always a whole run.
// 2. ddmin (Zeller and Hildebrandt) over the entries of that prefix: drop
//    chunks, then complements, at doubling granularity, until no single entry
//    can go (1-minimal).
// Candidates are memoized, so a repeated candidate costs no attempt. A cap on
// attempts or time stops the search with the best order found so far.

import type { SimShrinkProgress } from "@codecast/shared/contracts/evalsApi";

/**
 * Leads the --order line of a scripted run. A scripted run drains after each
 * verb and an interleave run only at settle, so a replay must drain where the
 * recorded run did; this word carries which one it was. Channel names always
 * hold a ':' or are "sched", so it cannot be mistaken for one.
 */
export const SCRIPTED_ORDER_MARK = "scripted";

export const SHRINK_MAX_ATTEMPTS = 400;
export const SHRINK_MAX_MS = 10 * 60_000;

/** An --order line split into its drain mark and its channels. */
export function splitOrderLine(tokens: readonly string[]): { mark: string | null; channels: string[] } {
  return tokens[0] === SCRIPTED_ORDER_MARK ? { mark: tokens[0], channels: tokens.slice(1) } : { mark: null, channels: [...tokens] };
}

export interface ShrinkOptions {
  maxAttempts?: number;
  maxMs?: number;
  now?: () => number;
  /** Called after every attempt. */
  onProgress?: (p: SimShrinkProgress) => void;
}

export interface ShrinkResult {
  /** The full recorded order failed the same way; when false nothing else ran. */
  reproduced: boolean;
  /** Indexes into the recorded channels that the smallest failing order keeps, ascending. */
  kept: number[];
  /** Indexes it removed, ascending. */
  removed: number[];
  attempts: number;
  ms: number;
  /** ddmin finished: removing any one kept entry no longer fails. False when a cap stopped it. */
  oneMinimal: boolean;
}

class CapReached extends Error {}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function chunks<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = start + Math.floor((items.length - start) / (n - i));
    out.push(items.slice(start, end));
    start = end;
  }
  return out.filter((c) => c.length);
}

/**
 * Shrinks a failing order of `length` entries. `reproduces(kept)` replays the
 * entries at those indexes, in order, and resolves true when the run fails
 * the same way.
 */
export async function shrinkOrder(length: number, reproduces: (kept: number[]) => Promise<boolean>, opts: ShrinkOptions = {}): Promise<ShrinkResult> {
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? SHRINK_MAX_ATTEMPTS;
  const maxMs = opts.maxMs ?? SHRINK_MAX_MS;
  const start = now();
  const memo = new Map<string, boolean>();
  let attempts = 0;
  let phase: SimShrinkProgress["phase"] = "prefix";
  let best = range(length);

  const test = async (kept: number[]): Promise<boolean> => {
    const key = kept.join(",");
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (attempts >= maxAttempts || now() - start >= maxMs) throw new CapReached();
    attempts++;
    const ok = await reproduces(kept);
    memo.set(key, ok);
    if (ok && kept.length < best.length) best = kept;
    opts.onProgress?.({ phase, attempts, best: best.length, recorded: length });
    return ok;
  };

  const done = (reproduced: boolean, oneMinimal: boolean): ShrinkResult => {
    const keep = new Set(best);
    return { reproduced, kept: best, removed: range(length).filter((i) => !keep.has(i)), attempts, ms: now() - start, oneMinimal };
  };

  try {
    if (!(await test(best))) return done(false, false);

    // Phase 1: the shortest failing prefix. The empty one first: when it
    // fails, no pinned order is needed at all, and ddmin may assume it passes.
    if (await test([])) {
      best = [];
      return done(true, true);
    }
    let lo = 1;
    let hi = length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await test(range(mid))) hi = mid;
      else lo = mid + 1;
    }
    best = range(hi);

    // Phase 2: ddmin over its entries.
    phase = "ddmin";
    let c = best;
    let n = 2;
    while (c.length >= 2) {
      const parts = chunks(c, n);
      let next: number[] | null = null;
      for (const part of parts) {
        if (await test(part)) {
          next = part;
          n = 2;
          break;
        }
      }
      if (!next && parts.length > 2) {
        for (const part of parts) {
          const drop = new Set(part);
          const complement = c.filter((i) => !drop.has(i));
          if (await test(complement)) {
            next = complement;
            n = Math.max(n - 1, 2);
            break;
          }
        }
      }
      if (next) {
        c = next;
        continue;
      }
      if (n >= c.length) break;
      n = Math.min(c.length, n * 2);
    }
    best = c;
    return done(true, true);
  } catch (e) {
    if (e instanceof CapReached) return done(memo.get(range(length).join(",")) === true, false);
    throw e;
  }
}
