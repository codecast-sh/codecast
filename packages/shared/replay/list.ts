// The replay list's rules (docs/architecture/external-data.md X5): which
// recordings a filter keeps, how a sort orders them, who a recording's person
// is, and the shape a row draws (activity over time, failures, rage clicks,
// active time). The server's browse query and the web list import this file,
// so the rows the server counts are the rows the page shows. The player reads
// the same idle ranges to skip inactivity.
import { replayCutAt, type ReplayEvent } from "../contracts/replay";
import { isFailure } from "./events";
import { RAGE_CLICK_COUNT, RAGE_CLICK_MS } from "./issues";

export const REPLAY_SORTS = ["newest", "oldest", "longest", "shortest", "errors", "clicks"] as const;

/**
 * How many of a scope's newest recordings a browse reads (replays.browse). A
 * total that reached it is a floor, and a zero means none among these.
 */
export const REPLAY_BROWSE_SCAN = 2000;
export type ReplaySort = (typeof REPLAY_SORTS)[number];

/** Toggles: has an error, has a failed request, has a rage click, or its copy holds only its start (the rest is still being read). */
export const REPLAY_HAS = ["errors", "failed", "rage", "partial"] as const;
export type ReplayHas = (typeof REPLAY_HAS)[number];

export const REPLAY_DURATIONS = ["lt30s", "gt1m", "gt5m", "gt30m"] as const;
export type ReplayDuration = (typeof REPLAY_DURATIONS)[number];

export const REPLAY_DATES = ["24h", "7d", "30d"] as const;
export type ReplayDate = (typeof REPLAY_DATES)[number];

/**
 * The least active time a listed recording has. A tab opened and left holds
 * nothing to watch, so the list starts past REPLAY_ACTIVE_DEFAULT, as
 * PostHog's does; "any" shows them all.
 */
export const REPLAY_ACTIVE = ["any", "5s", "30s", "1m", "5m"] as const;
export type ReplayActive = (typeof REPLAY_ACTIVE)[number];
export const REPLAY_ACTIVE_DEFAULT: ReplayActive = "5s";
const ACTIVE_MS: Record<ReplayActive, number> = { any: 0, "5s": 5_000, "30s": 30_000, "1m": 60_000, "5m": 5 * 60_000 };

/** A filter as a person sets it (and the URL carries it). */
export interface ReplayListFilter {
  /** Matches a person's email, name or id, the recording's url, or its rp-N. */
  q?: string;
  /** One person's recordings: personKey of their user. */
  person?: string;
  has?: ReplayHas[];
  dur?: ReplayDuration;
  date?: ReplayDate;
  /** Least active time; absent means REPLAY_ACTIVE_DEFAULT. */
  active?: ReplayActive;
  /** Only recordings that caught this issue (its group id). */
  group_id?: string;
  sort?: ReplaySort;
  /** Where it ran, as the vendor names it (ReplayFacts): each an exact match. */
  browser?: string;
  os?: string;
  device?: string;
  country?: string;
}

/** The filter as the server takes it: the date resolved to an instant. */
export interface ReplayMatch {
  q?: string;
  person?: string;
  has?: ReplayHas[];
  min_ms?: number;
  max_ms?: number;
  /** Least active time (activeMsOf); a recording whose active time nobody knows is kept. */
  active_min_ms?: number;
  /** A group id the recording caught. */
  group?: string;
  since?: number;
  browser?: string;
  os?: string;
  device?: string;
  country?: string;
}

/** The environment filters, in the order the toolbar shows them. */
export const REPLAY_ENV_KEYS = ["browser", "os", "device", "country"] as const;
export type ReplayEnvKey = (typeof REPLAY_ENV_KEYS)[number];

/**
 * What the vendor itself says of a recording (replays.facts, written by
 * sources/replayFacts.ts): its length and activity from the vendor's own
 * listing, where it ran, and how it was reached. Present for every recording
 * the vendor knows, whether or not its stream was ever read, so a list can
 * filter and sort recordings whose chunks are gone. `at` alone: asked, unknown.
 */
export interface ReplayFacts {
  at: number;
  length_ms?: number;
  active_ms?: number;
  clicks?: number;
  console_errors?: number;
  rage_clicks?: number;
  browser?: string;
  os?: string;
  device?: string;
  country?: string;
  referrer?: string;
}

