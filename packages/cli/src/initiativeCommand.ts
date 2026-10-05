// The pure half of `cast initiative` (initiatives-projects-role-page.md I1):
// reading a status or a health the way a person types one, the lines `ls` and
// `show` print, and the one sentence that says what happened to the owner
// role's scope. The intent record (I5) is here too: every line `show` prints
// of it, which entry a person means by a number or a few words, and the op
// each record command sends. The network calls and the exits live in index.ts.

import { targetDayOf, targetDayStamp } from "@codecast/shared/time";
import {
  INITIATIVE_HEALTH_LABEL,
  INITIATIVE_RECORD_LISTS,
  INITIATIVE_RECORD_NOUN,
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_LABEL,
  INITIATIVE_UPDATE_HEALTHS,
  applyRecordOp,
  initiativeStanding,
  intentSourceLine,
  metricLine,
  metricReadings,
  metricTrends,
  milestoneCounts,
  nextMilestone,
  normalizeInitiativeRef,
  orderedMilestones,
  parseIntentSource,
  recordKeyOf,
  trendWords,
  type InitiativeDecision,
  type InitiativeHealth,
  type InitiativeMilestone,
  type InitiativeQuestion,
  type InitiativeRecordList,
  type InitiativeRecordOp,
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

const standingColor = (c: Palette, standing: MetricStanding) => (standing === "met" ? c.green : standing === "behind" ? c.yellow : c.dim);

/** A metric's standing against its target, as the one word the page uses. */
export function metricStandingText(c: Palette, standing: MetricStanding): string {
  return `${standingColor(c, standing)}${standing === "unknown" ? "unread" : standing}${c.reset}`;
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

/** What a person typed, read: the value, or why it could not be read. */
export type Read<T> = T | { error: string };
export const unread = (x: unknown): x is { error: string } => !!x && typeof x === "object" && "error" in x;

/** A calendar day (a target, a milestone's due day) as the stamp to store. */
export function readDayArg(text: string, flag: string, clears = false): Read<number> {
  return targetDayStamp(text) ?? { error: `Invalid ${flag} "${text}": use YYYY-MM-DD${clears ? ', or "none" to clear' : ""}` };
}

/**
 * A moment as a person types one (when a source was said, a milestone
 * reached, a value observed). A day is noon of that day here, so it reads as
 * that day in every nearby timezone, and today before noon is now, never a
 * moment still to come. A time (YYYY-MM-DDTHH:MM) is that time.
 */
export function readMomentArg(text: string, flag: string, now = Date.now()): Read<number> {
  const t = text.trim();
  if (targetDayStamp(t) !== null) {
    const [y, m, d] = t.split("-").map(Number);
    const noon = new Date(y, m - 1, d, 12).getTime();
    return new Date(y, m - 1, d).getTime() <= now && now < noon ? now : noon;
  }
  const at = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t) ? Date.parse(t.replace(" ", "T")) : NaN;
  return Number.isFinite(at) && at > 0 ? at : { error: `Invalid ${flag} "${text}": use YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time` };
}

/** `Title=YYYY-MM-DD` read as a milestone. Null for no title or a day that is not one; any other "=" is part of the title. */
export function parseMilestoneArg(text: string): { title: string; date?: number } | null {
  const dated = text.match(/^([\s\S]*)=\s*(\d{4}-\d{2}-\d{2})\s*$/);
  // A tail that reads as a day and is not written as one (2026-11-1, 11/1/2026) is a mistyped day, never words of the title.
  if (!dated && /=\s*\d{1,4}[-\/]\d{1,2}[-\/]\d{1,4}\s*$/.test(text)) return null;
  const title = (dated ? dated[1] : text).trim();
  if (!title) return null;
  if (!dated) return { title };
  const date = targetDayStamp(dated[2]);
  return date === null ? null : { title, date };
}
const MILESTONE_NEEDED = (text: string) => `Invalid milestone "${text}": use "Title" or "Title=YYYY-MM-DD"`;
export const readMilestoneArg = (text: string): Read<{ title: string; date?: number }> => parseMilestoneArg(text) ?? { error: MILESTONE_NEEDED(text) };

/**
 * A source as a person types one, as the record would store it, or null when
 * it names no address and says no words (the reducer's own rule). Words typed
 * beside --quote are kept with it: the parser alone would drop them.
 */
export function readSourceArg(text: string, extra: Pick<IntentSource, "by" | "at" | "quote"> = {}): IntentSource | null {
  const said = [...new Set([parseIntentSource(text).quote, extra.quote?.trim()].filter(Boolean))].join(": ");
  const read = applyRecordOp([], { list: "sources", action: "add", entry: parseIntentSource(text, { ...extra, quote: said }) }, { now: 0 });
  return "error" in read ? null : read.entry;
}
export const SOURCE_NEEDED = "A source needs an address (call:<id>#<line>, chat:<id>, doc:<id>, a session short id, ct-N, pl-N or a link) or the words said";

export type RecordEntry = { n: number; key: string; words: string; entry: any };

/**
 * One list of the record in reading order, each entry with the number `show`
 * prints beside it and the key a write names it by: milestones by day
 * (orderedMilestones), the rest as written. The key is the record's own
 * (recordKeyOf): a source has no stored one, its address is its key.
 */
export function recordEntries(row: any, list: InitiativeRecordList): RecordEntry[] {
  const entries: any[] = list === "milestones" ? orderedMilestones(row.milestones) : (row[list] ?? []);
  return entries.map((entry, i) => ({
    n: i + 1,
    key: recordKeyOf(list, entry),
    words: list === "milestones" ? entry.title : list === "sources" ? [entry.ref, entry.quote].filter(Boolean).join(" ") : entry.text,
    entry,
  }));
}

// The command that adds the first entry of each list, said when a goal has none.
const RECORD_ADD: Record<InitiativeRecordList, (on: string) => string> = {
  milestones: (on) => `cast initiative milestone ${on} "<title>" --date <YYYY-MM-DD>`,
  questions: (on) => `cast initiative ask ${on} "<question>"`,
  decisions: (on) => `cast initiative decide ${on} "<decision>"`,
  sources: (on) => `cast initiative source ${on} <address or the words said>`,
};

export type PickOpts = {
  /** The command to type next, with <n> where the entry's number goes. */
  retry?: string;
  /** The entries this command takes, what they are called, and what to say of one it does not take. */
  only?: { noun: string; test: (e: RecordEntry) => boolean; refuse: (e: RecordEntry, on: string) => string };
};

/**
 * Which entry a person means: its number in reading order, its key (a source's
 * address in any form the parser reads), or its words (all of them, or a part
 * only one entry has). A miss prints the entries and the command to type next.
 */
export function pickRecordEntry(row: any, list: InitiativeRecordList, pick: string, opts: PickOpts = {}): RecordEntry | { error: string } {
  const all = recordEntries(row, list);
  const noun = INITIATIVE_RECORD_NOUN[list];
  const on = row.short_id ?? "this goal";
  const t = pick.trim();
  if (!all.length) return { error: `${on} has no ${list} yet. Add one: ${RECORD_ADD[list](row.short_id ?? "<in-N>")}` };
  const takes = (e: RecordEntry) => !opts.only || opts.only.test(e);
  const taken = (e: RecordEntry) => (takes(e) ? e : { error: opts.only!.refuse(e, on) });
  const miss = (head: string, shown: RecordEntry[]) => ({
    error: [head, ...shown.map((e) => `  ${e.n}. ${e.words}`), ...(opts.retry && shown.length ? [`Name one by its number: ${opts.retry}`] : [])].join("\n"),
  });
  // A number is the one `show` prints, so it counts every entry, also one this command does not take.
  if (/^\d+$/.test(t)) return all[Number(t) - 1] ? taken(all[Number(t) - 1]) : miss(`No ${noun} ${t} on ${on}. It has ${all.length}:`, all);
  const low = t.toLowerCase();
  const address = list === "sources" ? recordKeyOf(list, parseIntentSource(t)) : t;
  const matches = (among: RecordEntry[]) => {
    const exact = among.filter((e) => e.key === t || e.key === address || e.words.toLowerCase() === low);
    return exact.length ? exact : among.filter((e) => e.words.toLowerCase().includes(low));
  };
  const open = all.filter(takes);
  const found = matches(open);
  if (found.length === 1) return found[0];
  if (found.length > 1) return miss(`"${t}" matches ${found.length} ${list} on ${on}:`, found);
  const other = matches(all.filter((e) => !takes(e)));
  if (other.length === 1) return taken(other[0]);
  return miss(`No ${opts.only?.noun ?? noun} on ${on} matches "${t}".${open.length ? " It has:" : ""}`, open);
}

// ── The op each record command sends ─────────────────────────────────────────
// Every command reads its arguments into one write here and index.ts sends it.
// A cleared value ('none' on the command line) arrives as null.

/** One write of the record: what it prints, the op it posts, and for an op on an entry that is there, how the person named it. */
export type RecordWrite = { verb: string; op: InitiativeRecordOp; pick?: PickOpts & { text: string } };

type Clearable = string | null | undefined;
const given = (...values: unknown[]) => values.some((v) => v !== undefined);

/** A source typed beside another entry (--source): read, or null for 'none'. */
function readSaidSource(text: string | null): Read<IntentSource | null> {
  return text === null ? null : readSourceArg(text) ?? { error: SOURCE_NEEDED };
}

/** `cast initiative milestone`: add one, reach one (--done, on the day --at names), change one (--edit) or take one off (--remove). */
export function milestoneWrite(ref: string, title: string | undefined, o: { done?: string; edit?: string; remove?: string; date?: Clearable; source?: Clearable; at?: Clearable }, now = Date.now()): Read<RecordWrite> {
  const on = normalizeInitiativeRef(ref);
  const picks = [o.done, o.edit, o.remove].filter((x) => x !== undefined);
  if (picks.length > 1 || (!picks.length && title === undefined)) return { error: "Give one of: a title to add, --done <n|title>, --edit <n|title> with what changes, or --remove <n|title>" };
  const named = (text: string, flag: string) => ({ text, retry: `cast initiative milestone ${on} ${flag} <n>` });

  if (o.remove !== undefined) {
    if (given(title, o.date, o.source, o.at)) return { error: "--remove takes the milestone alone" };
    return { verb: "Removed a milestone from", op: { list: "milestones", action: "remove" }, pick: named(o.remove, "--remove") };
  }
  if (o.done !== undefined) {
    if (given(title, o.date, o.source)) return { error: "--done takes only --at, the day it was reached. A title, --date and --source belong to a new milestone or to --edit" };
    if (o.at === null) return { error: `A reached milestone is reopened with: cast initiative milestone ${on} --edit <n> --at none` };
    const at = o.at === undefined ? undefined : readMomentArg(o.at, "--at", now);
    if (unread(at)) return at;
    return { verb: "Reached a milestone of", op: { list: "milestones", action: "close", ...(at === undefined ? {} : { at }) }, pick: named(o.done, "--done") };
  }

  const entry: Record<string, any> = {};
  if (title !== undefined) {
    const milestone = readMilestoneArg(title);
    if (unread(milestone)) return milestone;
    if (milestone.date !== undefined && o.date !== undefined) return { error: 'Give the day once: in the title as "Title=YYYY-MM-DD", or with --date' };
    Object.assign(entry, milestone);
  }
  if (typeof o.date === "string") {
    const date = readDayArg(o.date, "--date", o.edit !== undefined);
    if (unread(date)) return date;
    entry.date = date;
  }
  if (o.source != null) {
    const source = readSaidSource(o.source);
    if (unread(source)) return source;
    entry.source = source;
  }
  if (o.edit === undefined) {
    if (o.at !== undefined) return { error: "--at is the day a milestone was reached: give it with --done or --edit" };
    return { verb: "Added a milestone to", op: { list: "milestones", action: "add", entry } };
  }
  if (o.date === null) entry.date = null;
  if (o.source === null) entry.source = null;
  if (o.at !== undefined) {
    const at = o.at === null ? null : readMomentArg(o.at, "--at", now);
    if (unread(at)) return at;
    entry.done_at = at;
  }
  if (!Object.keys(entry).length) return { error: "Nothing to change: give a new title, --date, --source, or --at (the day it was reached; 'none' reopens it)" };
  return { verb: "Changed a milestone of", op: { list: "milestones", action: "edit", entry }, pick: named(o.edit, "--edit") };
}

/** `cast initiative ask` and `decide`: put the words on the record, or change an entry that is there (--edit). */
export function saidWrite(ref: string, list: "questions" | "decisions", words: string | undefined, o: { edit?: string; by?: Clearable; source?: Clearable }): Read<RecordWrite> {
  const noun = INITIATIVE_RECORD_NOUN[list];
  const command = list === "questions" ? "ask" : "decide";
  const entry: Record<string, any> = {};
  if (words !== undefined) entry.text = words;
  if (o.by !== undefined) entry.by = o.by;
  if (o.source !== undefined) {
    const source = readSaidSource(o.source);
    if (unread(source)) return source;
    entry.source = source;
  }
  if (o.edit !== undefined) {
    if (!Object.keys(entry).length) return { error: "Nothing to change: give the new words, --by or --source" };
    return { verb: `Changed a ${noun} on`, op: { list, action: "edit", entry }, pick: { text: o.edit, retry: `cast initiative ${command} ${normalizeInitiativeRef(ref)} --edit <n> "<new words>"` } };
  }
  if (!words?.trim()) return { error: `Give the ${noun}, or --edit <n|words> to change one` };
  // Only an edit clears: a new entry that names nobody is signed by whoever adds it.
  for (const k of ["by", "source"]) if (entry[k] === null) delete entry[k];
  return { verb: list === "questions" ? "Asked on" : "Recorded a decision on", op: { list, action: "add", entry } };
}

/** `cast initiative answer`: close an open question. One that is answered keeps its answer unless --replace. */
export function answerWrite(ref: string, pick: string, answer: string, o: { replace?: boolean; at?: string } = {}, now = Date.now()): Read<RecordWrite> {
  const at = o.at === undefined ? undefined : readMomentArg(o.at, "--at", now);
  if (unread(at)) return at;
  const only: PickOpts["only"] = {
    noun: "open question",
    test: (e) => !e.entry.answer,
    refuse: (e, on) => `Question ${e.n} on ${on} is already answered: "${e.entry.answer}". Pass --replace to put this answer in its place.`,
  };
  return {
    verb: o.replace ? "Replaced the answer to a question on" : "Answered a question on",
    op: { list: "questions", action: "close", answer, ...(at === undefined ? {} : { at }) },
    pick: { text: pick, retry: `cast initiative answer ${normalizeInitiativeRef(ref)} <n> "<answer>"`, ...(o.replace ? {} : { only }) },
  };
}

/** `cast initiative source`: where the goal was stated, who said it, and when as a moment. */
export function sourceWrite(text: string, o: { quote?: string; by?: string; at?: string } = {}, now = Date.now()): Read<RecordWrite> {
  const at = o.at === undefined ? undefined : readMomentArg(o.at, "--at", now);
  if (unread(at)) return at;
  const entry = readSourceArg(text, { quote: o.quote, by: o.by, at });
  return entry ? { verb: "Added a source to", op: { list: "sources", action: "add", entry } } : { error: SOURCE_NEEDED };
}

/** `cast initiative record --list <list> --remove <n|key>`: take one entry of any list off. */
export function removeWrite(ref: string, listText: string, pick: string): Read<RecordWrite> {
  const list = INITIATIVE_RECORD_LISTS.find((l) => l === listText);
  if (!list) return { error: `Invalid --list "${listText}": ${INITIATIVE_RECORD_LISTS.join(", ")}` };
  return { verb: `Removed a ${INITIATIVE_RECORD_NOUN[list]} from`, op: { list, action: "remove" }, pick: { text: pick, retry: `cast initiative record ${normalizeInitiativeRef(ref)} --list ${list} --remove <n>` } };
}

/** The verb a write prints: its own, or that nothing moved (an add of what is already there, a close or an edit that says what stands). A server that does not say whether it moved prints the write's own. */
export const recordVerb = (write: RecordWrite, result: any): string =>
  result.moved !== false ? write.verb : write.op.action === "add" ? "Already on the record of" : "Nothing changed on";

const SOURCE_SAID = { quote: "the words", by: "who said it", at: "when" } as const;

/**
 * What follows a source add that moved nothing: the address was already on
 * the record, so the entry there stands. The quote, who and when typed now
 * fill what it lacks, as one edit; what it already says is kept and named.
 */
export function sourceFillIn(write: RecordWrite, result: any): { write?: RecordWrite; kept: string[] } {
  const { op } = write;
  const stands: IntentSource | undefined = result.entry;
  if (op.list !== "sources" || op.action !== "add" || result.moved !== false || !stands) return { kept: [] };
  const typed = op.entry as IntentSource;
  const fields = (Object.keys(SOURCE_SAID) as Array<keyof typeof SOURCE_SAID>).filter((k) => typed[k] !== undefined && typed[k] !== stands[k]);
  const fill = Object.fromEntries(fields.filter((k) => stands[k] === undefined).map((k) => [k, typed[k]]));
  return {
    kept: fields.filter((k) => stands[k] !== undefined).map((k) => SOURCE_SAID[k]),
    ...(Object.keys(fill).length ? { write: { verb: "Updated a source on", op: { list: "sources", action: "edit", key: recordKeyOf("sources", stands), entry: fill } } } : {}),
  };
}

/** One metric as `show` and `report` print it: now against its target, the standing and the date in the standing's color, then which way it is moving. */
export function metricRecordLine(c: Palette, m: MetricReading, trend?: MetricTrend, now = Date.now()): string {
  const moving = trend ? trendWords(trend) : "";
  return `${standingColor(c, m.standing)}${metricLine(m, now)}${c.reset}${moving ? ` ${c.dim}· ${moving}${c.reset}` : ""}`;
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
  const key = result.entry ? recordKeyOf(list, result.entry) : undefined;
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
    out.push(head("Metrics", "each number against its target"));
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
