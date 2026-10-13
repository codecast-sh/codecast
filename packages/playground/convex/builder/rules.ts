// The builder's decisions that need no database: which build runs next, what
// the budgets allow, how a failure reads to people, and the narration a card
// shows. queue.ts and run.ts apply them.
import { APP_DAILY_BUDGET_USD, GLOBAL_DAILY_BUDGET_USD, IDEA_MAX, IDEAS_MAX, NARRATION_LINE_MAX, NARRATION_LINES_MAX, VISITOR_DAILY_BUDGET_USD } from "../lib/limits";
import { clipLine, oneLine } from "../lib/text";
import type { FailureKind, NarrationLine } from "../validators";

export type QueueRow<Id> = { _id: Id; status: "queued" | "building" | "live" | "failed"; _creationTime: number };

/** The build to start now: the oldest queued one, unless one is building.
 *  One at a time per app, first in first out. */
export function nextInLine<Id>(rows: readonly QueueRow<Id>[]): Id | null {
  if (rows.some((r) => r.status === "building")) return null;
  const queued = rows.filter((r) => r.status === "queued").sort((a, b) => a._creationTime - b._creationTime);
  return queued[0]?._id ?? null;
}

export type Refusal = { kind: FailureKind; error: string; detail: string };

/** The daily spend budgets a build counts toward. */
export type Budget = "global" | "app" | "visitor";
export type Over = Record<Budget, boolean>;

export const SPEND_BUDGET_USD: Record<Budget, number> = {
  global: GLOBAL_DAILY_BUDGET_USD,
  app: APP_DAILY_BUDGET_USD,
  visitor: VISITOR_DAILY_BUDGET_USD,
};

/** Which budgets today's spend has used up. */
export const overBudget = (spent: Record<Budget, number>): Over => ({
  global: spent.global >= SPEND_BUDGET_USD.global,
  app: spent.app >= SPEND_BUDGET_USD.app,
  visitor: spent.visitor >= SPEND_BUDGET_USD.visitor,
});

/** Why a build may not start now, or null when it may. `over` says which
 *  daily budgets are spent. The global budget is the circuit breaker; the
 *  app's and the asker's own budgets are what keep one app or one person from
 *  spending it. */
export function startRefusal(opts: { paused: boolean; over: Over }): Refusal | null {
  if (opts.paused) return { kind: "refused", error: "Building is paused right now. Try again in a little while.", detail: "builds are switched off (PLAYGROUND_BUILDS_OFF)" };
  if (opts.over.global) {
    return { kind: "refused", error: "Clayground has used today's building budget. Try again tomorrow.", detail: `global daily budget of $${GLOBAL_DAILY_BUDGET_USD} spent` };
  }
  if (opts.over.app) {
    return { kind: "refused", error: "This app has used today's building budget. Try again tomorrow, or fork it.", detail: `app daily budget of $${APP_DAILY_BUDGET_USD} spent` };
  }
  if (opts.over.visitor) {
    return { kind: "refused", error: "You've asked for a lot of changes today. Chat still works, and changes are back tomorrow.", detail: `visitor daily budget of $${VISITOR_DAILY_BUDGET_USD} spent` };
  }
  return null;
}

/** How a run ended, as the builder sees it. */
export type Outcome =
  | { kind: "finished"; summary: string; name?: string; ideas?: string[]; spotlight?: string; try?: string }
  | { kind: "declined"; reason: string }
  | { kind: "unchanged" }
  | { kind: "invalid"; problems: string[] }
  | { kind: "stopped"; reason: "time" | "budget" | "error" | "done" | "approval"; error?: string };

/** Clay's next-change ideas as the empty room offers them: short, one line
 *  each, lowercase first letter like a chip, no repeats, at most IDEAS_MAX. */
export function cleanIdeas(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const idea of raw) {
    const s = idea.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
    if (!s || s.length > IDEA_MAX) continue;
    const chip = s[0].toLowerCase() + s.slice(1);
    if (!out.includes(chip)) out.push(chip);
    if (out.length === IDEAS_MAX) break;
  }
  return out;
}

