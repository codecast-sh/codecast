// The range argument `cast read <id> <range>` takes. Lines number a session's
// messages from 1; on a session too long to number from the start, a tail read
// labels them from the end instead (-1 is the last message), so every label a
// read prints can be passed back as a range.

import { READ_BACK_MAX } from "./formatter.js";

export type ReadRange =
  | { kind: "forward"; start?: number; end?: number }
  /** `from` and `to` count back from the end (1 is the last message), from >= to. */
  | { kind: "back"; from: number; to: number };

export const READ_RANGE_FORMS = "Use 12:20, 12:, :20, 15, or from the end -1, -5:, -20:-10";

/** Parse a range, widening a single line by `context` messages on each side. Throws with the line to print. */
export function parseReadRange(range: string, context?: number): ReadRange {
  const c = context ?? 0;
  const forward = /^(\d+):(\d*)$|^:(\d+)$|^(\d+)$/.exec(range);
  if (forward) {
    if (forward[4] !== undefined) {
      const line = parseInt(forward[4], 10);
      return { kind: "forward", start: Math.max(1, line - c), end: line + c };
    }
    if (c) throw new Error("-c widens a single line (cast read <id> 15 -c 3); a range already says what it reads");
    if (forward[3] !== undefined) return { kind: "forward", end: parseInt(forward[3], 10) };
    return { kind: "forward", start: parseInt(forward[1], 10), end: forward[2] ? parseInt(forward[2], 10) : undefined };
  }
  const back = /^-(\d+)(?:(:)(?:-(\d+))?)?$/.exec(range);
  if (!back) throw new Error(`range '${range}' is not a message range. ${READ_RANGE_FORMS}; for the last messages, -n <count>.`);
  const first = parseInt(back[1], 10);
  if (first < 1) throw new Error("lines from the end start at -1 (the last message)");
  let from = first;
  let to = back[2] ? (back[3] ? parseInt(back[3], 10) : 1) : first;
  if (to < 1) throw new Error("lines from the end start at -1 (the last message)");
  if (to > from) throw new Error(`range '${range}' runs backwards: write the earlier line first, as in -${to}:-${from}`);
  if (!back[2]) {
    from += c;
    to = Math.max(1, to - c);
  } else if (c) {
    throw new Error("-c widens a single line (cast read <id> -5 -c 3); a range already says what it reads");
  }
  if (from > READ_BACK_MAX) throw new Error(`a read from the end reaches back at most ${READ_BACK_MAX} messages; for older ones use line numbers (cast read <id> 1:20)`);
  return { kind: "back", from, to };
}

/**
 * The messages of a back range, out of a tail read of `from` messages (oldest
 * first). Null when the range starts before the session does.
 */
export function sliceBackRange<T>(messages: T[], range: { from: number; to: number }): T[] | null {
  const n = messages.length;
  if (n < range.to) return null;
  return messages.slice(Math.max(0, n - range.from), n - range.to + 1);
}
