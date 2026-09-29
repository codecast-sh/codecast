// `cast read <id> --ask "<question>"`: the pure half. The action in
// sessionAsk.ts scans one conversation in bounded steps; each step turns a
// message row into an AskLine here, and the action then picks which lines a
// model reads (selectAskContext) and writes the prompt (buildAskPrompt).
//
// Line numbers are `cast read`'s: the 1-based index among non-empty rows, so a
// citation "msg 412" is `cast read <id> 412`.
//
// No Convex imports: tests and the step query both load this leaf.

import { countMatches } from "@codecast/shared/search";
import { formatToolName, isEditTool, isWriteTool, toolPathFromInput, toolSummary } from "@codecast/shared/render";
import { isCompactionMessage, isNavigableUserMessage, stripContextTags, type FilterableMessage } from "../userMessagesFilter";

export type AskLineKind = "human" | "agent" | "result" | "compaction" | "context";

export interface AskLine {
  line: number;
  kind: AskLineKind;
  /** Prose, clipped: whole-ish when it matched the question, a head otherwise. */
  text: string;
  /** One line per tool call: its name and main argument. */
  tools: string[];
  /** Tool results, clipped around the match; only on matching lines, plus errors. */
  results: string[];
  error?: boolean;
  /** Files this line edited or wrote. */
  files: string[];
  /** Indexes into the question's terms that this line mentions anywhere. */
  hits: number[];
}

// Clip sizes. A matching line keeps enough to judge it; the rest keep a head.
const HIT_TEXT_CHARS = 3000;
const COMPACTION_TEXT_CHARS = 6000;
const PLAIN_TEXT_CHARS = { human: 1200, agent: 400, result: 0, compaction: 1500, context: 200 } as const;
const HIT_RESULT_CHARS = 700;
const ERROR_RESULT_CHARS = 200;
const TOOL_LINE_CHARS = 160;
const MAX_TERMS = 14;

const STOP_WORDS = new Set([
  "the and for with that this what when where which who whom why how did does was were are is has have had",
  "been being not but you your our their its any all can could would should will about into from than then",
  "there here they them these those some such only also just more most much very over under again ever",
  "later first last say said tell told",
].join(" ").split(" "));

/**
 * Search terms from the question itself: identifiers, paths, quoted phrases
 * and content words. The model's own expansion is merged in by the caller.
 */
export function questionTerms(question: string): string[] {
  const terms: string[] = [];
  for (const m of question.matchAll(/"([^"]{3,})"|`([^`]{3,})`/g)) terms.push((m[1] ?? m[2]).toLowerCase());
  const bare = question.replace(/"[^"]*"|`[^`]*`/g, " ");
  for (const raw of bare.split(/[\s,;:!?()[\]{}]+/)) {
    const word = raw.replace(/^[^\w./@-]+|[^\w./@-]+$/g, "").replace(/'s$/, "").toLowerCase();
    if (word.length < 3 || STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
    terms.push(word);
  }
  return dedupeTerms(terms);
}

/** Lowercased, unique, longest first, capped. A term inside a longer one stays: both can match. */
export function dedupeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const term = t.trim().toLowerCase();
    if (term.length < 3 || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out.slice(0, MAX_TERMS);
}

/** A head of `text`, plus windows around the first matches when the head misses them. */
export function clipAround(text: string, terms: string[], max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  const lower = text.toLowerCase();
  const positions: number[] = [];
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0) positions.push(at);
  }
  positions.sort((a, b) => a - b);
  const headLen = Math.floor(max / 2);
  const later = positions.filter((p) => p > headLen).slice(0, 2);
  if (later.length === 0) return `${text.slice(0, max)} […]`;
  const window = Math.floor((max - headLen) / later.length);
  const parts = [text.slice(0, headLen)];
  let end = headLen;
  for (const p of later) {
    const from = Math.max(end, p - Math.floor(window / 3));
    if (from >= text.length) break;
    parts.push(text.slice(from, from + window));
    end = from + window;
  }
  return `${parts.join(" […] ")}${end < text.length ? " […]" : ""}`;
}

