// A role's playbook (docs/architecture/org-staffing.md S38): what the role has
// learned that its next run would otherwise learn again, kept by the role in
// its brief beside "Where it stands" (briefStanding.ts), one dated line per
// entry:
//
//   ## North metric
//   Introductions sent per day, seven day average.
//   - 2026-09-11: 4.4/day (milestone: first week above 4)
//   - 2026-10-04: 3.7/day
//
//   ## Rules learned
//   - Read the threads before the counters. Learned from: three diagnoses made from totals were wrong. (2026-09-12)
//
//   ## Experiments
//   - 2026-10-20: Shorter first email for intro rate, because long ones read as templates; expect 0.12% to 0.16%, read 2026-10-27. Result: kept, 0.15%.
//
//   ## Refuted
//   - The reply rate fell because the audience changed: the mix of replies by week is flat. (2026-09-06)
//
//   ## Standing decisions
//   - Never deploy past a red gate. (Mara, 2026-09-05)
//
//   ## Open threads
//   - The pricing page waits on legal. (opened 2026-09-21, due 2026-10-21)
//
// How the role wakes (cadence, precheck, focus, and why it last changed) is
// not written here: it lives on the role's routine and is read from it
// (RoleWake below), so the playbook cannot drift from the trigger.
//
// One parser for `cast brief`, the role page, the eval gates and the template
// learning pass, so every reader sees the same entries.

import { TRAILING_DATE, dayAt, listItem, sectionRows } from "./briefStanding";

const DAY = "\\d{4}-\\d{2}-\\d{2}";

export type PlaybookEntry = {
  /** The entry without its date and without what its section reads off it. */
  text: string;
  /** The day the role wrote it, as written, and as a timestamp (UTC midnight). */
  written_on: string | null;
  written_at: number | null;
  /** The line as written, without the bullet. */
  raw: string;
};
/** One reading of the metric. `number` is the first number in it, for a trend line. */
export type MetricReading = PlaybookEntry & { number: number | null; milestone: boolean };
export type PlaybookRule = PlaybookEntry & { mistake: string | null };
export type PlaybookDecision = PlaybookEntry & { who: string | null };
export type PlaybookThread = PlaybookEntry & { due_on: string | null; due_at: number | null };
/** One try at moving a number: the day it reads its result, and the outcome once it has one. */
export type PlaybookExperiment = PlaybookEntry & { read_on: string | null; read_at: number | null; outcome: "kept" | "reverted" | null };

export type RolePlaybook = {
  /** The number the area is read by, in the role's words, and its readings oldest first. */
  metric: { name: string; readings: MetricReading[] } | null;
  rules: PlaybookRule[];
  experiments: PlaybookExperiment[];
  refuted: PlaybookEntry[];
  decisions: PlaybookDecision[];
  threads: PlaybookThread[];
};

export type PlaybookSectionKey = "metric" | "rules" | "experiments" | "refuted" | "decisions" | "threads";

/** The sections, in the order a brief holds them, each with the shape of a
 *  line as `cast brief` prints it for a role that has not written one yet.
 *  The shapes are placeholders, never content. */
