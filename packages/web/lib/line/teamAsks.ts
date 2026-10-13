// What a product's agents asked its team to do by a date (line-journeys.md
// LJ8.6 Team asks): Union's escalations, each an open task in Union's own worker
// queue. They are the team's, never one viewer's: no finding names who does it,
// and codecast cannot read the task's assignee or whether it was closed in
// Union, so they are listed on the Escalation finder as they were asked, each
// opening its task in Union, and never claim to be late. Pure.
import { escalationFinding } from "./problemPage";

/** A finding as teamAsks reads it: the feed's facts, with the day the server read off its whole detail. */
export type AskSignal = {
  _id: string;
  short_id?: string | null;
  source: string;
  subject?: string | null;
  title: string;
  detail_md?: string | null;
  evidence_url?: string | null;
  task_id?: string | null;
  project_id?: string | null;
  created_at: number;
  observed_at?: number | null;
  ask_due?: number | null;
  ask_done?: { at: number } | null;
  retired?: unknown;
};

export type TeamAsk<S extends AskSignal = AskSignal> = {
  signal: S;
  /** "Deliver: Approved counterparty pitches unsendable from contact run": the act, then what it is about. */
  title: string;
  /** Who it is about, when the agent's reason names them first. */
  contact: string | null;
  /** The day its words set, as the UTC midnight that starts it. */
  due: number;
  /** Where the act is done: the product's own task. */
  url: string | null;
};

/** Every finding whose words ask the team to act and set a day for it (the server's `ask_due`), one per product task
 *  (an agent that escalates the same task again replaces the older ask), soonest due first. */
export function teamAsks<S extends AskSignal>(signals: ReadonlyArray<S>): TeamAsk<S>[] {
  const newest = new Map<string, S>();
  for (const s of signals) {
    if (s.ask_due == null || s.ask_done || s.retired) continue;
    const key = s.evidence_url || s._id;
    const had = newest.get(key);
    if (!had || (s.observed_at || s.created_at) > (had.observed_at || had.created_at)) newest.set(key, s);
  }
  return [...newest.values()].flatMap((s): TeamAsk<S>[] => {
    const e = escalationFinding(s);
    if (!e) return [];
    return [{ signal: s, title: `${e.ask}: ${e.about.charAt(0).toUpperCase()}${e.about.slice(1)}`, contact: e.contact, due: s.ask_due!, url: s.evidence_url ?? null }];
  }).sort((a, b) => a.due - b.due);
}

const DAY_MS = 86_400_000;
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** When an ask was due, against today: "Due today", "Due tomorrow", "Due Thu, Oct 15", and past it "Was due Mon,
 *  Oct 12" (`past`): whether it was done is Union's to say. */
export function dueWords(due: number, now: number): { short: string; past: boolean } {
  const days = Math.round((due - Math.floor(now / DAY_MS) * DAY_MS) / DAY_MS);
  const day = WEEKDAY.format(due);
  if (days < 0) return { short: `Was due ${day}`, past: true };
  return { short: days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due ${day}`, past: false };
}

/** Asks under one cause: the agents asked for the same thing about different contacts ("no phone on file and email
 *  unanswered", nine fingerprints, nine contacts). `about` is the soonest one's words; asks soonest due first. */
export type AskCause<S extends AskSignal = AskSignal> = { key: string; about: string; asks: TeamAsk<S>[] };

// Words that carry no cause: the filer's connectives, and "file" (every record problem is "on file").
const CAUSE_STOP = new Set("a an and or the of on in to for from by at with after before no not never be been is are was has have had can cannot it its their them they this that file".split(" "));
const causeWords = (about: string): Set<string> =>
  new Set(about.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !CAUSE_STOP.has(w)).map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n || 1); };
/** How alike two asks' causes must read to share a group: every pair in it, never a chain of near neighbours. */
const SAME_CAUSE = 0.25;

/** Team asks grouped by what they ask about, the closest pairs first, a group taking an ask only when it reads like
 *  every ask already in it; groups soonest due first. One ask alone is a group of one. */
export function askCauses<S extends AskSignal>(asks: ReadonlyArray<TeamAsk<S>>): AskCause<S>[] {
  const words = asks.map((a) => causeWords(escalationFinding(a.signal)?.about ?? a.title));
  const group = asks.map((_, i) => [i]);
  const of = asks.map((_, i) => i);
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i < asks.length; i++) for (let j = i + 1; j < asks.length; j++) {
    const o = overlap(words[i], words[j]);
    if (o >= SAME_CAUSE) pairs.push([o, i, j]);
  }
  pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
  for (const [, i, j] of pairs) {
    const [gi, gj] = [of[i], of[j]];
    if (gi === gj || !group[gi].every((a) => group[gj].every((b) => overlap(words[a], words[b]) >= SAME_CAUSE))) continue;
    for (const k of group[gj]) of[k] = gi;
    group[gi].push(...group[gj]);
    group[gj] = [];
  }
  return group.filter((g) => g.length).map((g) => {
    const list = g.map((i) => asks[i]).sort((a, b) => a.due - b.due);
    const about = escalationFinding(list[0].signal)?.about ?? list[0].title;
    return { key: list[0].signal._id, about: about.charAt(0).toUpperCase() + about.slice(1), asks: list };
  }).sort((a, b) => a.asks[0].due - b.asks[0].due);
}