type ToolCall = { id?: string; name: string; input: string };
type ToolResult = { tool_use_id?: string; content?: string; is_error?: boolean };

export type AskMessage = Omit<FilterableMessage, "tool_calls" | "tool_results"> & {
  tool_calls?: ToolCall[] | null;
  tool_results?: ToolResult[] | null;
};

function kindOf(m: AskMessage): AskLineKind {
  if (isCompactionMessage(m)) return "compaction";
  if (m.role === "assistant") return "agent";
  if (isNavigableUserMessage(m)) return "human";
  if (m.tool_results?.length && !stripContextTags(m.content ?? "")) return "result";
  return "context";
}

function parseInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** One non-empty message as the question sees it. Pure; the step query calls it per row. */
export function toAskLine(m: AskMessage, line: number, terms: string[]): AskLine {
  const kind = kindOf(m);
  const prose = stripContextTags(m.content ?? "");
  const calls = m.tool_calls ?? [];
  const results = m.tool_results ?? [];

  const hits: number[] = [];
  terms.forEach((term, i) => {
    const t = [term];
    if (countMatches(prose, t) > 0
      || calls.some((c) => countMatches(c.input ?? "", t) > 0)
      || results.some((r) => countMatches(r.content ?? "", t) > 0)) hits.push(i);
  });
  const matchedTerms = hits.map((i) => terms[i]);
  const hit = hits.length > 0;

  const textMax = kind === "compaction" ? COMPACTION_TEXT_CHARS : hit ? HIT_TEXT_CHARS : PLAIN_TEXT_CHARS[kind];
  const files: string[] = [];
  const tools = calls.map((c) => {
    if (isEditTool(c.name) || isWriteTool(c.name)) {
      const path = toolPathFromInput(parseInput(c.input));
      if (path && !files.includes(path)) files.push(path);
    }
    const summary = toolSummary(c as { name: string; input: string });
    return `${formatToolName(c.name)}${summary ? ` ${summary}` : ""}`.slice(0, TOOL_LINE_CHARS);
  });
  const error = results.some((r) => r.is_error) || undefined;
  const keptResults = results
    .filter((r) => r.content && (hit || r.is_error))
    .slice(0, 3)
    .map((r) => clipAround(r.content!.trim(), matchedTerms, hit ? HIT_RESULT_CHARS : ERROR_RESULT_CHARS));

  return {
    line,
    kind,
    text: clipAround(prose, matchedTerms, textMax),
    tools,
    results: keptResults,
    ...(error ? { error } : {}),
    files,
    hits,
  };
}

// ── Choosing what the model reads ─────────────────────────────────────────

export interface AskContextOptions {
  /** Characters of rendered excerpt the model may read. */
  budget: number;
  termCount: number;
  /** Files each line changed outside its own tool calls (disk-observed edits). */
  extraFiles?: Map<number, string[]>;
}

export interface AskContext {
  /** The excerpts, oldest first, with gaps marked. */
  text: string;
  shownLines: number[];
  /** The lines that matched the question best. */
  anchorLines: number[];
  matchedLines: number;
}

const ANCHORS = 30;
const TAIL_LINES = 12;
const NEIGHBOR_SPAN = 2;
const BRIEF_TEXT_CHARS = 280;

const KIND_LABEL: Record<AskLineKind, string> = {
  human: "human",
  agent: "agent",
  result: "tool result",
  compaction: "compaction summary",
  context: "injected context",
};

/** One line as the model reads it. `brief` drops tool results and keeps a head of the prose. */
export function renderAskLine(l: AskLine, brief: boolean): string {
  const text = brief && l.text.length > BRIEF_TEXT_CHARS ? `${l.text.slice(0, BRIEF_TEXT_CHARS)} […]` : l.text;
  const out = [`[msg ${l.line} · ${KIND_LABEL[l.kind]}${l.error ? ", error" : ""}]${text ? ` ${text}` : ""}`];
  for (const t of l.tools) out.push(`  tool call: ${t}`);
  if (!brief) for (const r of l.results) out.push(`  result: ${r}`);
  else if (l.error && l.results[0]) out.push(`  result: ${l.results[0].slice(0, ERROR_RESULT_CHARS)}`);
  return out.join("\n");
}

