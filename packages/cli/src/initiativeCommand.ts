// The pure half of `cast initiative` (initiatives-projects-role-page.md I1):
// reading a status or a health the way a person types one, the lines `ls` and
// `show` print, and the one sentence that says what happened to the owner
// role's scope. The intent record (I5) is here too: every line `show` prints
// of it, and which entry a person means by a number or a few words. The
// network calls and the exits live in index.ts.

import { targetDayOf, targetDayStamp } from "@codecast/shared/time";
import {
  INITIATIVE_HEALTH_LABEL,
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_LABEL,
  INITIATIVE_UPDATE_HEALTHS,
  initiativeStanding,
  intentSourceKey,
  intentSourceLine,
  metricLine,
  metricReadings,
  metricTrends,
  milestoneCounts,
  nextMilestone,
  orderedMilestones,
  parseIntentSource,
  trendWords,
  type InitiativeDecision,
  type InitiativeHealth,
  type InitiativeMilestone,
  type InitiativeQuestion,
  type InitiativeRecordList,
  type InitiativeStatus,
  type InitiativeUpdateHealth,
  type IntentSource,
  type MetricReading,
  type MetricStanding,
  type MetricTrend,
} from "@codecast/shared/contracts/initiative";

type Palette = Record<"green" | "yellow" | "red" | "cyan" | "dim" | "bold" | "reset", string>;

export const INITIATIVE_STATUS_ICONS: Record<InitiativeStatus, string> = {
  proposed: "○",
  planned: "◌",
  active: "◉",
  completed: "●",
  cancelled: "⊘",
};

// "on track", "on-track", "On_Track" and "ontrack" all mean on_track.
const squash = (text: string) => text.trim().toLowerCase().replace(/[\s_-]+/g, "");

function oneOf<T extends string>(values: readonly T[], text: string): T | null {
  return values.find((v) => squash(v) === squash(text)) ?? null;
}

export const parseInitiativeHealth = (text: string): InitiativeUpdateHealth | null => oneOf(INITIATIVE_UPDATE_HEALTHS, text);
export const parseInitiativeStatus = (text: string): InitiativeStatus | null => oneOf(INITIATIVE_STATUSES, text);

const healthColor = (c: Palette, health: InitiativeHealth) =>
  health === "on_track" ? c.green : health === "at_risk" ? c.yellow : health === "off_track" ? c.red : c.dim;

// A moment (an update's `at`) prints as the person's own day. A target day
// prints through the shared pair that stored it (shared/time targetDayOf).
export function dayText(ms?: number): string | undefined {
  if (!ms) return undefined;
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function healthText(c: Palette, health: InitiativeHealth, at?: number): string {
  const when = at ? ` ${c.dim}(${dayText(at)})${c.reset}` : "";
  return `${healthColor(c, health)}${INITIATIVE_HEALTH_LABEL[health]}${c.reset}${when}`;
}

/** A metric's standing against its target, as the one word the page uses. */
export function metricStandingText(c: Palette, standing: MetricStanding): string {
  return standing === "met" ? `${c.green}met${c.reset}` : standing === "behind" ? `${c.yellow}behind${c.reset}` : `${c.dim}unread${c.reset}`;
}

export function progressText(counts?: { total: number; done: number }): string {
  if (!counts?.total) return "no tasks";
  return `${counts.done}/${counts.total} done (${Math.round((counts.done / counts.total) * 100)}%)`;
}

/** One row of `cast initiative ls`. */
export function initiativeLine(c: Palette, row: any): string {
  const facts = [
    INITIATIVE_STATUS_LABEL[row.status as InitiativeStatus] ?? row.status,
    row.owner_label ?? `${c.yellow}no owner${c.reset}${c.dim}`,
    `${row.projects?.length ?? row.project_ids?.length ?? 0} projects`,
    progressText(row.task_counts),
    row.target_date ? `target ${targetDayOf(row.target_date)}` : null,
    row.metrics?.length ? `${c.reset}${metricStandingText(c, initiativeStanding(metricReadings(row)))}${c.dim} against ${row.metrics.length === 1 ? "its target" : "its targets"}` : null,
  ].filter(Boolean);
  const icon = INITIATIVE_STATUS_ICONS[row.status as InitiativeStatus] ?? "?";
  return `  ${icon} ${c.cyan}${row.short_id}${c.reset} ${c.bold}${row.title}${c.reset} ${healthText(c, row.health, row.health_at)} ${c.dim}${facts.join(" | ")}${c.reset}`;
}

/**
 * What happened to the owner role's scope, in one sentence, or null when
 * nothing did. `scope` is performCoverProjects' answer as the write returns it.
 */
export function scopeSentence(owner: string | undefined, scope: any, titleOf: (projectId: string) => string): string | null {
  if (!scope) return null;
  const who = owner ?? "The owner role";
  const names = (ids: string[]) => ids.map(titleOf).join(", ");
  const parts: string[] = [];
  if (scope.added?.length) parts.push(`${who} now has ${names(scope.added)} in its scope.`);
  const reasons: Record<string, string> = {
    not_admin: "only an admin of the role may change its scope",
    human_only: "a scope changes from the role page in the browser, never from a token call",
    outside_parent: "it is outside the scope of the role it reports to",
    whole_workspace: "the role already looks after the whole workspace",
  };
  const byReason = new Map<string, string[]>();
  for (const s of scope.skipped ?? []) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.project_id]);
  for (const [reason, ids] of byReason) {
    if (reason === "whole_workspace") continue; // nothing is missing from a whole workspace
    parts.push(`${names(ids)} was not added to its scope: ${reasons[reason] ?? reason}.`);
  }
  if (scope.took_over) parts.push(scope.took_over);
  return parts.length ? parts.join(" ") : null;
}

