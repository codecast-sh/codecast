// The goals people stated (said.goals in the org review's inputs). A goal
// comes from a person, and people state direction in many places: a chat
// line, a turn on a call, the answer to a decision an agent asked, a decision
// recorded on a plan, the brief that opened a long running session. The
// readers in orgInit gather those as candidates; a model reads them
// and picks the lines that set direction, quoting the words that do. No
// keyword decides: "breadth gets about 20% of the buy budget" names no goal
// word and is one.

import type { SurfaceRequest } from "./anthropic";
import { STRONG_MODEL, parseJsonBlock } from "./anthropic";

export type GoalSourceKind = "decision" | "plan" | "session" | "chat" | "call";
/** One line a person wrote, said or answered, and where to read it whole. */
export type GoalCandidate = { kind: GoalSourceKind; at: number; by: string; where: string; text: string };
/** A goal as a person stated it: `line` holds their words, `where` the record
 *  to open around them (a channel, `cl-N`, `sd-N`, `pl-N`, a session id). */
export type StatedGoal = { at: number; by: string; line: string; where: string; kind?: GoalSourceKind };
export type StatedGoals = { lines: StatedGoal[]; truncated: boolean };

/** The model the read runs on. Measured on 110 hand-labelled Union lines
 *  (packages/evals/scripts/stated-goals-measure.ts, 2026-11-17, 3 runs each):
 *  this prompt on Sonnet picked direction at precision 0.81 to 0.94 and
 *  recall 0.73 to 0.82; the keyword-free prompt first written for Haiku, on
 *  Haiku, at precision 0.22 to 0.42. This prompt was tuned on Sonnet, so
 *  Haiku's numbers on it (precision 0.25 to 0.67) are not a fair test of
 *  Haiku. */
export const STATED_GOALS_MODEL = STRONG_MODEL;

export const STATED_GOAL_CAPS = {
  /** One candidate's text: enough for a long turn or a decision with its why. */
  candidate_chars: 1500,
  /** Every candidate of the window, read in chunks: at the cap about 90k input tokens over eight calls, about half a dollar a review. */
  candidate_bytes: 300_000,
  /** A chunk's reading: Sonnet thinks before it answers, and its thinking
   *  bills against max_tokens (a 35k char chunk spent up to 3.7k tokens), so
   *  chunks stay near that size with room for a long list of picks. */
  chunk_chars: 40_000,
  max_tokens: 16_000,
  /** The lines handed to the reviewer, and one line's length. */
  goal_bytes: 32_000,
  goal_line_chars: 500,
} as const;

export const STATED_GOALS_SYSTEM = `You read what the people of one company wrote, said and decided over the past month, and find the few lines where a person set the company's direction: what the company or one of its efforts is for, a goal, priority or number to reach, where money or people go and why, a product, market or capability a person sets out to build and what it is for, an effort started, held or dropped for the company's sake. Founders often say this in an answer to a decision, a decision recorded on a plan, or the brief that opens a long running session, and rarely use the word "goal".

Most lines set no direction, and that includes most decisions. Approving a fix, a ship or a deploy, a rule for how a tool, a test, a call card or a process works, a spend for one task, a status report or a progress note keeps the work moving without saying where the company is going. Pick a line only when someone writing down the company's goals would miss something without it. A line restating direction someone set elsewhere still counts; keep the clearest wording.

For each line you pick, return its number, the direction it sets in a few words of your own, and the words from it that state that direction, copied exactly, under 450 characters. A chunk that sets no direction gets an empty list.`;