/**
 * Pick the lines a model needs to answer, under a character budget, in order
 * of how much each kind of line matters to a question about where a session
 * ended up:
 *   1. the lines that match the question best,
 *   2. every LATER line on the same terms or files, newest first, because a
 *      later line is what revises or reverts an earlier answer,
 *   3. the human's turns after the first match (decisions and corrections),
 *   4. the session's last lines (where it stands now),
 *   5. whatever of 1 and 2 did not fit whole, briefly,
 *   6. compaction summaries (orientation),
 *   7. neighbours of the best matches, briefly,
 *   8. everything else, briefly, newest first; a short session fits whole.
 * Pure.
 */
export function selectAskContext(lines: AskLine[], opts: AskContextOptions): AskContext {
  const n = lines.length;
  const byLine = new Map(lines.map((l) => [l.line, l]));
  const filesOf = (l: AskLine) => [...l.files, ...(opts.extraFiles?.get(l.line) ?? [])];

  // Rarer terms say more: weight each by inverse line frequency.
  const df = new Array(opts.termCount).fill(0);
  for (const l of lines) for (const t of l.hits) df[t]++;
  const idf = df.map((d) => (d === 0 ? 0 : Math.log(1 + n / d)));
  const score = (l: AskLine) => {
    const s = l.hits.reduce((sum, t) => sum + idf[t], 0);
    return l.kind === "human" ? s * 1.5 : l.kind === "context" ? s * 0.5 : s;
  };

  const scored = lines.filter((l) => l.hits.length > 0).map((l) => ({ l, s: score(l) }));
  const anchors = [...scored].sort((a, b) => b.s - a.s || b.l.line - a.l.line).slice(0, ANCHORS).map((x) => x.l);
  const firstAnchor = anchors.reduce((min, l) => Math.min(min, l.line), Infinity);

  // The topic: terms at least as specific as the median anchor term, and the files the anchors changed.
  const anchorTerms = [...new Set(anchors.flatMap((l) => l.hits))].sort((a, b) => idf[b] - idf[a]);
  const cut = anchorTerms.length ? idf[anchorTerms[Math.floor((anchorTerms.length - 1) / 2)]] : Infinity;
  const topicTerms = new Set(anchorTerms.filter((t) => idf[t] >= cut));
  const topicFiles = new Set(anchors.flatMap(filesOf));
  const onTopic = (l: AskLine) => l.hits.some((t) => topicTerms.has(t)) || filesOf(l).some((f) => topicFiles.has(f));

  const newestFirst = [...lines].reverse();
  const later = newestFirst.filter((l) => l.line > firstAnchor && onTopic(l));
  const humansAfter = newestFirst.filter((l) => l.line > firstAnchor && l.kind === "human");
  const tail = lines.slice(-TAIL_LINES).reverse();
  const compactions = newestFirst.filter((l) => l.kind === "compaction");
  const neighbors: AskLine[] = [];
  for (const a of anchors) {
    for (let d = -NEIGHBOR_SPAN; d <= NEIGHBOR_SPAN; d++) {
      const nb = d !== 0 ? byLine.get(a.line + d) : undefined;
      if (nb) neighbors.push(nb);
    }
  }
  const humansRest = newestFirst.filter((l) => l.kind === "human");
  const rest = newestFirst.filter((l) => l.kind !== "result" || l.error);

  const chosen = new Map<number, string>();
  let used = 0;
  // `share` caps how far into the budget a tier may reach, so the best matches
  // cannot crowd out the later lines that would correct them.
  const offer = (tier: AskLine[], brief: boolean, share = 1) => {
    const limit = opts.budget * share;
    for (const l of tier) {
      if (chosen.has(l.line)) continue;
      const rendered = renderAskLine(l, brief);
      if (used + rendered.length > limit) continue;
      chosen.set(l.line, rendered);
      used += rendered.length + 1;
    }
  };
  offer(anchors, false, 0.4);
  offer(later, false, 0.75);
  offer(humansAfter, false, 0.85);
  offer(tail, false);
  offer([...anchors, ...later], true);
  offer(compactions, false);
  offer(neighbors, true);
  offer(humansRest, true);
  offer(rest, true);

  const shownLines = [...chosen.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = 0;
  for (const line of shownLines) {
    if (line > prev + 1) parts.push(`[… msg ${prev + 1}–${line - 1} not shown …]`);
    parts.push(chosen.get(line)!);
    prev = line;
  }
  const last = lines.length ? lines[lines.length - 1].line : 0;
  if (last > prev) parts.push(`[… msg ${prev + 1}–${last} not shown …]`);

  return {
    text: parts.join("\n"),
    shownLines,
    anchorLines: anchors.map((l) => l.line).sort((a, b) => a - b),
    matchedLines: scored.length,
  };
}

// ── The prompts ───────────────────────────────────────────────────────────

/** Ask the model for extra search terms. Pure so a test reads the exact text. */
export function buildTermsPrompt(question: string): string {
  return `A question is about to be answered from the transcript of one coding-agent session. The transcript is searched by case-insensitive substring before anything reads it, so recall depends on guessing the words the session itself would have used.

List up to 8 search terms for this question: identifiers, file or table names, commands, and the plain words people would use when discussing it, including words for the likely answer. Prefer distinctive terms over common ones. Reply with a JSON array of strings and nothing else.

Question: ${question}`;
}

/** The terms in the model's reply, or none when it is not a JSON array of strings. */
export function parseTermsReply(reply: string | null | undefined): string[] {
  if (!reply) return [];
  const match = reply.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export const ASK_SYSTEM_PROMPT = `You answer one question about one recorded coding-agent session, using only the excerpts you are given. Whoever asked will act on your answer, so an answer the session later abandoned is worse than no answer.

A session is work unfolding over time. People change their minds, agents try things that fail, findings get checked and corrected. What matters is where the session ended up. When you find a relevant passage, keep reading forward through everything after it: a later line can revise, supersede, revert or contradict it, and when one does, the later line is the answer and the earlier one is history to mention as such.

Weigh evidence by what it is. A tool call records what the agent attempted, not what happened; its result, and what the session did next, say whether it worked. The human's turns carry the decisions and corrections with the most authority. A compaction summary is the session's own recap of earlier work: use it to orient, but when exact values, wording or requirements matter, rely on the original lines if they are present.

The excerpts are a selection from the session, and the gaps are marked. If they do not answer the question, say plainly that it is not found in this session, and name the closest lines if any are useful. Never fill a gap with a plausible guess.

Lead with the direct answer in a sentence or three. Then give the evidence as short bullets, each citing the session messages it rests on as msg <number> (or msg <from>–<to>), the number from that message's bracketed marker, so the reader can open them with cast read. Line numbers inside the excerpts, such as those in a file the agent read, are not message numbers. When the answer changed during the session, say so: what was said first and where, and what replaced it. Plain text, no preamble.`;

export interface AskPromptInput {
  question: string;
  title: string;
  totalLines: number;
  shownLines: number;
  excerpts: string;
}

export function buildAskPrompt(input: AskPromptInput): string {
  return `Session: ${input.title}
Lines: ${input.totalLines} in all, ${input.shownLines} shown below.

Question: ${input.question}

Excerpts, oldest first:
${input.excerpts}

Question again: ${input.question}`;
}

/** Message numbers the answer cites (msg 12, msg 12–15, msg 12-msg 15), in order, deduplicated. */
export function citedLines(answer: string): number[] {
  const out: number[] = [];
  for (const m of answer.matchAll(/\bmsgs? (\d+)(?:\s*[–-]\s*(?:msg )?(\d+))?/gi)) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let i = from; i <= Math.min(to, from + 50); i++) if (!out.includes(i)) out.push(i);
  }
  return out;
}
