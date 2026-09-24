// Where a role's projects stand, as the role keeps it in its brief
// (docs/architecture/scopes-and-feed.md F5.2). One section, one line per
// project in the role's scope, in the role's own words:
//
//   ## Where it stands
//   - Union goals: two markets filled this week; the third waits on a lawyer. (2026-09-23)
//   - Growth: no pages shipped since the redesign started; the copy is with Ada. (2026-09-16)
//
// The project is what comes before the first colon, matched to a project by
// its title or its short id. The date in parentheses is the day the role
// wrote the sentence, at the end of the line or right after the project's
// name (roles write both); it is the only clock the line has, so the frame
// and the panel both read a line's age from it. A line with no date has no
// age.
//
// One parser for the wake frame, the Scope tab and the phone, so every
// surface reads the same sentences and says "no word yet" the same way.

export type StandingLine = {
  /** The project as the role wrote it: a title or a short id. */
  project: string;
  /** The sentence, without the date. */
  text: string;
  /** The day the role wrote it, as written (YYYY-MM-DD), or null. */
  written_on: string | null;
  /** The same day as a timestamp (UTC midnight), or null. */
  written_at: number | null;
  /** The line as written. */
  raw: string;
};

export const STANDING_HEADING = /^#{1,6}\s*Where it stands\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const LIST_LINE = /^(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const TRAILING_DATE = /\s*\(?\s*(\d{4}-\d{2}-\d{2})\s*\)?\s*$/;
const DATE_AFTER_NAME = /\s*[(,]\s*(\d{4}-\d{2}-\d{2})\s*\)?\s*$/;

/** A line's age matters past this: the panel says how old it is, the frame
 *  marks it. */
export const STANDING_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const strip = (s: string) => s.replace(/^\*\*(.+?)\*\*$/, "$1").replace(/^`(.+?)`$/, "$1").trim();

export function parseStandingLine(line: string): StandingLine | null {
  const m = line.trim().match(LIST_LINE);
  if (!m) return null;
  const raw = m[1];
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  let project = strip(raw.slice(0, colon));
  let rest = raw.slice(colon + 1).trim();
  let written_on: string | null = null;
  let written_at: number | null = null;
  const take = (text: string, re: RegExp): string => {
    const m = text.match(re);
    if (!m) return text;
    const at = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(at)) return text;
    written_on = m[1]; written_at = at;
    return text.slice(0, m.index).trim();
  };
  rest = take(rest, TRAILING_DATE);
  if (written_on === null) project = strip(take(project, DATE_AFTER_NAME));
  if (!project || !rest) return null;
  return { project, text: rest, written_on, written_at, raw };
}

/** Every line under the section, in the order written. The section ends at
 *  the next heading of any level. */
export function parseStandingSection(narrative: string | null | undefined): StandingLine[] {
  const out: StandingLine[] = [];
  let inside = false;
  for (const line of (narrative ?? "").split("\n")) {
    if (STANDING_HEADING.test(line)) { inside = true; continue; }
    if (ANY_HEADING.test(line)) { inside = false; continue; }
    if (!inside) continue;
    const parsed = parseStandingLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The line the role wrote for a project: by short id, else by title. A
 *  title match is whole and case blind, so "growth" finds "Growth" and not
 *  "Growth review". */
export function standingLineFor(lines: StandingLine[], project: { title: string; short_id?: string | null }): StandingLine | null {
  const id = project.short_id ? norm(project.short_id) : null;
  const title = norm(project.title);
  return lines.find((l) => {
    const p = norm(l.project);
    return (id && (p === id || p.startsWith(id + " ") || p.endsWith(" " + id))) || p === title;
  }) ?? null;
}

/** The words a surface shows for a project the role has not written about. */
export function noWordYet(handle: string): string {
  return `no word from @${handle} yet`;
}

/** A line's age in whole days, or null when the line carries no date. */
export function standingLineAgeDays(line: StandingLine, now: number): number | null {
  return line.written_at === null ? null : Math.max(0, Math.floor((now - line.written_at) / 86_400_000));
}

/** True when the line is old enough that a reader should know. */
export function standingLineStale(line: StandingLine, now: number): boolean {
  return line.written_at !== null && now - line.written_at > STANDING_STALE_MS;
}

/** The section as the role should write it, for a role that has none yet. */
export function standingSectionTemplate(projects: Array<{ title: string }>, today: string): string {
  return ["## Where it stands", ...projects.map((p) => `- ${p.title}: <what moved, what is stuck, what it waits for> (${today})`)].join("\n");
}
