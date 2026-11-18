// The goals people stated (said.goals in the org review's inputs). A goal
// comes from a person, and people state direction in many places: a chat
// line, a turn on a call, the answer to a decision an agent asked, a decision
// recorded on a plan, the brief that opened a long running session. The
// readers in orgInit gather those as candidates; a small model reads them
// and picks the lines that set direction, quoting the words that do. No
// keyword decides: "breadth gets about 20% of the buy budget" names no goal
// word and is one.

import type { SurfaceRequest } from "./anthropic";
import { CHEAP_MODEL, parseJsonBlock } from "./anthropic";

export type GoalSourceKind = "decision" | "plan" | "session" | "chat" | "call";
/** One line a person wrote, said or answered, and where to read it whole. */
export type GoalCandidate = { kind: GoalSourceKind; at: number; by: string; where: string; text: string };
/** A goal as a person stated it: `line` holds their words, `where` the record
 *  to open around them (a channel, `cl-N`, `sd-N`, `pl-N`, a session id). */
export type StatedGoal = { at: number; by: string; line: string; where: string; kind?: GoalSourceKind };
export type StatedGoals = { lines: StatedGoal[]; truncated: boolean };

export const STATED_GOAL_CAPS = {
  /** One candidate's text: enough for a long turn or a decision with its why. */
  candidate_chars: 1500,
  /** Every candidate of the window, read in chunks; Haiku reads 300k chars for about two cents. */
  candidate_bytes: 300_000,
  chunk_chars: 75_000,
  max_tokens: 4000,
  /** The lines handed to the reviewer, and one line's length. */
  goal_bytes: 32_000,
  goal_line_chars: 500,
} as const;

export const STATED_GOALS_SYSTEM = `You read what the people of one company wrote, said and decided over the past month, and pick the lines that state where the company is going.

A line states direction when a person sets what the company or one of its efforts is for: a goal, a priority, a target or number to reach, what gets the budget or the people, what is held, dropped or started and the reason it matters to the company. A founder's answer to a decision, a decision a person recorded on a plan, and the brief a person opened a long running session with are where much of this is said, often without the word "goal". A line restating a goal someone stated elsewhere still counts; keep the clearest wording.

Leave out progress reports, status, review verdicts, task and code mechanics, scheduling, and questions nobody answered. When a line mixes direction with mechanics, the direction is what you quote.

For each line you pick, return its number and the words from it that state the direction, copied exactly, under 450 characters. Pick nothing from a chunk that sets no direction.`;

export const STATED_GOALS_SCHEMA = {
  type: "object",
  properties: {
    goals: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, quote: { type: "string" } },
        required: ["i", "quote"],
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
        model: CHEAP_MODEL,
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

/** The picks in one reply that name a candidate of its chunk. A quote is
 *  matched against the candidate with whitespace folded (a model re-flows a
 *  bullet list onto one line); the line kept is the candidate's own span. One
 *  that is not the candidate's words is replaced by the candidate's opening, so a line in said.goals is always
 *  what the person said. */
export function picksOf(text: string | null, candidates: GoalCandidate[], from: number, to: number): StatedGoal[] {
  const raw = text ? (parseJsonBlock(text) as any) : null;
  const out: StatedGoal[] = [];
  const seen = new Set<number>();
  for (const g of Array.isArray(raw?.goals) ? raw.goals : []) {
    const i = Number(g?.i);
    if (!Number.isInteger(i) || i < from || i >= to || seen.has(i)) continue;
    seen.add(i);
    const c = candidates[i];
    const line = ownWords(c.text, typeof g.quote === "string" ? g.quote : "") ?? c.text;
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
  const picks = chunks.flatMap((c, k) => picksOf(replies[k], kept, c.from, c.to));
  const lines: StatedGoal[] = [];
  let bytes = 0;
  let truncated = truncatedBefore || cut;
  for (const l of picks) {
    const size = JSON.stringify(l).length;
    if (bytes + size > STATED_GOAL_CAPS.goal_bytes) { truncated = true; break; }
    bytes += size;
    lines.push(l);
  }
  return { lines, truncated };
}