export const PLAYBOOK_SECTIONS: ReadonlyArray<{ key: PlaybookSectionKey; title: string; heading: RegExp; shape: string }> = [
  { key: "metric", title: "North metric", heading: /^#{1,6}\s*North metric\b.*$/i, shape: "a first line naming the one number your area is read by and where you read it, then `- <YYYY-MM-DD>: <reading>` per reading; take a fresh one from that source when you check (write `milestone` in the ones worth keeping; keep those and the recent ones). When it is a goal's or project's live number, name it (`in-N`, `mw-N`): its value and trend are read for you above, so write only the milestones" },
  { key: "rules", title: "Rules learned", heading: /^#{1,6}\s*Rules learned\b.*$/i, shape: "only what a mistake taught you: `- <the rule>. Learned from: <the mistake that taught it>. (<YYYY-MM-DD>)`" },
  { key: "experiments", title: "Experiments", heading: /^#{1,6}\s*Experiments\b.*$/i, shape: "one try at moving a number: `- <YYYY-MM-DD>: <the change> for <which number>, because <the reason>; expect <the effect>, read <YYYY-MM-DD>. Result: <kept or reverted>, <what the number did>` (add the result on its read day; move a refuted idea to Refuted)" },
  { key: "refuted", title: "Refuted", heading: /^#{1,6}\s*Refuted\b.*$/i, shape: "`- <what turned out false, and what showed it> (<YYYY-MM-DD>)`" },
  { key: "decisions", title: "Standing decisions", heading: /^#{1,6}\s*Standing decisions\b.*$/i, shape: "what a person decided that still binds your work: `- <what was decided> (<who decided>, <YYYY-MM-DD>)`" },
  { key: "threads", title: "Open threads", heading: /^#{1,6}\s*Open threads\b.*$/i, shape: "work that waits on someone or something: `- <what is open and what it waits for> (opened <YYYY-MM-DD>, due <YYYY-MM-DD> when it has a day)`" },
];
const headingOf = (key: PlaybookSectionKey) => PLAYBOOK_SECTIONS.find((s) => s.key === key)!.heading;

const dated = (text: string, on: string | null): Pick<PlaybookEntry, "text" | "written_on" | "written_at"> => ({ text: text.trim(), written_on: on && dayAt(on) !== null ? on : null, written_at: on ? dayAt(on) : null });

// Roles write an entry's date the way a person would: bare at the end, alone
// in parentheses, or among other words in the closing parentheses ("(Mara,
// 2026-10-05, sd-55)"), with or without a full stop after it. All of those
// read; what else the parentheses hold stays with the entry.
const A_DAY = new RegExp(DAY, "g");
const CLOSING_PARENS = /\s*\(([^()]*)\)\s*$/;
const unstopped = (raw: string) => raw.replace(/[.\s]+$/, "");
const tidy = (words: string) => words.replace(/\s*,\s*(?=,|$)/g, "").replace(/^[\s,;]+|[\s,;]+$/g, "").replace(/\s{2,}/g, " ");

/** The closing parentheses of a line when they hold a day: the days in them, and their other words. */
function closingMarks(line: string): { before: string; days: string[]; words: string } | null {
  const m = unstopped(line).match(CLOSING_PARENS);
  const days = m ? (m[1].match(A_DAY) ?? []).filter((d) => dayAt(d) !== null) : [];
  return m && days.length ? { before: unstopped(line).slice(0, m.index), days, words: tidy(m[1].replace(A_DAY, "")) } : null;
}

/** A line with its date: at the end, or anywhere in its closing parentheses. */
function entryOf(raw: string): PlaybookEntry {
  const line = unstopped(raw);
  const end = line.match(TRAILING_DATE);
  if (end && dayAt(end[1]) !== null && !/\([^()]*$/.test(line.slice(0, end.index).replace(/\($/, ""))) return { ...dated(line.slice(0, end.index), end[1]), raw };
  const marks = closingMarks(raw);
  if (marks) return { ...dated(marks.words ? `${marks.before} (${marks.words})` : marks.before, marks.days[0]), raw };
  return { ...dated(raw, null), raw };
}

const LEADING_DATE = new RegExp(`^(${DAY})\\s*[:,]?\\s*(.+)$`);
const firstNumber = (text: string): number | null => {
  const m = text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};
function readingOf(raw: string): MetricReading {
  const lead = raw.match(LEADING_DATE);
  const e = lead && dayAt(lead[1]) !== null ? { ...dated(lead[2], lead[1]), raw } : entryOf(raw);
  return { ...e, number: firstNumber(e.text), milestone: /\bmilestone\b/i.test(e.text) };
}

const LEARNED_FROM = /\s*\bLearned from:\s*/i;
function ruleOf(raw: string): PlaybookRule {
  const e = entryOf(raw);
  const at = e.text.search(LEARNED_FROM);
  if (at < 0) return { ...e, mistake: null };
  const mistake = e.text.slice(at).replace(LEARNED_FROM, "").replace(/\.$/, "").trim();
  return { ...e, text: e.text.slice(0, at).trim(), mistake: mistake || null };
}

/** Who decided is what the closing parentheses hold beside the day: "(Mara, 2026-09-05)", "(Mara, sd-55, 2026-10-05)". */
function decisionOf(raw: string): PlaybookDecision {
  const marks = closingMarks(raw);
  if (!marks) return { ...entryOf(raw), who: null };
  return { ...dated(marks.before, marks.days[0]), raw, who: marks.words || null };
}

const DUE = new RegExp(`\\bdue\\s+(?:on\\s+|by\\s+)?(${DAY})`, "i");
const OPENED = new RegExp(`\\b(?:opened|since)\\s+(?:on\\s+)?(${DAY})`, "i");
function threadOf(raw: string): PlaybookThread {
  const marks = closingMarks(raw);
  const tail = marks ? unstopped(raw).match(CLOSING_PARENS)![1] : null;
  const due = (tail ?? raw).match(DUE)?.[1] ?? null;
  const opened = tail ? tail.match(OPENED)?.[1] ?? tail.replace(DUE, "").match(new RegExp(DAY))?.[0] ?? null : null;
  const e = marks ? { ...dated(marks.before, opened), raw } : entryOf(raw);
  return { ...e, due_on: due && dayAt(due) !== null ? due : null, due_at: due ? dayAt(due) : null };
}

const READ_ON = new RegExp(`\\bread(?:\\s+on|\\s+by)?\\s+(${DAY})`, "i");
function experimentOf(raw: string): PlaybookExperiment {
  const lead = raw.match(LEADING_DATE);
  const e = lead && dayAt(lead[1]) !== null ? { ...dated(lead[2], lead[1]), raw } : entryOf(raw);
  const read = raw.match(READ_ON)?.[1] ?? null;
  const result = raw.match(/\bResult:\s*(kept|reverted)\b/i)?.[1]?.toLowerCase() as "kept" | "reverted" | undefined;
  return { ...e, read_on: read && dayAt(read) !== null ? read : null, read_at: read ? dayAt(read) : null, outcome: result ?? null };
}
/** An experiment past its read day with no result written yet. */
export const experimentDue = (x: PlaybookExperiment, now: number): boolean => x.outcome === null && x.read_at !== null && now >= x.read_at;

const items = (narrative: string | null | undefined, key: PlaybookSectionKey): string[] => sectionRows(narrative, headingOf(key)).flatMap((l) => listItem(l) ?? []);

/** The playbook a brief holds. A section the role left out reads as empty. */
export function parsePlaybook(narrative: string | null | undefined): RolePlaybook {
  const metricRows = sectionRows(narrative, headingOf("metric"));
  // The metric is named by the lines above its readings, or in the heading itself ("## North metric: stale pages").
  const inHeading = (narrative ?? "").split("\n").find((l) => headingOf("metric").test(l))?.replace(/^#{1,6}\s*North metric\s*[:,]?\s*/i, "").trim() ?? "";
  const name = [inHeading, ...metricRows.filter((l) => l.trim() && listItem(l) === null).map((l) => l.trim())].filter(Boolean).join(" ");
  const readings = metricRows.flatMap((l) => listItem(l) ?? []).map(readingOf).sort((a, b) => (a.written_at ?? 0) - (b.written_at ?? 0));
  return {
    metric: name || readings.length ? { name, readings } : null,
    rules: items(narrative, "rules").map(ruleOf),
    experiments: items(narrative, "experiments").map(experimentOf),
    refuted: items(narrative, "refuted").map(entryOf),
    decisions: items(narrative, "decisions").map(decisionOf),
    threads: items(narrative, "threads").map(threadOf),
  };
}

/** How many entries each section holds; a section the brief lacks is 0. */
export function playbookCounts(p: RolePlaybook): Record<PlaybookSectionKey, number> {
  return { metric: p.metric ? Math.max(1, p.metric.readings.length) : 0, rules: p.rules.length, experiments: p.experiments.length, refuted: p.refuted.length, decisions: p.decisions.length, threads: p.threads.length };
}

export const playbookIsEmpty = (p: RolePlaybook): boolean => Object.values(playbookCounts(p)).every((n) => n === 0);

/** True when an open thread's due day has passed. */
export const threadOverdue = (t: PlaybookThread, now: number): boolean => t.due_at !== null && now >= t.due_at + 86_400_000;

// ── The budget ───────────────────────────────────────────────────────────────

/** The whole brief, playbook included: about 3,000 tokens a wake. */
export const BRIEF_BUDGET_CHARS = 12_000;
const BUDGET_NEAR = 0.75;

export type BriefBudget = { chars: number; budget: number; over: boolean; near: boolean };
export function briefBudget(narrative: string | null | undefined): BriefBudget {
  const chars = (narrative ?? "").trim().length;
  return { chars, budget: BRIEF_BUDGET_CHARS, over: chars > BRIEF_BUDGET_CHARS, near: chars > BRIEF_BUDGET_CHARS * BUDGET_NEAR };
}
const kb = (chars: number) => `${(chars / 1000).toFixed(1)} KB`;
export const briefBudgetWords = (b: BriefBudget): string => `${kb(b.chars)} of ${kb(b.budget)}`;
/** What a role is told when its save is over the budget (orgRoles.performBriefEdit). */
export const briefOverBudgetMessage = (b: BriefBudget): string =>
  `The brief is ${briefBudgetWords(b)}: over its budget, so it was not saved. You read it at every wake, so condense it and save again: merge entries that say one thing, drop what is closed or no longer true, and thin old metric readings down to the milestones. An entry you keep keeps its shape and its date.`;

/** `cast brief`'s lines about the playbook: the shape of an entry in each
 *  section, so the format has one home and a condensed brief still parses,
 *  and how full the brief is once that matters. */
export function playbookGuideLines(narrative: string | null | undefined): string[] {
  const budget = briefBudget(narrative);
  return [
    `your playbook: what you have learned that your next run should not have to learn again, kept by you in this brief. A section is a list under its heading, one entry a line, and every entry keeps its date; leave out a section you have nothing for.`,
    ...PLAYBOOK_SECTIONS.map((s) => `  ## ${s.title}: ${s.shape}`),
    ...(budget.near ? [`brief: ${briefBudgetWords(budget)}${budget.over ? ", over its budget" : ""}. You read all of it at every wake: condense it before you add to it, and keep the shapes above when you do.`] : []),
  ];
}

// ── How the role wakes ───────────────────────────────────────────────────────

/** What a role may change about its own check without a proposal. */
export const WAKE_TUNE = { min_ms: 3_600_000, max_ms: 7 * 86_400_000, focus_chars: 600, precheck_chars: 500, why_chars: 300 } as const;

/** The role's check as it runs, read off its trigger. */
export type RoleWake = { every_ms: number | null; precheck: string | null; focus: string | null; why: string | null; tuned_at: number | null };

/** The wake of a routine, off the trigger row that holds it. */
export const roleWakeOf = (t: { interval_ms?: number | null; precheck?: string | null; role_focus?: string | null; tune_why?: string | null; tuned_at?: number | null }): RoleWake =>
  ({ every_ms: t.interval_ms ?? null, precheck: t.precheck ?? null, focus: t.role_focus ?? null, why: t.tune_why ?? null, tuned_at: t.tuned_at ?? null });

/** What a role is told it may change, beside its wake, in `cast brief`. */
export const WAKE_TUNE_HINT = `yours to change when the pace of the work changes: cast role tune --every <${msToEvery(WAKE_TUNE.min_ms)} to ${msToEvery(WAKE_TUNE.max_ms)}> --precheck "<command>" --focus "<text>" --why "<reason>"`;

/** "1d" reads as every day, "7d" as every week, "12h" as every 12 hours. */
export function everyWords(every: string): string {
  const m = every.trim().match(/^(\d+)\s*([dhwm])$/i);
  if (!m) return `every ${every}`;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "d" && n === 1) return "every day";
  if (unit === "d" && n === 7) return "every week";
  if (unit === "w" && n === 1) return "every week";
  const word = { d: "day", h: "hour", w: "week", m: "minute" }[unit as "d" | "h" | "w" | "m"];
  return n === 1 ? `every ${word}` : `every ${n} ${word}s`;
}

/** An interval as a cadence word ("12h", "1d", "90m"): the inverse of orgEveryToMs. */
export function msToEvery(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000]] as const) if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** Why a cadence is not the role's to set, or null when it is. */
export function wakeTuneRefusal(everyMs: number): string | null {
  if (everyMs >= WAKE_TUNE.min_ms && everyMs <= WAKE_TUNE.max_ms) return null;
  return `A role sets its own check between ${msToEvery(WAKE_TUNE.min_ms)} and ${msToEvery(WAKE_TUNE.max_ms)}; ${msToEvery(everyMs)} is outside that. Propose it to the person you report to as a routine change (\`cast org propose\`, kind "routine") with the reason.`;
}

/** The wake in one line: the cadence, the gate, the focus, and why it last changed. */
export function wakeWords(w: RoleWake): string {
  const day = w.tuned_at ? new Date(w.tuned_at).toISOString().slice(0, 10) : null;
  return [
    w.every_ms ? everyWords(msToEvery(w.every_ms)) : "on no schedule",
    w.precheck ? `only when \`${w.precheck}\` passes` : null,
    w.focus ? `focus: ${w.focus}` : null,
    w.why ? `changed${day ? ` ${day}` : ""}: ${w.why}` : null,
  ].filter(Boolean).join(" · ");
}

/** The focus as the wake frame carries it, after the routine's own prompt. */
export const roleFocusBlock = (focus: string | null | undefined): string | null =>
  focus?.trim() ? `Your focus for this check, which you set yourself (\`cast role tune --focus\` changes it): ${focus.trim()}` : null;

// ── Moving a number ──────────────────────────────────────────────────────────

// How a role moves a number (docs/architecture/initiatives-projects-role-page.md
// I4): the guidance `cast brief` carries when the role's area is read by any
// number, a goal's or a project's. Principles, not a script, drawn from what
// long-running optimisation loops and experimentation practice found works:
// read the number whole before acting, change one thing against a stated
// prediction, judge it after a window fixed in advance, keep or revert, write
// down what was learned, and never move the number by moving the measurement.
//
// One text for every reader of a brief (the CLI, the eval worlds), so a role
// reads the same guidance wherever its brief is printed.

export const METRIC_CLIMB_GUIDANCE: readonly string[] = [
  "Your area is read by the numbers above, and moving them toward their targets is the point of your work. Each one stands for a real outcome (people helped, money made, trust kept), so a gain that does not move that outcome is not a gain.",
  "Read a number whole before you act on it: its value against the target, which way the last week moved, and the pace the date needs. A single point inside its usual range is noise; act on a run of points or a clear break from that range, and expect a bad week to recover partly on its own.",
  "Work on the stage that limits the result. In a funnel that is the step converting worst against what it should; more volume into a leaking step, or a fix to a step that is not the constraint, moves nothing.",
  "Change one thing at a time, the smallest change that tests a reason you can name. Before it runs, write the effect you expect and the day you will read it; read it then, not when it looks good, and allow at least a week where the number swings by weekday. Keep what beat the baseline, revert what did not, and drop a gain too small to tell from noise when it adds complexity.",
  "Log each try under `## Experiments` in your brief: the change, the reason, the prediction, the read day and the result. Move a refuted idea to `## Refuted` with what showed it, so no later run tries it again.",
  "A number marked as a guardrail must not get worse while you move the others; a win that costs a guardrail is a loss. Never change how a number is counted, filtered or reported, and say so when the only path to a target you can see is one that games it.",
  "Choose the next piece of work by its expected effect on the number, how sure the log makes you, and its cost. When the trend cannot reach the target by its date, small tuning is the wrong bet: propose the larger change to the person you report to. Spending past your budget, anything hard to undo, and anything said in the company's name in a new way go to a person first.",
];

/** The guidance as `cast brief` prints it, under its heading. */
export const metricClimbLines = (): string[] => ["## Moving your numbers", ...METRIC_CLIMB_GUIDANCE.map((p) => `- ${p}`)];
