// The shape of one day edition, worked out from store rows (spec 4 and 6.4).
// Pure: the page hands in the day's stories, its edition, the live strip and
// the URL, and gets back what to paint and the j/k reading order. Nothing here
// clusters commits; stories arrive whole from the server, and this only places
// them: the lead, sections by area with release stamps between rows, In brief.
//
// Filters never rewrite prose. Area and surface filters dim what they miss so
// the shape of the day stays visible; person, risk, waiting and text filters
// hide what they miss. Dimmed and hidden stories leave the reading order.
import { statsHeadline, surfaceCoversArea, waitingStories, type ShipEvent } from "@codecast/shared/changes";
import type { EditionRow, LiveRow, StoryRow } from "../../hooks/useSyncChanges";
import { hasFilters, type ChangesUrl } from "./useChangesUrlState";

export type Ship = Pick<ShipEvent, "surface" | "version" | "sha" | "at">;

export type EditionStats = { commits: number; stories: number; releases: number; people: number; sessions: number; private_sessions: number };

export type SectionItem = { kind: "story"; story: StoryRow } | { kind: "stamp"; ship: Ship; key: string };

export type Section = { area: string; items: SectionItem[]; count: number; dimmed: boolean };

/** One area's ink bar: its file touches, the commits that made them, and the stories filed under it. */
export type AreaTouch = { area: string; touches: number; commits: number; stories: number };

export type EditionModel = {
  /** The day's stories under the branch toggle, before filters. */
  day: StoryRow[];
  lead: StoryRow | null;
  sections: Section[];
  brief: StoryRow[];
  /** story_key of every story j/k visits, in reading order. */
  order: string[];
  /** Stories drawn dimmed by an area or surface filter. */
  dimmed: Set<string>;
  /** Stories waiting behind the latest ship of their surface. */
  waiting: Set<string>;
  /** Stories matching every filter. */
  matching: number;
  stats: EditionStats;
  headline: string;
  /** The headline and standfirst are the edition's prose, not the stats line. */
  prose: boolean;
  standfirst: string | null;
  releases: Ship[];
  areas: AreaTouch[];
  /** "Showing 3 of 9 stories (cli)" while a filter is on. */
  filterLine: string | null;
  /** The lead's headline says what the edition headline just said, so the lead card opens with its dek instead. */
  leadEchoesHeadline: boolean;
};

const wordsOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);

/** How much of a lead headline must be in the edition headline for it to read as a repeat. */
export const ECHO_SHARE = 0.7;

/**
 * Whether a lead story's headline repeats the edition's: its words open the
 * edition headline, or at least `ECHO_SHARE` of them occur in it. Case and
 * punctuation are ignored. A headline under three words is never an echo:
 * too little to compare.
 */
export function echoesHeadline(leadHeadline: string, editionHeadline: string): boolean {
  const lead = wordsOf(leadHeadline);
  const edition = wordsOf(editionHeadline);
  if (lead.length < 3 || !edition.length) return false;
  if (lead.every((w, i) => edition[i] === w)) return true;
  const said = new Set(edition);
  return lead.filter((w) => said.has(w)).length / lead.length >= ECHO_SHARE;
}

const PROSE_STATUSES = new Set(["written", "final"]);
const BRIEF_KINDS = new Set(["docs", "test"]);

const lines = (s: Pick<StoryRow, "insertions" | "deletions">) => s.insertions + s.deletions;

/** Heaviest first: the edition's own ranking inputs, importance then size. */
export const byWeight = (a: StoryRow, b: StoryRow) =>
  b.importance - a.importance || lines(b) - lines(a) || a.story_key.localeCompare(b.story_key);

/** The day as it happened: earliest landing first. */
const byLanding = (a: StoryRow, b: StoryRow) => a.last_at - b.last_at || a.story_key.localeCompare(b.story_key);

const shipKey = (s: Ship) => `${s.surface}|${s.sha}`;