/** A failed outcome as its card says it: one line for people and the raw cause. */
export function failureFor(outcome: Exclude<Outcome, { kind: "finished" }>): Refusal {
  switch (outcome.kind) {
    case "declined":
      return { kind: "declined", error: outcome.reason, detail: `declined: ${outcome.reason}` };
    case "unchanged":
      return { kind: "unchanged", error: "Clay finished without changing anything. Try saying it another way.", detail: "the draft matched the base version" };
    case "invalid":
      return { kind: "invalid", error: "The code Clay wrote didn't run, even after fixing it.", detail: outcome.problems.join("\n") };
    case "stopped":
      if (outcome.reason === "time") return { kind: "time", error: "It ran out of time on a big change. Try a smaller step.", detail: outcome.error ?? "deadline passed" };
      if (outcome.reason === "budget") return { kind: "budget", error: "It hit the spending limit for one change. Try a smaller step.", detail: outcome.error ?? "cost ceiling reached" };
      if (outcome.reason === "done") return { kind: "stopped", error: "Clay stopped before finishing. Try again.", detail: "the model ended its turn without calling finish" };
      return { kind: "unreachable", error: "Clay couldn't reach its model. Try again in a moment.", detail: outcome.error ?? outcome.reason };
  }
}

const clip = (text: string) => clipLine(text, NARRATION_LINE_MAX);

/** The newest line of a streamed message. */
export function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

type Line = NarrationLine & { key?: string; file?: string };

/** The lines a build card narrates, the newest last: Clay's plan (the first
 *  message it writes, which the card keeps as its lede), one line per step,
 *  and what Clay is doing this moment (thinking it through, reading a file),
 *  which stands only until the next line arrives. */
export class Narration {
  private lines: Line[] = [];
  private planned = false;

  /** What Clay is doing right now; it replaces the line before it when that
   *  was a passing one too. */
  now(text: string, at = Date.now()): void {
    const line = clip(text);
    if (!line) return;
    const last = this.lines[this.lines.length - 1];
    if (last?.kind === "now") last.text = line;
    else this.add({ at, text: line, kind: "now" });
  }

  /** Add a step. Repeating the step just before it adds nothing. */
  say(text: string, at = Date.now()): void {
    const line = clip(text);
    if (!line) return;
    this.settle();
    if (this.lines[this.lines.length - 1]?.text !== line) this.add({ at, text: line });
  }

  /** A change to one file. Changes to the file the step before was about
   *  fold into that step, which takes the newer words. */
  change(path: string, text: string, at = Date.now()): void {
    const line = clip(text);
    if (!line) return;
    this.settle();
    const last = this.lines[this.lines.length - 1];
    if (last && !last.kind && last.file === path) last.text = line;
    else this.add({ at, text: line, file: path });
  }

  /** A model message as it streams (by key): the first is the plan, kept
   *  whole on one line; later ones are steps showing their newest line. */
  stream(key: string, text: string, at = Date.now()): void {
    const existing = this.lines.find((l) => l.key === key);
    const plan = existing ? existing.kind === "plan" : !this.planned;
    const line = clip(plan ? text : lastLine(text));
    if (!line) return;
    if (existing) {
      existing.text = line;
      return;
    }
    this.settle();
    this.planned ||= plan;
    this.add({ at, text: line, key, ...(plan ? { kind: "plan" as const } : {}) });
  }

  /** The latest lines, the plan always among them. */
  view(): NarrationLine[] {
    const shown = this.lines.slice(-NARRATION_LINES_MAX);
    const plan = this.lines.find((l) => l.kind === "plan");
    if (plan && !shown.includes(plan)) shown.splice(0, 1, plan);
    return shown.map(({ at, text, kind }) => ({ at, text, ...(kind ? { kind } : {}) }));
  }

