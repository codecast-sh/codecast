// The builder's decisions that need no database: which build runs next, what
// the budgets allow, how a failure reads to people, and the narration a card
// shows. queue.ts and run.ts apply them.
import { APP_DAILY_BUDGET_USD, GLOBAL_DAILY_BUDGET_USD, NARRATION_LINE_MAX, NARRATION_LINES_MAX } from "../lib/limits";

export type QueueRow<Id> = { _id: Id; status: "queued" | "building" | "live" | "failed"; _creationTime: number };

/** The build to start now: the oldest queued one, unless one is building.
 *  One at a time per app, first in first out. */
export function nextInLine<Id>(rows: readonly QueueRow<Id>[]): Id | null {
  if (rows.some((r) => r.status === "building")) return null;
  const queued = rows.filter((r) => r.status === "queued").sort((a, b) => a._creationTime - b._creationTime);
  return queued[0]?._id ?? null;
}

/** The UTC day a spend counts toward. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Dollars spent on `day`, from a row that may hold an older day. */
export function spentOn(row: { day: string; usd: number } | null | undefined, day: string): number {
  return row && row.day === day ? row.usd : 0;
}

export type Refusal = { error: string; detail: string };

/** Why a build may not start now, or null when it may. */
export function startRefusal(opts: { paused: boolean; appSpent: number; globalSpent: number }): Refusal | null {
  if (opts.paused) return { error: "Building is paused right now. Try again in a little while.", detail: "builds are switched off (PLAYGROUND_BUILDS_OFF)" };
  if (opts.globalSpent >= GLOBAL_DAILY_BUDGET_USD) {
    return { error: "Clayground has used today's building budget. Try again tomorrow.", detail: `global daily budget of $${GLOBAL_DAILY_BUDGET_USD} spent` };
  }
  if (opts.appSpent >= APP_DAILY_BUDGET_USD) {
    return { error: "This app has used today's building budget. Try again tomorrow, or fork it.", detail: `app daily budget of $${APP_DAILY_BUDGET_USD} spent` };
  }
  return null;
}

/** How a run ended, as the builder sees it. */
export type Outcome =
  | { kind: "finished"; summary: string }
  | { kind: "declined"; reason: string }
  | { kind: "unchanged" }
  | { kind: "invalid"; problems: string[] }
  | { kind: "stopped"; reason: "time" | "budget" | "error" | "done" | "approval"; error?: string };

/** A failed outcome as its card says it: one line for people and the raw cause. */
export function failureFor(outcome: Exclude<Outcome, { kind: "finished" }>): Refusal {
  switch (outcome.kind) {
    case "declined":
      return { error: outcome.reason, detail: `declined: ${outcome.reason}` };
    case "unchanged":
      return { error: "Clay finished without changing anything. Try saying it another way.", detail: "the draft matched the base version" };
    case "invalid":
      return { error: "The code Clay wrote didn't run, even after fixing it.", detail: outcome.problems.join("\n") };
    case "stopped":
      if (outcome.reason === "time") return { error: "It ran out of time on a big change. Try a smaller step.", detail: outcome.error ?? "deadline passed" };
      if (outcome.reason === "budget") return { error: "It hit the spending limit for one change. Try a smaller step.", detail: outcome.error ?? "cost ceiling reached" };
      if (outcome.reason === "done") return { error: "Clay stopped before finishing. Try again.", detail: "the model ended its turn without calling finish" };
      return { error: "Clay couldn't reach its model. Try again in a moment.", detail: outcome.error ?? outcome.reason };
  }
}

export type NarrationLine = { at: number; text: string };

function clip(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > NARRATION_LINE_MAX ? `${s.slice(0, NARRATION_LINE_MAX - 1).trimEnd()}…` : s;
}

/** The lines a build card narrates: one per step, the newest last. A streamed
 *  model message keeps one line, rewritten as it grows. */
export class Narration {
  private lines: (NarrationLine & { key?: string })[] = [];

  /** Add a step. Repeating the line just before it adds nothing. */
  say(text: string, at = Date.now()): void {
    const line = clip(text);
    if (!line || this.lines[this.lines.length - 1]?.text === line) return;
    this.lines.push({ at, text: line });
  }

  /** Set the line for a streamed message (by key), adding it the first time. */
  stream(key: string, text: string, at = Date.now()): void {
    const line = clip(text);
    if (!line) return;
    const existing = this.lines.find((l) => l.key === key);
    if (existing) existing.text = line;
    else this.lines.push({ at, text: line, key });
  }

  view(): NarrationLine[] {
    return this.lines.slice(-NARRATION_LINES_MAX).map(({ at, text }) => ({ at, text }));
  }
}

/** The narration line for a file step: the agent's words when it gave them. */
export function stepLine(verb: string, path: string, about?: string): string {
  const why = about?.trim().replace(/[.\s]+$/, "");
  return why ? `${why[0].toUpperCase()}${why.slice(1)} (${path})` : `${verb} ${path}`;
}

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
