// What `cast read` prints: a page of numbered messages, its footer, and the
// ref a shared short id needs. Loaded by the read commands only.

import { fmt } from "./colors.js";
import { formatDate, formatRole, READ_BACK_MAX, summarizeToolCall, truncateId, truncatePath } from "./formatter.js";

interface ReadMessage {
  line: number;
  role: string;
  content: string;
  timestamp: string;
  tool_calls?: unknown[];
  tool_results?: unknown[];
}

export interface ReadResult {
  conversation: {
    id: string;
    title: string;
    project_path: string | null;
    message_count: number;
    /** False when the count is the stored row count (a scan that stopped early), not the numbered lines. */
    message_count_exact?: boolean;
    updated_at: string;
    /** Other conversations the caller can read that share this short id (a collision), newest first. */
    same_short_id?: Array<{ id: string; title: string; updated_at: string }>;
  };
  messages: ReadMessage[];
  target_line?: number;
  /** A --grep read: how many messages matched, how many lines were searched, and whether more matches follow. */
  grep?: { matches: number; searched?: number; more?: boolean };
}

/** The shortest prefix of `id`, at least a short id long, that no id in
 *  `others` starts with: what to type to reach this conversation when its
 *  short id is shared. The full id when no prefix separates them. */
export function distinctIdPrefix(id: string, others: string[] = []): string {
  for (let n = 7; n < id.length; n++) {
    const prefix = id.slice(0, n);
    if (!others.some((o) => o.startsWith(prefix))) return prefix;
  }
  return id;
}

/** The ref a read's hints print for its conversation: the short id, or a
 *  longer prefix when other conversations share that short id. */
export function readRefFor(conv: { id: string; same_short_id?: Array<{ id: string }> }): string {
  return distinctIdPrefix(conv.id, (conv.same_short_id ?? []).map((o) => o.id));
}

export interface FormatOptions {
  full?: boolean;
  targetLine?: number;
  /**
   * Stop the page once its messages pass this many characters and name the
   * command that reads on. An agent's shell tool keeps only a short preview of
   * output past ~30K characters, so a read meant for one must fit under that.
   */
  maxChars?: number;
  /** The text a --grep read looked for: the footer counts its matches instead of paging. */
  grep?: string;
}

