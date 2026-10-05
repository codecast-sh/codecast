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
import { everyWords } from "./orgProposal";

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

export type RolePlaybook = {
  /** The number the area is read by, in the role's words, and its readings oldest first. */
  metric: { name: string; readings: MetricReading[] } | null;
  rules: PlaybookRule[];
  refuted: PlaybookEntry[];
  decisions: PlaybookDecision[];
  threads: PlaybookThread[];
};

export type PlaybookSectionKey = "metric" | "rules" | "refuted" | "decisions" | "threads";

/** The sections, in the order a brief holds them, each with the shape of a
 *  line as `cast brief` prints it for a role that has not written one yet.
 *  The shapes are placeholders, never content. */
export const PLAYBOOK_SECTIONS: ReadonlyArray<{ key: PlaybookSectionKey; title: string; heading: RegExp; shape: string }> = [
  { key: "metric", title: "North metric", heading: /^#{1,6}\s*North metric\s*$/i, shape: "a first line naming the one number your area is read by, then `- <YYYY-MM-DD>: <reading>` per reading (write `milestone` in the ones worth keeping; keep those and the recent ones)" },
  { key: "rules", title: "Rules learned", heading: /^#{1,6}\s*Rules learned\s*$/i, shape: "`- <the rule>. Learned from: <the mistake that taught it>. (<YYYY-MM-DD>)`" },
  { key: "refuted", title: "Refuted", heading: /^#{1,6}\s*Refuted\b.*$/i, shape: "`- <what turned out false, and what showed it> (<YYYY-MM-DD>)`" },
  { key: "decisions", title: "Standing decisions", heading: /^#{1,6}\s*Standing decisions\s*$/i, shape: "`- <what was decided> (<who decided>, <YYYY-MM-DD>)`" },
  { key: "threads", title: "Open threads", heading: /^#{1,6}\s*Open threads\s*$/i, shape: "`- <what is open and what it waits for> (opened <YYYY-MM-DD>, due <YYYY-MM-DD>)`" },
];
const headingOf = (key: PlaybookSectionKey) => PLAYBOOK_SECTIONS.find((s) => s.key === key)!.heading;

const dated = (text: string, on: string | null): Pick<PlaybookEntry, "text" | "written_on" | "written_at"> => ({ text: text.trim(), written_on: on && dayAt(on) !== null ? on : null, written_at: on ? dayAt(on) : null });

/** A line with a date at its end, in parentheses or bare. */
function entryOf(raw: string): PlaybookEntry {
  const m = raw.match(TRAILING_DATE);
  return m && dayAt(m[1]) !== null ? { ...dated(raw.slice(0, m.index), m[1]), raw } : { ...dated(raw, null), raw };
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

const WHO_AND_DAY = new RegExp(`\\s*\\(([^()]*?)[,;]?\\s*(${DAY})\\)\\s*$`);
function decisionOf(raw: string): PlaybookDecision {
  const m = raw.match(WHO_AND_DAY);
  if (!m || dayAt(m[2]) === null) return { ...entryOf(raw), who: null };
  return { ...dated(raw.slice(0, m.index), m[2]), raw, who: m[1].trim() || null };
}

const CLOSING_PARENS = /\s*\(([^()]*)\)\s*$/;
const DUE = new RegExp(`\\bdue\\s+(?:on\\s+|by\\s+)?(${DAY})`, "i");
const OPENED = new RegExp(`\\b(?:opened|since)\\s+(?:on\\s+)?(${DAY})`, "i");
function threadOf(raw: string): PlaybookThread {
  const tail = raw.match(CLOSING_PARENS);
  const marks = tail && new RegExp(DAY).test(tail[1]) ? tail[1] : null;
  const due = (marks ?? raw).match(DUE)?.[1] ?? null;
  const opened = marks ? marks.match(OPENED)?.[1] ?? marks.replace(DUE, "").match(new RegExp(DAY))?.[0] ?? null : null;
  const e = marks ? { ...dated(raw.slice(0, tail!.index), opened), raw } : entryOf(raw);
  return { ...e, due_on: due && dayAt(due) !== null ? due : null, due_at: due ? dayAt(due) : null };
}

const items = (narrative: string | null | undefined, key: PlaybookSectionKey): string[] => sectionRows(narrative, headingOf(key)).flatMap((l) => listItem(l) ?? []);

/** The playbook a brief holds. A section the role left out reads as empty. */
export function parsePlaybook(narrative: string | null | undefined): RolePlaybook {
  const metricRows = sectionRows(narrative, headingOf("metric"));
  const name = metricRows.filter((l) => l.trim() && listItem(l) === null).map((l) => l.trim()).join(" ");
  const readings = metricRows.flatMap((l) => listItem(l) ?? []).map(readingOf).sort((a, b) => (a.written_at ?? 0) - (b.written_at ?? 0));
  return {
    metric: name || readings.length ? { name, readings } : null,
    rules: items(narrative, "rules").map(ruleOf),
    refuted: items(narrative, "refuted").map(entryOf),
    decisions: items(narrative, "decisions").map(decisionOf),
    threads: items(narrative, "threads").map(threadOf),
  };
}

/** How many entries each section holds; a section the brief lacks is 0. */
export function playbookCounts(p: RolePlaybook): Record<PlaybookSectionKey, number> {
  return { metric: p.metric ? Math.max(1, p.metric.readings.length) : 0, rules: p.rules.length, refuted: p.refuted.length, decisions: p.decisions.length, threads: p.threads.length };
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
