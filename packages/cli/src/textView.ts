// Reading a long text body from a terminal: which lines to show, and which
// lines a pattern hit. `cast doc` and `cast vault` both page and both grep, and
// an agent that learned `100:250` on one must get the same slice from the other
// — so the rules live here once rather than being retyped per command group.
//
// Pure: line arrays in, numbers out. Colouring and printing stay with the
// command, which is the only part that differs.

/** 1-based inclusive, the way `cast doc show <id> 100:250` reads. */
export interface LineRange {
  start: number;
  end: number;
}

export interface RangeOptions {
  /** `100:250`, `100:`, `:50`, `42`. Wins over paging when present. */
  range?: string;
  /** Show everything, no paging. */
  full?: boolean;
  page?: number;
  pageSize?: number;
}

/**
 * The slice to print, plus how many pages the body has under `pageSize`.
 * `pages` is 1 whenever the caller asked for an explicit range or the whole
 * body, so "is there a next page" is always just `page < pages`.
 */
export function resolveLineRange(
  total: number,
  opts: RangeOptions,
): LineRange & { page: number; pages: number } {
  const size = Math.max(1, opts.pageSize ?? 200);
  const safeTotal = Math.max(1, total);

  if (opts.full) return { start: 1, end: total, page: 1, pages: 1 };

  if (opts.range) {
    let start = 1;
    let end = total;
    if (opts.range.includes(":")) {
      const [s, e] = opts.range.split(":");
      if (s) start = Math.max(1, parseInt(s, 10) || 1);
      if (e) end = Math.min(total, parseInt(e, 10) || total);
    } else {
      start = end = Math.min(total, Math.max(1, parseInt(opts.range, 10) || 1));
    }
    if (start > total) start = total;
    if (end < start) end = start;
    return { start, end, page: 1, pages: 1 };
  }

  const pages = Math.max(1, Math.ceil(safeTotal / size));
  const page = Math.min(pages, Math.max(1, opts.page ?? 1));
  return { start: (page - 1) * size + 1, end: Math.min(total, page * size), page, pages };
}

/**
 * A pattern as the user typed it. Tried as a regex first, because that is what
 * `-i` and `P0\.` mean; a pattern that doesn't compile is taken literally
 * rather than thrown back, since a bare `(` in a search box is a paren and not
 * a syntax error.
 */
export interface Matcher {
  /** Tests one line. */
  test: RegExp;
  /** The same pattern, global — for highlighting every hit on a line. */
  all: RegExp;
  /** The pattern had to be escaped to compile. */
  literal: boolean;
}

export function buildMatcher(pattern: string, ignoreCase = false): Matcher {
  const flags = ignoreCase ? "i" : "";
  let source: string;
  let literal = false;
  try {
    source = new RegExp(pattern, flags).source;
  } catch {
    source = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags).source;
    literal = true;
  }
  return { test: new RegExp(source, flags), all: new RegExp(source, flags + "g"), literal };
}

/** 0-based indices of the lines the matcher hits. */
export function matchingLines(lines: string[], matcher: Matcher): number[] {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // `test` on a non-global regex has no lastIndex to reset, which is why the
    // matcher keeps the global copy separate.
    if (matcher.test.test(lines[i])) hits.push(i);
  }
  return hits;
}

/**
 * The 0-based lines to print for a set of hits with `ctx` lines of context
 * each: hits in order, overlapping windows merged, and `null` wherever a gap
 * was skipped so the caller can print an elision marker.
 */
export function contextWindow(hits: number[], ctx: number, total: number): (number | null)[] {
  const out: (number | null)[] = [];
  let last = -1;
  for (const hit of hits) {
    const from = Math.max(0, hit - ctx);
    const to = Math.min(total - 1, hit + ctx);
    if (last >= 0 && from > last + 1) out.push(null);
    for (let i = Math.max(from, last + 1); i <= to; i++) {
      out.push(i);
      last = i;
    }
  }
  return out;
}