export function formatReadResult(result: ReadResult, options: FormatOptions = {}): string {
  const lines: string[] = [];

  const conv = result.conversation;
  const header = `── ${conv.title} `;
  const padding = "─".repeat(Math.max(0, 60 - header.length));
  lines.push(header + padding);

  const ref = readRefFor(conv);
  const meta = [
    ref,
    formatDate(conv.updated_at),
    `${conv.message_count} msgs`,
    truncatePath(conv.project_path),
  ].filter(Boolean).join(" | ");
  lines.push(`   ${meta}`);
  const others = conv.same_short_id ?? [];
  if (others.length > 0) {
    const allIds = [conv.id, ...others.map((o) => o.id)];
    lines.push(`   ${fmt.accent(`! ${others.length + 1} sessions share the short id ${truncateId(conv.id)}. This is ${ref}; to read the other${others.length === 1 ? "" : "s"}:`)}`);
    for (const o of others) {
      lines.push(`     cast read ${distinctIdPrefix(o.id, allIds.filter((x) => x !== o.id))}   ${o.title} (${formatDate(o.updated_at)})`);
    }
  }

  const targetLine = options.targetLine ?? result.target_line;
  if (targetLine !== undefined) {
    lines.push(`   ${fmt.muted(`↓ around linked message (line ${targetLine})`)}`);
  }
  lines.push("");

  const blocks: Array<{ line: number; text: string }> = [];
  for (const msg of result.messages) {
    const hasContent = msg.content && msg.content.trim();
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
    // Streaming artifacts carry nothing; a turn holding only tool results shows
    // nothing but its header unless --full prints the results.
    // A grep match can sit in a tool result alone: name it rather than drop it.
    const resultOnlyMatch = options.grep !== undefined && hasToolResults && !options.full && !hasContent && !hasToolCalls;
    if (!hasContent && !hasToolCalls && !(hasToolResults && options.full) && !resultOnlyMatch) {
      continue;
    }
    const block: string[] = [];

    const isTarget = targetLine !== undefined && msg.line === targetLine;
    const lineNum = String(msg.line).padStart(4);
    const role = formatRole(msg.role);
    block.push(isTarget ? `${fmt.accent("►")}${lineNum.slice(1)}: ${role} ${fmt.accent("← linked")}` : `${lineNum}: ${role}`);

    if (hasContent) {
      const indentedContent = msg.content.split("\n").map((l) => "       " + l).join("\n");
      block.push(indentedContent);
    }
    if (resultOnlyMatch) block.push(`       ${fmt.muted(`(in a tool result: cast read ${ref} ${msg.line} --full)`)}`);

    if (hasToolCalls && msg.tool_calls) {
      if (options.full) {
        block.push(`       <TOOL_CALLS>`);
        for (const tc of msg.tool_calls as Array<{ name?: string; input?: unknown }>) {
          block.push(`       - ${tc.name || "unknown"}`);
          if (tc.input) {
            let parsed = tc.input;
            try { if (typeof parsed === "string") parsed = JSON.parse(parsed); } catch {}
            const inputStr = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
            const indented = inputStr.split("\n").map((l: string) => "         " + l).join("\n");
            block.push(indented);
          }
        }
        block.push(`       </TOOL_CALLS>`);
      } else {
        const calls = msg.tool_calls as Array<{ name?: string; input?: unknown }>;
        const first = summarizeToolCall(calls[0]);
        const more = calls.length > 1 ? ` ...(${calls.length - 1} more)` : "";
        block.push(`       ${fmt.muted(`${first}${more}`)}`);
        // A StructuredOutput call's INPUT is the agent's whole deliverable, and
        // this collapsed line is all a non-full read shows of it — readers have
        // mistaken that for an empty result. Point at the exact command.
        if (calls.some((tc) => tc.name === "StructuredOutput")) {
          block.push(`       ${fmt.muted(`↳ full payload: cast read ${ref} ${msg.line} --full`)}`);
        }
      }
    }

    if (hasToolResults && msg.tool_results && options.full) {
      block.push(`       <TOOL_RESULTS>`);
      for (const tr of msg.tool_results as Array<{ content?: string; isError?: boolean }>) {
        const prefix = tr.isError ? "[ERROR] " : "";
        const content = tr.content || "(empty)";
        const truncated = content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated)" : content;
        const indented = truncated.split("\n").map((l) => "         " + prefix + l).join("\n");
        block.push(indented);
      }
      block.push(`       </TOOL_RESULTS>`);
    }

    blocks.push({ line: msg.line, text: block.join("\n") + "\n" });
  }

  const id = ref;
  const page = fitReadPage(blocks, options.maxChars, id, targetLine);
  lines.push(...page.texts);
  if (!page.cut) {
    const footer = readFooter(result, id, options.grep);
    if (footer) lines.push(fmt.muted(footer));
  }
  return lines.join("\n");
}

/**
 * Where a read sits in its session and the commands that move from it: the
 * lines shown out of the total, then the next page, the latest messages, or
 * the earlier ones. Lines below zero count back from the end (a tail read on
 * a session too long to number from the start).
 */
function readFooter(result: ReadResult, id: string, grep?: string): string | null {
  const shown = result.messages.map((m) => m.line);
  const total = result.conversation.message_count;
  const about = result.conversation.message_count_exact === false ? "about " : "";
  if (grep !== undefined) {
    const g = result.grep;
    const found = g ? g.matches : shown.length;
    const quoted = JSON.stringify(grep);
    if (found === 0) return `no message in this session contains ${quoted}${g?.searched ? ` (searched ${g.searched} lines)` : ""}`;
    const more = g?.more && shown.length ? `; more: cast read ${id} ${shown[shown.length - 1] + 1}: --grep ${quoted}` : "";
    return `${found}${g?.more ? "+" : ""} message${found === 1 ? "" : "s"} contain ${quoted}${more}; open one with: cast read ${id} <line> -c 3`;
  }
  if (shown.length === 0) return null;
  const first = shown[0];
  const last = shown[shown.length - 1];
  if (last < 0) {
    const back = -first;
    const span = back + last + 1;
    const reach = Math.min(back + span, READ_BACK_MAX);
    const parts = [last === -1
      ? `the last ${back} of ${about}${total} lines, counted back from the end`
      : `lines ${first} to ${last} of ${about}${total}, counted back from the end`];
    if (reach > back) parts.push(`earlier: cast read ${id} -${reach}:-${back + 1}`);
    if (last < -1) parts.push(`later: cast read ${id} ${last + 1}:`);
    return parts.join("; ");
  }
  const parts = [first === last ? `line ${first} of ${about}${total}` : `lines ${first}-${last} of ${about}${total}`];
  if (last < total) {
    parts.push(`next: cast read ${id} ${last + 1}:${Math.min(total, last + 20)}`);
    parts.push(`latest: cast read ${id} -n 10`);
  } else if (first > 1) {
    parts.push(`earlier: cast read ${id} ${Math.max(1, first - 20)}:${first - 1}`);
  }
  return parts.join("; ");
}