// ── The intent record (I5) ───────────────────────────────────────────────────

/** `Title=YYYY-MM-DD` read as a milestone. Null for no title or a day that is not one; any other "=" is part of the title. */
export function parseMilestoneArg(text: string): { title: string; date?: number } | null {
  const dated = text.match(/^([\s\S]*)=\s*(\d{4}-\d{2}-\d{2})\s*$/);
  const title = (dated ? dated[1] : text).trim();
  if (!title) return null;
  if (!dated) return { title };
  const date = targetDayStamp(dated[2]);
  return date === null ? null : { title, date };
}

/** A source as a person types one, or null when it names no address and says no words. */
export function readSourceArg(text: string, extra: Pick<IntentSource, "by" | "at" | "quote"> = {}): IntentSource | null {
  const source = parseIntentSource(text, extra);
  return intentSourceKey(source).endsWith(":") ? null : source;
}

export const RECORD_NOUN: Record<InitiativeRecordList, string> = { milestones: "milestone", questions: "question", decisions: "decision", sources: "source" };

export type RecordEntry = { n: number; key: string; words: string; entry: any };

/**
 * One list of the record in reading order, each entry with the number `show`
 * prints beside it and the key a write names it by: milestones by day
 * (orderedMilestones), the rest as written. A source has no stored key; its
 * address is its key.
 */
export function recordEntries(row: any, list: InitiativeRecordList): RecordEntry[] {
  const entries: any[] = list === "milestones" ? orderedMilestones(row.milestones) : (row[list] ?? []);
  return entries.map((entry, i) => ({
    n: i + 1,
    key: list === "sources" ? intentSourceKey(entry) : entry.key,
    words: list === "milestones" ? entry.title : list === "sources" ? [entry.ref, entry.quote].filter(Boolean).join(" ") : entry.text,
    entry,
  }));
}

/** Which entry a person means: its number in reading order, its key, or its words (all of them, or a part only one entry has). */
export function pickRecordEntry(row: any, list: InitiativeRecordList, pick: string): RecordEntry | { error: string } {
  const entries = recordEntries(row, list);
  const noun = RECORD_NOUN[list];
  const on = row.short_id ?? "this goal";
  const t = pick.trim();
  if (!entries.length) return { error: `${on} has no ${list} yet` };
  if (/^\d+$/.test(t)) return entries[Number(t) - 1] ?? { error: `No ${noun} ${t} on ${on}: it has ${entries.length}` };
  const low = t.toLowerCase();
  const exact = entries.filter((e) => e.key === t || e.words.toLowerCase() === low);
  const found = exact.length ? exact : entries.filter((e) => e.words.toLowerCase().includes(low));
  if (found.length === 1) return found[0];
  if (!found.length) return { error: `No ${noun} on ${on} matches "${t}"` };
  return { error: `"${t}" matches ${found.length} ${list} on ${on}; name one by its number: ${found.map((e) => `${e.n}. ${e.words}`).join(" | ")}` };
}

/** One metric as `show` and `report` print it: now against its target, the standing and the date, then which way it is moving. */
export function metricRecordLine(c: Palette, m: MetricReading, trend?: MetricTrend, now = Date.now()): string {
  const moving = trend ? trendWords(trend) : "";
  return `${metricStandingText(c, m.standing)} ${metricLine(m, now)}${moving ? ` ${c.dim}· ${moving}${c.reset}` : ""}`;
}