/** The day's stories under the branch toggle. */
export function storiesOfDay(stories: readonly StoryRow[], date: string, branches: ChangesUrl["branches"]): StoryRow[] {
  return stories.filter((s) => s.date === date && (branches === "all" || s.on_default_branch));
}

/** Counts for the header, from the edition when it has them, else from the stories. */
export function dayStats(day: readonly StoryRow[], edition: EditionRow | undefined, releases: readonly Ship[]): EditionStats {
  if (edition?.stats) return edition.stats;
  const shas = new Set<string>();
  const people = new Set<string>();
  const sessions = new Set<string>();
  let privateSessions = 0;
  for (const s of day) {
    for (const sha of s.commit_shas) shas.add(sha);
    for (const a of s.author_names) people.add(a);
    for (const c of s.conversation_ids) sessions.add(String(c));
    privateSessions += s.private_session_count;
  }
  return { commits: shas.size, stories: day.length, releases: releases.length, people: people.size, sessions: sessions.size, private_sessions: privateSessions };
}

/** The stories waiting behind the latest ship of their surface (spec 4.2). */
export function waitingKeys(day: readonly StoryRow[], live: readonly LiveRow[]): Set<string> {
  const out = new Set<string>();
  for (const ship of live) for (const s of waitingStories(day, ship)) out.add(s.story_key);
  return out;
}

/** Whether a story matches the dimming filters: areas and a live tile's surface. */
export function inFocus(s: StoryRow, url: ChangesUrl): boolean {
  if (url.areas.length && !url.areas.includes(s.area)) return false;
  if (url.surface && !surfaceCoversArea(url.surface, s.area)) return false;
  return true;
}

