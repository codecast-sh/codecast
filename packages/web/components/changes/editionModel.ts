// What the Changes timeline reads about stories and editions, worked out from
// store rows: weight order, the filters, the people behind stories, whether
// an edition has prose, and a story's risks as text. Pure.
import { bareName, personKey, type ShipEvent } from "@codecast/shared/changes";
import type { EditionRow, StoryRow } from "../../hooks/useSyncChanges";
import type { RosterIdentity } from "../../hooks/useTeamRoster";
import { addDays } from "@codecast/convex/convex/lib/teamDay";
import { memberDisplayName } from "../../lib/liveEntities";
import type { ChangesUrl } from "./useChangesUrlState";

export type Ship = Pick<ShipEvent, "surface" | "version" | "sha" | "at">;

/** One area's ink bar: its file touches, the commits that made them, and the stories filed under it. */
export type AreaTouch = { area: string; touches: number; commits: number; stories: number };

/**
 * One human behind the stories: keyed by personKey, named from the roster when
 * a member matches, with every roster id and author name that is them.
 */
export type Person = { key: string; name: string; userIds: string[]; authorNames: string[] };

/** Edition statuses whose headline and narrative are written prose, not the stats line. */
export const PROSE_STATUSES = new Set(["written", "final"]);

/** Whether an edition (day or week) has written prose to show. */
export const hasProse = (e: Pick<EditionRow, "headline" | "status" | "scope"> | undefined) => !!e?.headline && PROSE_STATUSES.has(e.status ?? "");

const lines = (s: Pick<StoryRow, "insertions" | "deletions">) => s.insertions + s.deletions;

/** Heaviest first: the edition's own ranking inputs, importance then size. */
export const byWeight = (a: StoryRow, b: StoryRow) =>
  b.importance - a.importance || lines(b) - lines(a) || a.story_key.localeCompare(b.story_key);

/**
 * The people behind some stories, one per personKey. A session owner is
 * named from the roster, and a commit author is matched to a member by
 * lowercased name, so one human's session stories and commit-only stories
 * are one person. Blank names are skipped. Sorted by name.
 */
export function peopleOf(stories: readonly Pick<StoryRow, "actor_user_ids" | "author_names">[], roster: readonly RosterIdentity[] = []): Person[] {
  const byId = new Map(roster.map((m) => [String(m._id), m]));
  const byName = new Map<string, RosterIdentity>();
  for (const m of roster) if (m.name?.trim() && !byName.has(personKey(m.name))) byName.set(personKey(m.name), m);
  const out = new Map<string, Person>();
  const at = (key: string, name: string) => {
    let p = out.get(key);
    if (!p) out.set(key, (p = { key, name, userIds: [], authorNames: [] }));
    return p;
  };
  const addId = (p: Person, id: string) => void (p.userIds.includes(id) || p.userIds.push(id));
  for (const s of stories) {
    for (const raw of s.actor_user_ids) {
      const m = byId.get(String(raw));
      const name = m ? memberDisplayName(m, "").trim() : "";
      if (!name) continue;
      addId(at(personKey(name), name), String(raw));
    }
    for (const author of s.author_names) {
      const key = personKey(author);
      if (!key) continue;
      const m = byName.get(key);
      const p = at(key, m ? memberDisplayName(m) : bareName(author));
      if (m) addId(p, String(m._id));
      if (!p.authorNames.includes(author)) p.authorNames.push(author);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/**
 * The person a `person=` value names: a person key, or a roster id from an
 * older link. Someone not among `people` still filters by the value itself.
 */
export function personFor(value: string, people: readonly Person[]): Person {
  return people.find((p) => p.key === value || p.userIds.includes(value))
    ?? { key: personKey(value), name: value, userIds: [value], authorNames: [] };
}

/** Whether a story is by a person: one of its authors is them by name, or one of its sessions is theirs. */
export function storyIsBy(s: Pick<StoryRow, "actor_user_ids" | "author_names">, person: Person): boolean {
  return s.author_names.some((a) => personKey(a) === person.key) || s.actor_user_ids.some((id) => person.userIds.includes(String(id)));
}

export function inFocus(s: StoryRow, url: ChangesUrl): boolean {
  return !url.areas.length || url.areas.includes(s.area);
}

/** Whether a story survives the hiding filters: person, risk, text. `person` is who `url.person` names. */
export function survives(s: StoryRow, url: ChangesUrl, person: Person | null = null): boolean {
  if (url.person && !storyIsBy(s, person ?? personFor(url.person, []))) return false;
  if (url.risk && s.risks.length === 0) return false;
  if (url.q) {
    const q = url.q.toLowerCase();
    const hay = [s.headline, s.dek, s.body ?? "", s.area, s.branch, ...s.author_names].join("\n").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/**
 * Whether notes can still arrive for a day: it is today or yesterday (the
 * days the scheduler still writes), and its edition is neither capped by the
 * spending limit nor failed. The header's "notes updating" and every pending
 * story's bar read this one answer (StoryContext.proseLive), so a day whose
 * notes will never come never shimmers.
 */
export function notesCanArrive(date: string, today: string, edition: Pick<EditionRow, "capped_at" | "status"> | undefined): boolean {
  return date >= addDays(today, -1) && !edition?.capped_at && edition?.status !== "failed";
}

const FULL_SHA = /\b[0-9a-f]{40}\b/gi;
const basename = (item: string) => item.split("/").pop() || item;

/**
 * Every risk on a story as text, one per line (or `sep`). A risk the prose
 * worded is its line alone: the line already says what the evidence shows.
 * One it did not is its code with its evidence, full commit hashes cut to
 * seven characters, and an item left out when its file name is already in
 * the text (two paths to one schema.ts). At most four items, then "...".
 */
export function riskText(story: Pick<StoryRow, "risks" | "risk_lines">, sep = "\n"): string {
  return story.risks
    .map((r) => {
      const line = story.risk_lines?.[r.code]?.trim();
      if (line) return line;
      let text = r.code;
      const kept: string[] = [];
      for (const raw of r.evidence) {
        const item = raw.replace(FULL_SHA, (sha) => sha.slice(0, 7));
        if (text.includes(basename(item))) continue;
        kept.push(item);
        text += ` ${item}`;
      }
      if (!kept.length) return r.code;
      return `${r.code} (${kept.slice(0, 4).join(", ")}${kept.length > 4 ? ", ..." : ""})`;
    })
    .join(sep);
}

/** The name a `person=` value shows under: the person it names on screen, else the page's fallback. */
export function nameOfPerson(people: readonly Person[], fallback: (id: string) => string = (id) => id): (id: string) => string {
  return (id) => people.find((p) => p.key === id || p.userIds.includes(id))?.name ?? fallback(id);
}