export const STATED_GOALS_SCHEMA = {
  type: "object",
  properties: {
    goals: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, sets: { type: "string" }, quote: { type: "string" } },
        required: ["i", "sets", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["goals"],
  additionalProperties: false,
} as const;

const SOURCE_WORDS: Record<GoalSourceKind, string> = {
  decision: "answered decision",
  plan: "plan decision",
  session: "session opening",
  chat: "chat",
  call: "call",
};
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const candidateLine = (c: GoalCandidate, i: number) => `[${i}] ${SOURCE_WORDS[c.kind]} · ${c.where} · ${c.by} · ${day(c.at)}\n${c.text}`;

/** The candidates in the order they are worth keeping, inside the byte budget. */
export function boundCandidates(candidates: GoalCandidate[]): { kept: GoalCandidate[]; truncated: boolean } {
  const kept: GoalCandidate[] = [];
  let bytes = 0;
  for (const c of candidates) {
    const text = c.text.trim().slice(0, STATED_GOAL_CAPS.candidate_chars);
    if (!text) continue;
    if (bytes + text.length > STATED_GOAL_CAPS.candidate_bytes) return { kept, truncated: true };
    bytes += text.length;
    kept.push({ ...c, text });
  }
  return { kept, truncated: false };
}

/** One request per chunk of candidates; numbers are global so a reply names its candidate. */
export function statedGoalsRequests(candidates: GoalCandidate[], workspace: string): Array<{ req: SurfaceRequest; from: number; to: number }> {
  const out: Array<{ req: SurfaceRequest; from: number; to: number }> = [];
  let from = 0;
  while (from < candidates.length) {
    let to = from, chars = 0;
    while (to < candidates.length && (to === from || chars + candidates[to].text.length <= STATED_GOAL_CAPS.chunk_chars)) chars += candidates[to++].text.length;
    const body = candidates.slice(from, to).map((c, k) => candidateLine(c, from + k)).join("\n\n");
    out.push({
      from,
      to,
      req: {
        model: STATED_GOALS_MODEL,
        max_tokens: STATED_GOAL_CAPS.max_tokens,
        system: STATED_GOALS_SYSTEM,
        prompt: `The company: ${workspace || "this workspace"}.\n\n${body}`,
        output_schema: STATED_GOALS_SCHEMA as unknown as Record<string, unknown>,
      },
    });
    from = to;
  }
  return out;
}

/** The picks in one reply that name a candidate of its chunk, each kept as
 *  the span of the candidate its quote copies (whitespace folded: a model
 *  re-flows a bullet list onto one line), so a line in said.goals is always
 *  what the person said and only the part the model read as direction. */
export function picksOf(text: string | null, candidates: GoalCandidate[], from: number, to: number): StatedGoal[] | null {
  const raw = text ? (parseJsonBlock(text) as any) : null;
  if (!Array.isArray(raw?.goals)) return null;
  const out: StatedGoal[] = [];
  const seen = new Set<number>();
  for (const g of raw.goals) {
    const i = Number(g?.i);
    if (!Number.isInteger(i) || i < from || i >= to || seen.has(i)) continue;
    const c = candidates[i];
    const line = ownWords(c.text, typeof g.quote === "string" ? g.quote : "");
    if (!line) continue;
    seen.add(i);
    out.push({ at: c.at, by: c.by, line: line.slice(0, STATED_GOAL_CAPS.goal_line_chars), where: c.where, kind: c.kind });
  }
  return out;
}

/** The span of `text` a quote copies, whitespace folded either side; null when the quote is not in it. */
function ownWords(text: string, quote: string): string | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const hit = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")).exec(text);
  return hit ? hit[0] : null;
}

/** How a caller asks the model: the reply's text, or null when there is none. */
export type AskModel = (req: SurfaceRequest) => Promise<string | null>;

/**
 * The stated goals from the window's candidates: every chunk read in
 * parallel, the picks kept in candidate order (the order the readers ranked
 * them), inside the reviewer's byte budget.
 */
export async function pickStatedGoals(candidates: GoalCandidate[], truncatedBefore: boolean, workspace: string, ask: AskModel): Promise<StatedGoals> {
  const { kept, truncated: cut } = boundCandidates(candidates);
  const chunks = statedGoalsRequests(kept, workspace);
  const replies = await Promise.all(chunks.map((c) => ask(c.req).catch(() => null)));
  const read = chunks.map((c, k) => picksOf(replies[k], kept, c.from, c.to));
  // A chunk with no readable answer (the call failed, or the answer ran out of
  // room before its list closed) lost its lines: the read says so.
  const unread = read.filter((r) => r === null).length;
  if (unread) console.error(`stated goals: ${unread} of ${chunks.length} chunks gave no readable answer`);
  const picks = read.flatMap((r) => r ?? []);
  const lines: StatedGoal[] = [];
  let bytes = 0;
  let truncated = truncatedBefore || cut || unread > 0;
  for (const l of picks) {
    const size = JSON.stringify(l).length;
    if (bytes + size > STATED_GOAL_CAPS.goal_bytes) { truncated = true; break; }
    bytes += size;
    lines.push(l);
  }
  return { lines, truncated };
}
