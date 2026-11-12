// The orchestration of one `cast read`: which lines a read covers, and the
// scan-then-fetch steps it drives through the conversations read queries
// (scanConversationLines, readConversationLines). Pure over the steps it is
// handed, so the HTTP route can run it without importing conversations.ts,
// which sits in the big import cycle (ct-92432).
import { countMatches } from "@codecast/shared/search";

/** Messages one readConversationLines call returns at most. */
export const READ_PAGE_SIZE = 50;

/**
 * Bytes of message documents one step of a read deserializes before it hands
 * back a cursor. Rows carry inline image data, thinking and embeddings, so a
 * row count says nothing about memory: loading every row of a long session in
 * one query ran out of Convex's 64 MB heap (`cast read`, `cast summary` and
 * `cast diff` all failed on such a session, 2026-09-23).
 */
export const READ_STEP_BYTES = 4_000_000;

/**
 * The lines a read covers.
 *
 * An explicit range means every line in it, and a start with no end reads to
 * the last message, as `cast read` documents. With no range at all a read is
 * the first twenty lines, and an anchored read is a window of `context` lines
 * on each side of the anchor. Pass `Infinity` as the count to learn how many
 * lines the scan must reach before the true count is known.
 */
export function readRange(
  nonEmptyCount: number,
  args: { start_line?: number; end_line?: number; context?: number },
  targetLine: number | undefined,
): { startLine: number; lastLine: number } {
  let startLine: number;
  let endLine: number;
  if (targetLine !== undefined && args.start_line === undefined && args.end_line === undefined) {
    const ctxN = Math.min(Math.floor((READ_PAGE_SIZE - 1) / 2), Math.max(0, args.context ?? 10));
    startLine = Math.max(1, targetLine - ctxN);
    endLine = targetLine + ctxN;
  } else if (args.start_line === undefined && args.end_line === undefined) {
    startLine = 1;
    endLine = 20;
  } else {
    startLine = Math.max(1, args.start_line ?? 1);
    endLine = args.end_line ?? Infinity;
  }
  return { startLine, lastLine: Math.min(endLine, nonEmptyCount) };
}

type ReadRangeArgs = {
  api_token: string;
  conversation_id: string;
  start_line?: number;
  end_line?: number;
  full_content?: boolean;
  around_message_id?: string;
  context?: number;
  include_file_changes?: boolean;
  // The last N messages, found by scanning newest first.
  tail?: number;
  // Only the messages holding this text (in their words, tool calls or tool
  // results), with their true line numbers; a range narrows where to look.
  grep?: string;
};

export type ScanCursor = { creation_time: number; skip: number };

type ReadSteps = {
  scan: (args: {
    api_token: string;
    conversation_id: string;
    after?: ScanCursor;
    newest_first?: boolean;
    around_message_id?: string;
    include_file_changes?: boolean;
    grep?: string;
  }) => Promise<any>;
  fetch: (args: {
    api_token: string;
    conversation_id: string;
    ids: string[];
    first_line: number;
    lines?: number[];
    full_content?: boolean;
  }) => Promise<any>;
};

/** Messages a tail read returns at most. */
export const READ_TAIL_MAX = 500;

/** Matching messages a --grep read returns at most; the next read starts past the last one. */
export const READ_GREP_MAX = 30;

/** Whether a message holds any of the find terms: in its words, its tool calls' input, or its tool results. */
export function messageHasFindTerms(
  m: { content?: string; tool_calls?: Array<{ input?: string }>; tool_results?: Array<{ content?: string }> },
  terms: string[],
): boolean {
  if (m.content && countMatches(m.content, terms) > 0) return true;
  if (m.tool_calls?.some((tc) => tc.input && countMatches(tc.input, terms) > 0)) return true;
  return !!m.tool_results?.some((tr) => typeof tr.content === "string" && countMatches(tr.content, terms) > 0);
}

/**
 * Scan steps until `enough` says the ids cover what the read needs, or the
 * last row is read. The first step carries the header and the file changes.
 */
async function scanLines(
  steps: ReadSteps,
  args: ReadRangeArgs,
  newestFirst: boolean,
  enough: (ids: string[], anchorIndex: number | undefined, matches: number[]) => boolean,
) {
  const ids: string[] = [];
  // Indexes into `ids` of the rows holding args.grep.
  const matches: number[] = [];
  let head: any;
  let anchorIndex: number | undefined;
  let after: ScanCursor | undefined;
  for (;;) {
    const step = await steps.scan({
      api_token: args.api_token,
      conversation_id: args.conversation_id,
      after,
      newest_first: newestFirst || undefined,
      around_message_id: anchorIndex === undefined ? args.around_message_id : undefined,
      include_file_changes: head ? undefined : args.include_file_changes,
      grep: args.grep,
    });
    if (step?.error) return { error: step };
    head ??= step;
    if (step.anchor_index !== undefined && anchorIndex === undefined) anchorIndex = ids.length + step.anchor_index;
    for (const i of step.matches ?? []) matches.push(ids.length + i);
    ids.push(...step.ids);
    if (!step.cursor) return { ids, head, anchorIndex, matches, complete: true };
    after = step.cursor;
    if (enough(ids, anchorIndex, matches)) return { ids, head, anchorIndex, matches, complete: false };
  }
}