/**
 * The blocks that fit in maxChars. A forward read keeps its start and names
 * the range that continues it; a tail read (negative lines count back from
 * the end) keeps its newest messages. A single message larger than the page
 * is cut, with the command that prints it whole.
 */
export function fitReadPage(blocks: Array<{ line: number; text: string }>, maxChars: number | undefined, id: string, targetLine?: number): { texts: string[]; cut: boolean } {
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  if (!maxChars || total <= maxChars) return { texts: blocks.map((b) => b.text), cut: false };
  const limit = `${Math.round(maxChars / 1000)}K-character page`;
  if (blocks.length === 1) {
    const b = blocks[0];
    return {
      texts: [b.text.slice(0, maxChars), fmt.muted(`… message ${b.line} is ${b.text.length} characters, cut to fit a ${limit}; whole: cast read ${id} ${b.line} --full --json`)],
      cut: true,
    };
  }
  // A read around a linked message keeps that message and grows outward from
  // it, nearest first: filling forward from the earliest context line can push
  // the very message asked for off the page.
  const at = targetLine === undefined ? -1 : blocks.findIndex((b) => b.line === targetLine);
  if (at >= 0) {
    // A linked message larger than the page takes half of it, so what answered
    // it still shows: a reader following a link needs the reaction as much as the text.
    const big = blocks[at].text.length > maxChars;
    const target = big ? fitReadPage([blocks[at]], Math.floor(maxChars / 2), id).texts.join("\n") + "\n" : blocks[at].text;
    blocks = blocks.map((b, i) => (i === at ? { ...b, text: target } : b));
    let lo = at, hi = at, used = target.length, grew = true;
    while (grew) {
      grew = false;
      if (hi + 1 < blocks.length && used + blocks[hi + 1].text.length <= maxChars) { used += blocks[++hi].text.length; grew = true; }
      if (lo > 0 && used + blocks[lo - 1].text.length <= maxChars) { used += blocks[--lo].text.length; grew = true; }
    }
    const texts = blocks.slice(lo, hi + 1).map((b) => b.text);
    if (lo > 0) texts.unshift(fmt.muted(`… ${lo} earlier message${lo === 1 ? "" : "s"} cut to fit a ${limit}; read them: cast read ${id} ${blocks[0].line}:${blocks[lo - 1].line}`) + "\n");
    if (hi < blocks.length - 1) texts.push(fmt.muted(`… page ends here (${limit}); continue: cast read ${id} ${blocks[hi + 1].line}:${blocks[blocks.length - 1].line}`));
    return { texts, cut: true };
  }
  const fromEnd = blocks.some((b) => b.line < 0);
  const ordered = fromEnd ? [...blocks].reverse() : blocks;
  const kept: typeof blocks = [];
  let used = 0;
  for (const b of ordered) {
    if (kept.length > 0 && used + b.text.length > maxChars) break;
    kept.push(b);
    used += b.text.length;
  }
  if (kept.length === 1 && kept[0].text.length > maxChars) {
    // The one message kept is itself past the page: cut it as above and name the rest.
    const lone = fitReadPage(kept, maxChars, id).texts;
    const rest = fromEnd ? `read further back: cast read ${id} ${kept[0].line - (blocks.length - 1)}:${kept[0].line - 1}` : `continue: cast read ${id} ${blocks[1].line}:${blocks[blocks.length - 1].line}`;
    return { texts: [...lone, fmt.muted(`… ${rest}`)], cut: true };
  }
  const cut = blocks.length - kept.length;
  if (fromEnd) {
    return { texts: [fmt.muted(`… ${cut} older message${cut === 1 ? "" : "s"} cut to fit a ${limit}; read further back: cast read ${id} ${kept[kept.length - 1].line - cut}:${kept[kept.length - 1].line - 1}`) + "\n", ...kept.reverse().map((b) => b.text)], cut: true };
  }
  const next = blocks[kept.length].line;
  const last = blocks[blocks.length - 1].line;
  return { texts: [...kept.map((b) => b.text), fmt.muted(`… page ends here (${limit}); continue: cast read ${id} ${next}:${last}`)], cut: true };
}