/** What a recording draws in a list row (replays.shape): written when its stream is assembled or imported. */
export interface ReplayShape {
  v: number;
  /** The recording's length less its idle stretches (idleRanges). */
  active_ms: number;
  /** Navigations: pages the person saw. */
  pages: number;
  rage_clicks: number;
  /** SHAPE_CELLS digits 0 to 9: how much the person did in each slice of the recording. */
  strip: string;
  /** Where failures happened, in thousandths of the recording's length, at most SHAPE_MARKS_MAX. */
  marks: number[];
  /** The paths the person visited, in order, each once (at most SHAPE_PATHS_MAX): what "visited /billing" searches. Absent before v2. */
  paths?: string[];
  /** The requests that failed, as "METHOD /path", each once (at most SHAPE_PATHS_MAX): what "hit /api/claim" searches. Absent before v2. */
  endpoints?: string[];
}

/** 2: the shape keeps the visited paths and the failed endpoints, so a search finds a recording by what happened in it. 3: pages counts changes of address, not repeated snapshots of one page. */
export const SHAPE_VERSION = 3;
export const SHAPE_PATHS_MAX = 8;
const SHAPE_PATH_CHARS = 80;

/** A URL's path, without its query or hash, held to SHAPE_PATH_CHARS. */
function pathPart(url: string): string {
  try {
    return new URL(url, "https://x.invalid").pathname.slice(0, SHAPE_PATH_CHARS);
  } catch {
    return url.split(/[?#]/)[0].slice(0, SHAPE_PATH_CHARS);
  }
}
export const SHAPE_CELLS = 48;
export const SHAPE_MARKS_MAX = 24;
/** No event for this long is idle time: what skip inactivity jumps over, and what active time leaves out. */
export const IDLE_GAP_MS = 5_000;
/** How much of an idle stretch is still played at each end, so a skip lands just before the next thing happens. */
export const IDLE_EDGE_MS = 1_000;

/** The minimal row the rules read: the list row (replayView) and the stored row both fit. */
export interface ReplayListRow {
  short_id: string;
  url?: string | null;
  user?: { id?: string; email?: string; name?: string } | null;
  started_at: number;
  duration_ms?: number | null;
  /** How far the copy reaches, when the vendor's recording was cut at import: a partial copy stops well short of its length. */
  captured_ms?: number | null;
  counts: { clicks: number; errors: number; failed_requests: number };
  shape?: ReplayShape | null;
  facts?: ReplayFacts | null;
  group_ids?: readonly string[];
}

/**
 * Rage clicks: the more of the stream's count and the vendor's (an import cut
 * at a size cap misses what the vendor saw later); undefined when neither knows.
 */
export function rageClicksOf(row: Pick<ReplayListRow, "shape" | "facts">): number | undefined {
  const own = row.shape?.rage_clicks;
  const theirs = row.facts?.rage_clicks;
  return own === undefined ? theirs : theirs === undefined ? own : Math.max(own, theirs);
}

/** Active time: the vendor's, measured over the whole recording, else the stream's. */
export function activeMsOf(row: Pick<ReplayListRow, "shape" | "facts">): number | undefined {
  return row.facts?.active_ms ?? row.shape?.active_ms;
}

const DAY = 86_400_000;

export function durationRange(d: ReplayDuration | undefined): { min_ms?: number; max_ms?: number } {
  switch (d) {
    case "lt30s": return { max_ms: 30_000 };
    case "gt1m": return { min_ms: 60_000 };
    case "gt5m": return { min_ms: 5 * 60_000 };
    case "gt30m": return { min_ms: 30 * 60_000 };
    default: return {};
  }
}

/** The instant a date filter starts at. `now` should be coarse (an hour) so a query's args stay put. */
export function dateSince(d: ReplayDate | undefined, now: number): number | undefined {
  if (!d) return undefined;
  return now - (d === "24h" ? DAY : d === "7d" ? 7 * DAY : 30 * DAY);
}

export function resolveReplayFilter(f: ReplayListFilter, now: number): ReplayMatch {
  const q = f.q?.trim().toLowerCase();
  const since = dateSince(f.date, now);
  return {
    ...(q ? { q } : {}),
    ...(f.person ? { person: f.person } : {}),
    ...(f.has?.length ? { has: [...f.has] } : {}),
    ...durationRange(f.dur),
    ...(ACTIVE_MS[f.active ?? REPLAY_ACTIVE_DEFAULT] ? { active_min_ms: ACTIVE_MS[f.active ?? REPLAY_ACTIVE_DEFAULT] } : {}),
    ...(f.group_id ? { group: f.group_id } : {}),
    ...(since !== undefined ? { since } : {}),
    ...Object.fromEntries(REPLAY_ENV_KEYS.filter((k) => f[k]).map((k) => [k, f[k]])),
  };
}

/** The match the list runs when nothing is set: only its default least active time. */
export const REPLAY_DEFAULT_MATCH: ReplayMatch = resolveReplayFilter({}, 0);

/** Who a recording is of, as one stable key: the email when known, else the id, else the name. */
export function personKey(user: ReplayListRow["user"]): string | null {
  if (!user) return null;
  return user.email?.trim().toLowerCase() || user.id || user.name || null;
}

const HANDLE_ADJ = ["Amber", "Brisk", "Calm", "Clever", "Coral", "Cosmic", "Daring", "Dusky", "Eager", "Fern", "Gentle", "Golden", "Hazel", "Humble", "Indigo", "Jolly", "Keen", "Lively", "Lucky", "Mellow", "Misty", "Nimble", "Olive", "Plucky", "Quiet", "Rapid", "Rusty", "Sandy", "Silver", "Snowy", "Steady", "Sunny", "Swift", "Tidy", "Vivid", "Witty"] as const;
const HANDLE_ANIMAL = ["Badger", "Bison", "Crane", "Dingo", "Falcon", "Ferret", "Finch", "Gecko", "Heron", "Ibis", "Jackal", "Koala", "Lemur", "Lynx", "Marten", "Moose", "Newt", "Ocelot", "Otter", "Panda", "Puffin", "Quail", "Raven", "Seal", "Shrew", "Stoat", "Tapir", "Toucan", "Vole", "Walrus", "Wombat", "Yak", "Zebra", "Bobcat", "Egret", "Hare"] as const;

/**
 * A stable, readable name for someone known only by an id ("Quiet Otter"):
 * the same id always reads the same, so two anonymous people tell apart at a
 * glance. The id stays the person's key; this is only how it reads.
 */
export function anonHandle(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return `${HANDLE_ADJ[h % HANDLE_ADJ.length]} ${HANDLE_ANIMAL[Math.floor(h / HANDLE_ADJ.length) % HANDLE_ANIMAL.length]}`;
}

/** How a person reads in a row: email or name, else a readable handle made from their anonymous id (anonHandle). */
export function personLabel(user: ReplayListRow["user"]): string {
  if (user?.email) return user.email;
  if (user?.name) return user.name;
  if (user?.id) return anonHandle(user.id);
  return "Anonymous";
}

/** Whether the person behind a recording is known only by an id. */
export function isAnonymous(user: ReplayListRow["user"]): boolean {
  return !user?.email && !user?.name;
}

/** A search that names one recording by its id ("rp-5241"): the id, lowercased, else null. */
export function exactReplayId(q: string | undefined): string | null {
  const id = q?.trim().toLowerCase();
  return id && /^rp-\d+$/.test(id) ? id : null;
}

export function replayMatches(row: ReplayListRow, m: ReplayMatch): boolean {
  // A recording asked for by its id is that recording, whatever else the list filters by, as in Sentry and PostHog.
  const exact = exactReplayId(m.q);
  if (exact) return row.short_id.toLowerCase() === exact;
  if (m.since !== undefined && row.started_at < m.since) return false;
  if (m.person && personKey(row.user) !== m.person) return false;
  if (m.min_ms !== undefined || m.max_ms !== undefined) {
    // An unknown length matches no length filter: nothing says it is short or long.
    if (row.duration_ms == null) return false;
    if (m.min_ms !== undefined && row.duration_ms < m.min_ms) return false;
    if (m.max_ms !== undefined && row.duration_ms > m.max_ms) return false;
  }
  // The least-activity default hides tabs left open, never a recording an issue points at.
  if (m.active_min_ms && !row.group_ids?.length) {
    const active = activeMsOf(row);
    if (active !== undefined && active < m.active_min_ms) return false;
  }
  if (m.group && !row.group_ids?.includes(m.group)) return false;
  for (const h of m.has ?? []) {
    if (h === "errors" && !(row.counts.errors > 0)) return false;
    if (h === "failed" && !(row.counts.failed_requests > 0)) return false;
    if (h === "rage" && !((rageClicksOf(row) ?? 0) > 0)) return false;
    if (h === "partial" && replayCutAt(row.captured_ms, row.duration_ms) === null) return false;
  }
  for (const k of REPLAY_ENV_KEYS) if (m[k] && row.facts?.[k] !== m[k]) return false;
  if (m.q) {
    // The pages visited and the requests that failed are searched too: "/billing", "post /api/claim".
    const hay = [row.short_id, row.url, row.user?.email, row.user?.name, row.user?.id, row.user?.id && isAnonymous(row.user) ? anonHandle(row.user.id) : null, ...(row.shape?.paths ?? []), ...(row.shape?.endpoints ?? [])].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(m.q)) return false;
  }
  return true;
}

/** The order a sort puts rows in. Unknown lengths sort last by length; ties go newest first. */
export function compareReplays(sort: ReplaySort = "newest"): (a: ReplayListRow, b: ReplayListRow) => number {
  const newest = (a: ReplayListRow, b: ReplayListRow) => b.started_at - a.started_at;
  switch (sort) {
    case "oldest": return (a, b) => a.started_at - b.started_at;
    case "longest": return (a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1) || newest(a, b);
    case "shortest": return (a, b) => (a.duration_ms ?? Infinity) - (b.duration_ms ?? Infinity) || newest(a, b);
    case "errors": return (a, b) => (b.counts.errors + b.counts.failed_requests) - (a.counts.errors + a.counts.failed_requests) || newest(a, b);
    case "clicks": return (a, b) => b.counts.clicks - a.counts.clicks || newest(a, b);
    default: return newest;
  }
}

/** Each environment value among `rows` with how many recordings ran on it, most first: the toolbar's options. */
export function replayFacets(rows: readonly ReplayListRow[], max = 40): Record<ReplayEnvKey, [string, number][]> {
  const out = {} as Record<ReplayEnvKey, [string, number][]>;
  for (const k of REPLAY_ENV_KEYS) {
    const by = new Map<string, number>();
    for (const r of rows) {
      const v = r.facts?.[k];
      if (v) by.set(v, (by.get(v) ?? 0) + 1);
    }
    out[k] = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
  }
  return out;
}

/** One person's recordings, folded: what the grouped list shows per person. */
export interface ReplayPerson {
  key: string;
  label: string;
  anonymous: boolean;
  sessions: number;
  /** Summed known lengths. */
  ms: number;
  errors: number;
  failed: number;
  last_at: number;
  /** The page of their newest recording: how an anonymous person is told apart. */
  url?: string | null;
  /** Where their newest recording ran (browser, OS, country): the other way an anonymous person is told apart. */
  env?: string | null;
}

/** A recording's environment as one short line: "Chrome · macOS · US". Null when the vendor said nothing. */
export function envLine(facts: ReplayFacts | null | undefined): string | null {
  if (!facts) return null;
  const parts = [facts.browser, facts.os, facts.country].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The orders the grouped list sorts people in. */
export const REPLAY_PEOPLE_SORTS = ["recent", "recordings", "failures", "time"] as const;
export type ReplayPeopleSort = (typeof REPLAY_PEOPLE_SORTS)[number];

/** People in a sort's order; ties go to whoever was seen last. */
export function sortPeople(people: ReplayPerson[], sort: ReplayPeopleSort = "recent"): ReplayPerson[] {
  const recent = (a: ReplayPerson, b: ReplayPerson) => b.last_at - a.last_at;
  const by: Record<ReplayPeopleSort, (a: ReplayPerson, b: ReplayPerson) => number> = {
    recent,
    recordings: (a, b) => b.sessions - a.sessions || recent(a, b),
    failures: (a, b) => b.errors + b.failed - (a.errors + a.failed) || recent(a, b),
    time: (a, b) => b.ms - a.ms || recent(a, b),
  };
  return [...people].sort(by[sort] ?? recent);
}

/** Group rows by person, people with the newest recording first. Rows with no person are left out. */
export function replayPeople(rows: readonly ReplayListRow[], max = Infinity): ReplayPerson[] {
  const by = new Map<string, ReplayPerson>();
  for (const r of rows) {
    const key = personKey(r.user);
    if (!key) continue;
    const p = by.get(key) ?? { key, label: personLabel(r.user), anonymous: isAnonymous(r.user), sessions: 0, ms: 0, errors: 0, failed: 0, last_at: 0, url: null, env: null };
    p.sessions++;
    p.ms += r.duration_ms ?? 0;
    p.errors += r.counts.errors;
    p.failed += r.counts.failed_requests;
    if (r.started_at >= p.last_at) {
      p.last_at = r.started_at;
      p.url = r.url ?? p.url ?? null;
      p.env = envLine(r.facts) ?? p.env ?? null;
    }
    by.set(key, p);
  }
  return [...by.values()].sort((a, b) => b.last_at - a.last_at).slice(0, max);
}

// ── The shape of one recording ──

/** Events that say the person or the page did something; a page outline is the recorder's own. */
const isActivity = (e: ReplayEvent) => e.type !== "view";
const isPersonActivity = (e: ReplayEvent) => e.type === "click" || e.type === "input" || e.type === "key" || e.type === "scroll" || e.type === "submit" || e.type === "nav";

/**
 * The stretches where nothing happened for longer than `gap`, each trimmed by
 * IDLE_EDGE_MS at both ends, from the first event to `length` (the replay
 * clock's end, ms from its zero). The tail after the last event counts when
 * it is long enough.
 */
export function idleRanges(events: readonly ReplayEvent[], length: number, gap = IDLE_GAP_MS): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let prev: number | null = null;
  for (const e of events) {
    if (!isActivity(e)) continue;
    if (prev !== null && e.t - prev > gap) out.push({ from: prev + IDLE_EDGE_MS, to: e.t - IDLE_EDGE_MS });
    prev = prev === null ? e.t : Math.max(prev, e.t);
  }
  if (prev !== null && length - prev > gap) out.push({ from: prev + IDLE_EDGE_MS, to: length });
  return out;
}

/** Bursts of RAGE_CLICK_COUNT or more clicks on one element inside RAGE_CLICK_MS: when each started and how many clicks it held. */
export function rageBursts(events: readonly ReplayEvent[]): { t: number; selector: string; label: string; clicks: number }[] {
  const out: { t: number; selector: string; label: string; clicks: number }[] = [];
  const open = new Map<string, { t: number; last: number; clicks: number; label: string; counted: boolean }>();
  for (const e of events) {
    if (e.type !== "click") continue;
    const key = e.selector || e.label;
    const cur = open.get(key);
    if (cur && e.t - cur.last <= RAGE_CLICK_MS) {
      cur.clicks++;
      cur.last = e.t;
      if (cur.clicks >= RAGE_CLICK_COUNT) {
        if (!cur.counted) {
          cur.counted = true;
          out.push({ t: cur.t, selector: e.selector, label: e.label, clicks: cur.clicks });
        } else out[out.length - 1].clicks = cur.clicks;
      }
    } else open.set(key, { t: e.t, last: e.t, clicks: 1, label: e.label, counted: false });
  }
  return out;
}

export function replayShape(events: readonly ReplayEvent[]): ReplayShape {
  const first = events[0]?.t ?? 0;
  const last = events[events.length - 1]?.t ?? first;
  const span = Math.max(1, last - first);
  const cells = new Array<number>(SHAPE_CELLS).fill(0);
  const marks = new Set<number>();
  let pages = 0;
  let lastUrl: string | undefined;
  const paths = new Set<string>();
  const endpoints = new Set<string>();
  for (const e of events) {
    const at = (e.t - first) / span;
    if (isPersonActivity(e)) cells[Math.min(SHAPE_CELLS - 1, Math.floor(at * SHAPE_CELLS))]++;
    // A visit is a change of address: a snapshot of the same page again is not another page (foldRepeatNavs).
    if (e.type === "nav" && e.url !== lastUrl) {
      lastUrl = e.url;
      pages++;
      if (paths.size < SHAPE_PATHS_MAX) paths.add(pathPart(e.url));
    }
    if (e.type === "network" && isFailure(e) && endpoints.size < SHAPE_PATHS_MAX) endpoints.add(`${e.method} ${pathPart(e.url)}`);
    if (isFailure(e) && marks.size < SHAPE_MARKS_MAX) marks.add(Math.min(999, Math.round(at * 1000)));
  }
  const peak = Math.max(1, ...cells);
  // Square root, so one click in a quiet slice still shows beside a burst of fifty.
  const strip = cells.map((c) => (c === 0 ? "0" : String(Math.max(1, Math.round(Math.sqrt(c / peak) * 9))))).join("");
  const idle = idleRanges(events, last).reduce((s, r) => s + Math.max(0, r.to - r.from), 0);
  return { v: SHAPE_VERSION, active_ms: Math.max(0, last - first - idle), pages, rage_clicks: rageBursts(events).length, strip, marks: [...marks].sort((a, b) => a - b), paths: [...paths], endpoints: [...endpoints] };
}