/** Fetch the messages behind `ids` in steps, numbered from `firstLine`, or by `lines` when they are not consecutive. */
async function fetchLines(steps: ReadSteps, args: ReadRangeArgs, ids: string[], firstLine: number, lines?: number[]) {
  const messages: any[] = [];
  let done = 0;
  while (done < ids.length) {
    const page = await steps.fetch({
      api_token: args.api_token,
      conversation_id: args.conversation_id,
      ids: ids.slice(done),
      first_line: firstLine + done,
      ...(lines ? { lines: lines.slice(done) } : {}),
      full_content: args.full_content,
    });
    if (page?.error) return { error: page };
    messages.push(...page.messages);
    done += page.consumed;
  }
  return { messages };
}

/**
 * Read a range of a conversation in steps that each stay under a byte budget.
 *
 * Line numbers count only non-empty messages, so the lines cannot be found
 * without reading the rows before them. The scan steps return just the ids of
 * the non-empty rows, and stop as soon as the range (and the anchor) is
 * reached. The fetch steps then load only the rows in the range.
 *
 * A tail read scans newest first and stops after N messages. When that scan
 * reaches the first row the lines carry their true numbers; otherwise the
 * true numbers are unknown without reading the whole session, so the lines
 * count back from the end: -1 is the last message.
 */
export async function readConversationRange(steps: ReadSteps, args: ReadRangeArgs): Promise<any> {
  if (args.tail !== undefined) {
    const n = Math.max(1, Math.min(Math.floor(args.tail), READ_TAIL_MAX));
    const scan = await scanLines(steps, { ...args, around_message_id: undefined, grep: undefined }, true, (ids) => ids.length >= n);
    if ("error" in scan) return scan.error;
    const ids = scan.ids.slice(0, n).reverse();
    const count = scan.complete ? scan.ids.length : Math.max(scan.ids.length, scan.head.conversation.message_count ?? 0);
    const fetched = await fetchLines(steps, args, ids, scan.complete ? count - ids.length + 1 : -ids.length);
    if ("error" in fetched) return fetched.error;
    return { conversation: { ...scan.head.conversation, message_count: count, message_count_exact: scan.complete }, messages: fetched.messages };
  }

  if (args.grep !== undefined) {
    // Scan from the start (line numbers need every row before them) until one
    // match past the page is found, so the reply can say more follow.
    const start = Math.max(1, args.start_line ?? 1);
    const end = args.end_line ?? Infinity;
    const inRange = (matches: number[]) => matches.filter((i) => i + 1 >= start && i + 1 <= end);
    const scan = await scanLines(steps, { ...args, around_message_id: undefined }, false, (ids, _a, matches) =>
      ids.length >= end || inRange(matches).length > READ_GREP_MAX);
    if ("error" in scan) return scan.error;
    const hits = inRange(scan.matches);
    const shown = hits.slice(0, READ_GREP_MAX);
    const fetched = await fetchLines(steps, args, shown.map((i) => scan.ids[i]), 0, shown.map((i) => i + 1));
    if ("error" in fetched) return fetched.error;
    const count = scan.complete ? scan.ids.length : Math.max(scan.ids.length, scan.head.conversation.message_count ?? 0);
    return {
      conversation: { ...scan.head.conversation, message_count: count, message_count_exact: scan.complete },
      messages: fetched.messages,
      grep: { matches: shown.length, searched: Math.max(0, Math.min(scan.ids.length, end) - start + 1), more: hits.length > shown.length },
    };
  }

  const anchorPending = (anchorIndex: number | undefined) => args.around_message_id !== undefined && anchorIndex === undefined;
  const scan = await scanLines(steps, args, false, (ids, anchorIndex) =>
    ids.length >= readRange(Infinity, args, anchorIndex === undefined ? undefined : anchorIndex + 1).lastLine && !anchorPending(anchorIndex));
  if ("error" in scan) return scan.error;
  const { ids, head, anchorIndex, complete } = scan;

  // An anchor on an empty row snaps to the next visible line, or the last one.
  const targetLine = anchorIndex === undefined || ids.length === 0 ? undefined : Math.min(anchorIndex, ids.length - 1) + 1;
  // The stored count includes empty rows; it stands in only when the scan stopped early.
  const count = complete ? ids.length : Math.max(ids.length, head.conversation.message_count ?? 0);
  const { startLine, lastLine } = readRange(count, args, targetLine);
  const fetched = await fetchLines(steps, args, ids.slice(startLine - 1, Math.min(lastLine, ids.length)), startLine);
  if ("error" in fetched) return fetched.error;

  const { file_changes, file_changes_truncated } = head;
  return {
    conversation: { ...head.conversation, message_count: count, message_count_exact: complete },
    messages: fetched.messages,
    ...(args.include_file_changes ? { file_changes, file_changes_truncated } : {}),
    // Line of the anchored message (1-based) so callers can highlight it.
    target_line: targetLine,
    target_message_id: targetLine !== undefined ? args.around_message_id : undefined,
    target_missing: (args.around_message_id !== undefined && targetLine === undefined) || undefined,
  };
}