// Who said it, when and where, as the dim tail of a question or a decision.
function saidTail(c: Palette, e: { by?: string; at?: number; source?: IntentSource }, now: number): string {
  const facts = [e.by, dayText(e.at), e.source ? intentSourceLine(e.source, now) : undefined].filter(Boolean);
  return facts.length ? ` ${c.dim}· ${facts.join(" · ")}${c.reset}` : "";
}

/** A milestone: reached or not, its number, the day it is due (said when that day has passed) and the day it was reached. */
export function milestoneLine(c: Palette, m: InitiativeMilestone, n: number, now = Date.now()): string {
  const due = m.date ? `by ${targetDayOf(m.date)}${!m.done_at && m.date < now ? `${c.reset} ${c.yellow}overdue${c.reset}${c.dim}` : ""}` : undefined;
  const facts = [due, m.done_at ? `reached ${dayText(m.done_at)}` : undefined, m.source ? intentSourceLine(m.source, now) : undefined].filter(Boolean);
  return `  ${m.done_at ? `${c.green}✓${c.reset}` : "○"} ${n}. ${m.title}${facts.length ? ` ${c.dim}· ${facts.join(" · ")}${c.reset}` : ""}`;
}

/** "Next milestone: Private beta open by 2026-11-01 (1 of 3 reached)", or that every one is reached. Null with no milestones. */
export function nextMilestoneLine(row: any): string | null {
  const { done, total } = milestoneCounts(row);
  if (!total) return null;
  const next = nextMilestone(row);
  if (!next) return `Every milestone reached (${done} of ${total})`;
  return `Next milestone: ${next.title}${next.date ? ` by ${targetDayOf(next.date)}` : ""} (${done} of ${total} reached)`;
}

/** A question, and under it the answer that closed it. */
export function questionLines(c: Palette, q: InitiativeQuestion, n: number, now = Date.now()): string[] {
  const asked = `  ${n}. ${q.text}${saidTail(c, q, now)}`;
  if (!q.answer) return [asked];
  return [asked, `     ${c.green}answer${c.reset} ${q.answer}${q.answered_at ? ` ${c.dim}(${dayText(q.answered_at)})${c.reset}` : ""}`];
}

export const decisionLine = (c: Palette, d: InitiativeDecision, n: number, now = Date.now()): string => `  ${n}. ${d.text}${saidTail(c, d, now)}`;

export const sourceLine = (s: IntentSource, n: number, now = Date.now()): string => `  ${n}. ${intentSourceLine(s, now)}`;

/** One entry of any list, as `show` prints it. */
export function recordEntryLines(c: Palette, list: InitiativeRecordList, e: RecordEntry, now = Date.now()): string[] {
  if (list === "milestones") return [milestoneLine(c, e.entry, e.n, now)];
  if (list === "questions") return questionLines(c, e.entry, e.n, now);
  return [list === "decisions" ? decisionLine(c, e.entry, e.n, now) : sourceLine(e.entry, e.n, now)];
}

/**
 * What a record write answered: the verb and the goal, the entry as it now
 * stands on the row (nothing after a remove), and for a milestone where the
 * goal stands on its way.
 */
export function recordWriteLines(c: Palette, verb: string, result: any, list: InitiativeRecordList, now = Date.now()): string[] {
  const row = result.row ?? {};
  const key = result.entry ? (list === "sources" ? intentSourceKey(result.entry) : result.entry.key) : undefined;
  const stands = recordEntries(row, list).find((e) => e.key === key);
  const next = list === "milestones" ? nextMilestoneLine(row) : null;
  return [
    `${c.green}ok${c.reset} ${verb} ${c.cyan}${result.short_id}${c.reset}: ${row.title ?? ""}`,
    ...(stands ? recordEntryLines(c, list, stands, now) : []),
    ...(next ? [`  ${c.dim}${next}${c.reset}`] : []),
  ];
}

const indented = (text: string, by = "  "): string[] => text.split("\n").map((l) => `${by}${l}`);

/**
 * `cast initiative show`: the whole goal in the order a person asks about it
 * (I5, the test). What it is, why it matters, what done looks like, who
 * drives it, the numbers against their targets and which way they move, the
 * next milestone and every milestone, what is undecided, what was decided,
 * who said so and where; then the work that carries it and how it is going.
 * `ago` words an update's age and `projectIcons` a project's status: both are
 * the caller's, which prints every other command with them.
 */