  /** Lines are told apart by `at`, so no two share one. */
  private add(line: Line): void {
    const last = this.lines[this.lines.length - 1];
    this.lines.push({ ...line, at: last && line.at <= last.at ? last.at + 1 : line.at });
  }

  /** A passing line gives way to whatever comes next. */
  private settle(): void {
    if (this.lines[this.lines.length - 1]?.kind === "now") this.lines.pop();
  }
}

/** The narration line for a file change: the agent's words when it gave
 *  them, else the verb and the file's name. The path itself is the card's
 *  file chip, never part of the line. */
export function stepLine(verb: string, path: string, about?: string): string {
  const why = about?.trim().replace(/[.\s]+$/, "");
  return why ? `${why[0].toUpperCase()}${why.slice(1)}` : `${verb} ${fileName(path)}`;
}

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const POLITE = /^(?:(?:hey|hi|ok|okay|so|clay|please|pls|(?:can|could|would|will)(?: you)?|i(?:'d| would)? like(?: you)? to|i want(?: you)? to|let's)\b[\s,.!:]*)+/i;
const GERUNDS: Record<string, string> = {
  add: "adding", allow: "allowing", build: "building", change: "changing", create: "creating", draw: "drawing", fix: "fixing",
  give: "giving", hide: "hiding", keep: "keeping", let: "letting", make: "making", move: "moving", put: "putting",
  remove: "removing", rename: "renaming", replace: "replacing", set: "setting", show: "showing", swap: "swapping",
  turn: "turning", use: "using",
};
const OPENING_WORDS = 6;

/** The line a build opens with, before Clay has said anything: what it is
 *  thinking about, in the asker's words ("make the bass frog wobble when
 *  anyone croaks" reads "Thinking about making the bass frog wobble when…"). */
export function openingLine(request: string): string {
  const said = oneLine(request).replace(POLITE, "").split(/[.:;!?](?:\s|$)| - /)[0].trim();
  const words = said.split(" ").filter(Boolean);
  if (!words.length) return "Thinking it through";
  const verb = GERUNDS[words[0].toLowerCase()];
  if (verb) words[0] = verb;
  else if (/^[A-Z][a-z]*$/.test(words[0]) && words[0] !== "I") words[0] = words[0].toLowerCase();
  const cut = words.length > OPENING_WORDS;
  return `Thinking about ${words.slice(0, OPENING_WORDS).join(" ").replace(/[,\s]+$/, "")}${cut ? "…" : ""}`;
}

/** A thinking summary as one passing line: its latest heading when it has
 *  them, else its latest finished sentence, without the markdown. Empty
 *  until a sentence is finished, so the card never shows half a thought. */
export function thinkingLine(summary: string): string {
  const headings = [...summary.matchAll(/\*\*(.+?)\*\*/g)];
  if (headings.length) return plain(headings[headings.length - 1][1]);
  const sentences = oneLine(summary).split(/(?<=[.!?])\s+/);
  const done = /[.!?]$/.test(sentences[sentences.length - 1]) ? sentences : sentences.slice(0, -1);
  return plain(done[done.length - 1] ?? "");
}

const plain = (text: string) => text.replace(/[*_`#>]+/g, "").replace(/^[-\s]+/, "").trim();

/** Runs `write` at most once per `everyMs`: the first poke writes at once,
 *  pokes inside the window fold into one trailing write, and `flush` waits
 *  for everything poked so far to be written. Writes never overlap. */
export class Throttle {
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: () => Promise<void>,
    private readonly everyMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  poke(): void {
    if (this.timer) return;
    const wait = this.last + this.everyMs - this.now();
    if (wait <= 0) this.run();
    else this.timer = setTimeout(() => this.run(), wait);
  }

  async flush(): Promise<void> {
    if (this.timer) this.run();
    await this.chain;
  }

  private run(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.last = this.now();
    this.chain = this.chain.then(this.write).catch(() => {});
  }
}