/** Whether a story survives the hiding filters: person, risk, waiting, text. */
export function survives(s: StoryRow, url: ChangesUrl, waiting: Set<string>): boolean {
  if (url.person && !s.author_names.includes(url.person) && !s.actor_user_ids.some((id) => String(id) === url.person)) return false;
  if (url.risk && s.risks.length === 0) return false;
  if (url.waiting && !waiting.has(s.story_key)) return false;
  if (url.q) {
    const q = url.q.toLowerCase();
    const hay = [s.headline, s.dek, s.body ?? "", s.area, s.branch, ...s.author_names].join("\n").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Release stamps in a section: a ship of a surface covering the area, placed after the last row that landed before it. */
function withStamps(area: string, rows: readonly StoryRow[], releases: readonly Ship[]): SectionItem[] {
  const ships = releases.filter((r) => surfaceCoversArea(r.surface, area)).sort((a, b) => a.at - b.at || a.surface.localeCompare(b.surface));
  const items: SectionItem[] = [];
  let next = 0;
  for (const story of rows) {
    // A ship that lands before this row's work closes the rows above it. A
    // ship before the first row is about earlier work and is left out.
    while (next < ships.length && ships[next].at < story.last_at) {
      if (items.length) items.push({ kind: "stamp", ship: ships[next], key: `${area}|${shipKey(ships[next])}` });
      next += 1;
    }
    items.push({ kind: "story", story });
  }
  for (; next < ships.length; next += 1) {
    if (items.length) items.push({ kind: "stamp", ship: ships[next], key: `${area}|${shipKey(ships[next])}` });
  }
  return items;
}

/**
 * File touches and commits per area for the day: the ink bars of "Areas
 * today". A story counts its touches per area, not per commit, so a commit is
 * credited to an area only as far as the touches prove it: a one-commit
 * story's commit made every one of its touches, and a longer story put at
 * most one commit behind each touch. Never more than the distinct commits of
 * the stories that touched the area.
 */
export function areaTouches(day: readonly StoryRow[]): AreaTouch[] {
  const touches = new Map<string, number>();
  const exact = new Map<string, Set<string>>();
  const atMost = new Map<string, number>();
  const all = new Map<string, Set<string>>();
  const stories = new Map<string, number>();
  const setOf = (m: Map<string, Set<string>>, area: string) => {
    let set = m.get(area);
    if (!set) m.set(area, (set = new Set()));
    return set;
  };
  for (const s of day) {
    stories.set(s.area, (stories.get(s.area) ?? 0) + 1);
    for (const [area, n] of Object.entries(s.area_counts)) {
      touches.set(area, (touches.get(area) ?? 0) + n);
      for (const sha of s.commit_shas) setOf(all, area).add(sha);
      if (s.commit_shas.length === 1) setOf(exact, area).add(s.commit_shas[0]);
      else atMost.set(area, (atMost.get(area) ?? 0) + Math.min(n, s.commit_shas.length));
    }
  }
  return [...touches.entries()]
    .map(([area, n]) => ({
      area,
      touches: n,
      commits: Math.min(all.get(area)!.size, (exact.get(area)?.size ?? 0) + (atMost.get(area) ?? 0)),
      stories: stories.get(area) ?? 0,
    }))
    .sort((a, b) => b.touches - a.touches || a.area.localeCompare(b.area));
}

/**
 * The areas the filter offers: the areas the shown stories are filed under,
 * in the order of the touch bars, then by story count. An area that only
 * holds files inside other stories (a workflow edited in a web change) is no
 * chip, since choosing it would match nothing.
 */
export function filterAreas(stories: readonly StoryRow[], touches: readonly AreaTouch[]): string[] {
  const count = new Map<string, number>();
  for (const s of stories) count.set(s.area, (count.get(s.area) ?? 0) + 1);
  const rank = new Map(touches.map((a, i) => [a.area, i]));
  return [...count.keys()].sort((a, b) =>
    (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || count.get(b)! - count.get(a)! || a.localeCompare(b));
}

/** "Showing 3 of 9 stories (cli)" while a filter is on, else null. The day and the week say it the same way. */
export function showingLine(url: ChangesUrl, matching: number, total: number, personName: (id: string) => string = (id) => id): string | null {
  if (!hasFilters(url)) return null;
  return `Showing ${matching} of ${total} ${total === 1 ? "story" : "stories"} (${filterLabel(url, personName)})`;
}

function filterLabel(url: ChangesUrl, personName: (id: string) => string): string {
  const parts: string[] = [...url.areas];
  if (url.surface) parts.push(`${url.surface} surface`);
  if (url.person) parts.push(personName(url.person));
  if (url.risk) parts.push("risks");
  if (url.waiting) parts.push("waiting");
  if (url.q) parts.push(`"${url.q}"`);
  return parts.join(", ");
}

export function buildEdition(input: {
  stories: readonly StoryRow[];
  date: string;
  edition: EditionRow | undefined;
  live: readonly LiveRow[];
  url: ChangesUrl;
  personName?: (id: string) => string;
}): EditionModel {
  const { date, edition, live, url } = input;
  const day = storiesOfDay(input.stories, date, url.branches);
  const byKey = new Map(day.map((s) => [s.story_key, s]));
  const releases: Ship[] = edition?.releases ?? [];
  const stats = dayStats(day, edition, releases);
  const waiting = waitingKeys(day, live);

  // Lead: the edition's pick, else the heaviest story on the default branch.
  const ranked = [...day].sort(byWeight);
  const lead = (edition?.lead_story_key && byKey.get(edition.lead_story_key))
    || ranked.find((s) => s.on_default_branch && !BRIEF_KINDS.has(s.kind))
    || ranked[0]
    || null;

  // In brief: the edition's list, else docs, tests and anything ranked 1.
  const briefKeys = edition?.brief_story_keys
    ? new Set(edition.brief_story_keys)
    : new Set(day.filter((s) => BRIEF_KINDS.has(s.kind) || s.importance <= 1).map((s) => s.story_key));
  if (lead) briefKeys.delete(lead.story_key);

  const dimmed = new Set<string>();
  const hidden = new Set<string>();
  let matching = 0;
  for (const s of day) {
    const focus = inFocus(s, url);
    const keep = survives(s, url, waiting);
    if (!keep) hidden.add(s.story_key);
    else if (!focus) dimmed.add(s.story_key);
    if (focus && keep) matching += 1;
  }
  const visible = (s: StoryRow) => !hidden.has(s.story_key);

  // Sections: one block per area, the edition's order first, then by volume.
  const groups = new Map<string, StoryRow[]>();
  for (const s of day) {
    if (s === lead || briefKeys.has(s.story_key) || !visible(s)) continue;
    const g = groups.get(s.area) ?? [];
    g.push(s);
    groups.set(s.area, g);
  }
  const volume = new Map(areaTouches(day).map((a) => [a.area, a.touches]));
  const rank = new Map((edition?.section_order ?? []).map((a, i) => [a, i]));
  const areas = [...groups.keys()].sort((a, b) =>
    (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || (volume.get(b) ?? 0) - (volume.get(a) ?? 0) || a.localeCompare(b));
  const sections: Section[] = areas.map((area) => {
    const rows = groups.get(area)!.sort(byLanding);
    return { area, items: withStamps(area, rows, releases), count: rows.length, dimmed: rows.every((s) => dimmed.has(s.story_key)) };
  });

  const brief = ranked.filter((s) => briefKeys.has(s.story_key) && visible(s)).sort(byLanding);
  const leadShown = lead && visible(lead) ? lead : null;

  const walkable = (s: StoryRow) => !dimmed.has(s.story_key);
  const order = [
    ...(leadShown && walkable(leadShown) ? [leadShown.story_key] : []),
    ...sections.flatMap((sec) => sec.items.flatMap((i) => (i.kind === "story" && walkable(i.story) ? [i.story.story_key] : []))),
    ...brief.filter(walkable).map((s) => s.story_key),
  ];

  const prose = !!edition?.headline && PROSE_STATUSES.has(edition.status ?? "");
  return {
    day,
    lead: leadShown,
    sections,
    brief,
    order,
    dimmed,
    waiting,
    matching,
    stats,
    headline: prose ? edition!.headline! : statsHeadline(stats),
    prose,
    standfirst: prose && edition!.narrative.trim() ? edition!.narrative.trim() : null,
    releases,
    areas: areaTouches(day),
    filterLine: showingLine(url, matching, day.length, input.personName),
    // Only prose can repeat a story; the counts headline never does.
    leadEchoesHeadline: prose && !!leadShown && echoesHeadline(leadShown.headline, edition!.headline!),
  };
}

/** Commits per day for the date strip's ink: the edition's count, else the stories'. */
export function dayVolumes(stories: readonly StoryRow[], editions: readonly EditionRow[], days: readonly string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const d of days) {
    const ed = editions.find((e) => e.date === d);
    if (ed?.stats) { out[d] = ed.stats.commits; continue; }
    const shas = new Set<string>();
    let seen = false;
    for (const s of stories) {
      if (s.date !== d || !s.on_default_branch) continue;
      seen = true;
      for (const sha of s.commit_shas) shas.add(sha);
    }
    out[d] = seen || ed ? shas.size : null;
  }
  return out;
}

/**
 * Whether a day or week with no stories in the store still waits for them
 * (the skeleton) rather than saying "Nothing landed". The claim waits for the
 * stories feed to answer, unless every one of the view's days has a cached
 * edition that already says nothing landed. Editions reach the store before
 * their stories, so an edition that counts stories never stands in for them.
 */
export function awaitsStories(storyCount: number, ready: boolean, editions: ReadonlyArray<EditionRow | undefined>): boolean {
  if (storyCount > 0 || ready) return false;
  return !(editions.length > 0 && editions.every((e) => e?.stats?.stories === 0));
}

/** Where `j`/`k` lands from `current`, wrapping at neither end. */
export function stepOrder(order: readonly string[], current: string | null | undefined, delta: number): string | null {
  if (!order.length) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return delta > 0 ? order[0] : order[order.length - 1];
  return order[Math.max(0, Math.min(order.length - 1, at + delta))];
}