export function initiativeShowLines(c: Palette, row: any, opts: { now?: number; ago: (at: number) => string; projectIcons?: Record<string, string> }): string[] {
  const now = opts.now ?? Date.now();
  const icon = (status: string) => INITIATIVE_STATUS_ICONS[status as InitiativeStatus] ?? "?";
  const head = (title: string, note = "") => `\n  ${c.bold}${title}${c.reset}${note ? ` ${c.dim}${note}${c.reset}` : ""}`;
  const hint = (text: string) => `  ${c.dim}${text}${c.reset}`;
  const out: string[] = [`\n  ${icon(row.status)} ${c.bold}${row.title}${c.reset}  ${c.cyan}${row.short_id}${c.reset}`];

  const facts = [row.status, `health ${healthText(c, row.health, row.health_at)}${c.dim}`];
  if (row.priority) facts.push(row.priority);
  if (row.target_date) facts.push(`target ${targetDayOf(row.target_date)}`);
  if (row.parent) facts.push(`under ${c.cyan}${row.parent.short_id}${c.reset}${c.dim} ${row.parent.title}`);
  out.push(`  ${c.dim}${facts.join(" | ")}${c.reset}`);
  if (row.labels?.length) out.push(hint(`Labels: ${row.labels.join(", ")}`));
  if (row.description) out.push("", ...indented(row.description));

  if (row.why) out.push(head("Why"), ...indented(row.why));
  if (row.done_when) out.push(head("Done when"), ...indented(row.done_when));
  out.push(`${head("Owner")} ${row.owner_label ?? `${c.yellow}none${c.reset}`}`);

  const readings = metricReadings(row);
  if (readings.length) {
    const trends = metricTrends(row);
    out.push(head("Metrics", "on track means against the target"));
    for (const m of readings) out.push(`  ${metricRecordLine(c, m, trends[m.key], now)} ${c.dim}· ${m.key}${m.source ? ` · ${m.source}` : ""}${c.reset}`);
    out.push(hint(`Report a value: cast initiative report ${row.short_id} ${readings[0].key}=<value> --source <link or short id>`));
  }

  const section = (list: InitiativeRecordList, title: string, entries: RecordEntry[]) => {
    if (entries.length) out.push(head(`${title} (${entries.length})`), ...entries.flatMap((e) => recordEntryLines(c, list, e, now)));
  };
  const milestones = recordEntries(row, "milestones");
  if (milestones.length) out.push(head("Milestones"), `  ${nextMilestoneLine(row)}`, ...milestones.map((e) => milestoneLine(c, e.entry, e.n, now)));
  const questions = recordEntries(row, "questions");
  section("questions", "Open questions", questions.filter((e) => !e.entry.answer));
  section("questions", "Answered questions", questions.filter((e) => e.entry.answer));
  section("decisions", "Decisions", recordEntries(row, "decisions"));
  section("sources", "Sources", recordEntries(row, "sources"));

  const gaps = [!row.why && "why", !row.done_when && "done when", !milestones.length && "milestones", !row.sources?.length && "sources"].filter(Boolean);
  if (gaps.length) out.push("", hint(`Not on the record yet: ${gaps.join(", ")}. cast initiative --help lists the commands that write them.`));

  const projects: any[] = row.projects ?? [];
  out.push(head(`Projects (${projects.length})`, progressText(row.task_counts)));
  if (!projects.length) out.push(hint(`None yet: cast initiative add-project ${row.short_id} <project>`));
  for (const p of projects) {
    out.push(`  ${opts.projectIcons?.[p.status] ?? "?"} ${c.bold}${p.title}${c.reset} ${c.dim}${p.status} | lead ${p.lead ?? `${c.yellow}none${c.reset}${c.dim}`} | ${progressText(p.task_counts)}${c.reset}`);
  }

  const updates: any[] = row.updates ?? [];
  out.push(head(`Updates (${updates.length})`));
  if (!updates.length) out.push(hint(`None yet: cast initiative update ${row.short_id} --health on_track "How it is going"`));
  for (const u of updates) out.push(`  ${healthText(c, u.health)} ${c.dim}· ${u.by_label ?? "unknown"} · ${opts.ago(u.at)}${c.reset}`, ...indented(u.body, "    "));

  if (row.sub_initiatives?.length) {
    out.push(head("Sub initiatives"));
    for (const s of row.sub_initiatives) out.push(`  ${icon(s.status)} ${c.cyan}${s.short_id}${c.reset} ${s.title} ${healthText(c, s.health)}`);
  }
  out.push("");
  return out;
}
