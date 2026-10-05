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
  /** The sentence, without the date and without the source mark. */
  text: string;
  /** The day the role wrote it, as written (YYYY-MM-DD), or null. */
  written_on: string | null;
  /** The same day as a timestamp (UTC midnight), or null. */
  written_at: number | null;
  /** The role the line came from when it was copied in by a handoff
   *  (org-staffing.md S32): its handle, without the @. Null for the role's
   *  own words. */
  from: string | null;
  /** The line as written. */
  raw: string;
};

export const STANDING_HEADING = /^#{1,6}\s*Where it stands\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const LIST_LINE = /^(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
export const TRAILING_DATE = /\s*\(?\s*(\d{4}-\d{2}-\d{2})\s*\)?\s*$/;

/** A list line without its bullet, or null for any other line. */
export const listItem = (line: string): string | null => line.trim().match(LIST_LINE)?.[1] ?? null;

/** A day as written (YYYY-MM-DD) at UTC midnight, or null when it is no date. */
export function dayAt(day: string): number | null {
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) ? null : at;
}

/** Every line under a heading, as written, in order. The section ends at the
 *  next heading of any level; a brief that repeats the heading reads as one
 *  section. The playbook's sections (rolePlaybook.ts) read through here too. */
export function sectionRows(narrative: string | null | undefined, heading: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of (narrative ?? "").split("\n")) {
    if (heading.test(line)) { inside = true; continue; }
    if (ANY_HEADING.test(line)) { inside = false; continue; }
    if (inside) out.push(line);
  }
  return out;
}
const DATE_AFTER_NAME = /\s*[(,]\s*(\d{4}-\d{2}-\d{2})\s*\)?\s*$/;
// The source mark a handoff writes at the end of a copied line, before the
// date: "(from @growth)". Read off the text so the sentence stays clean.
const TRAILING_FROM = /\s*\(from @([a-z0-9-]{2,32})\)\s*$/i;

/** A line's age matters past this: the panel says how old it is, the frame
 *  marks it. */
export const STANDING_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const strip = (s: string) => s.replace(/^\*\*(.+?)\*\*$/, "$1").replace(/^`(.+?)`$/, "$1").trim();

export function parseStandingLine(line: string): StandingLine | null {
  const raw = listItem(line);
  if (raw === null) return null;
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  let project = strip(raw.slice(0, colon));
  let rest = raw.slice(colon + 1).trim();
  let written_on: string | null = null;
  let written_at: number | null = null;
  const take = (text: string, re: RegExp): string => {
    const m = text.match(re);
    if (!m) return text;
    const at = dayAt(m[1]);
    if (at === null) return text;
    written_on = m[1]; written_at = at;
    return text.slice(0, m.index).trim();
  };
  rest = take(rest, TRAILING_DATE);
  if (written_on === null) project = strip(take(project, DATE_AFTER_NAME));
  let from: string | null = null;
  const src = rest.match(TRAILING_FROM);
  if (src) { from = src[1].toLowerCase(); rest = rest.slice(0, src.index).trim(); }
  if (!project || !rest) return null;
  return { project, text: rest, written_on, written_at, from, raw };
}

/** A standing line as a handoff copies it into the receiving role's brief
 *  (org-staffing.md S30): the outgoing role's sentence, marked with where it
 *  came from, dated the day it was written so its age carries over. */
export function standingLineFrom(line: StandingLine, fromHandle: string): string {
  const date = line.written_on ? ` (${line.written_on})` : "";
  return `- ${line.project}: ${line.text} (from @${fromHandle.replace(/^@/, "")})${date}`;
}

/** `narrative` with `lines` added under its "Where it stands" section, which
 *  is created at the end when the brief has none. A line for a project the
 *  section already names is skipped: the receiver's own word stands. */
export function withStandingLines(narrative: string | null | undefined, lines: string[]): string {
  const text = (narrative ?? "").replace(/\s+$/, "");
  const have = parseStandingSection(text);
  const fresh = lines.filter((l) => { const p = parseStandingLine(l); return p && !have.some((h) => norm(h.project) === norm(p.project)); });
  if (!fresh.length) return text;
  const rows = text.split("\n");
  const head = rows.findIndex((l) => STANDING_HEADING.test(l));
  if (head < 0) return [text, "", "## Where it stands", ...fresh].filter((l, i, a) => !(i === 0 && l === "" && a.length > 1)).join("\n");
  let end = head + 1;
  while (end < rows.length && !ANY_HEADING.test(rows[end])) end++;
  // Insert before the blank lines that close the section, so the list stays one list.
  let at = end;
  while (at > head + 1 && rows[at - 1].trim() === "") at--;
  return [...rows.slice(0, at), ...fresh, ...rows.slice(at)].join("\n");
}

/** Every line under the section, in the order written. The section ends at
 *  the next heading of any level. */
export function parseStandingSection(narrative: string | null | undefined): StandingLine[] {
  return sectionRows(narrative, STANDING_HEADING).flatMap((line) => parseStandingLine(line) ?? []);
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

/** The projects the role has written a line about, each with its line, in
 *  the scope's order. A project with no line is left out: an empty line tells
 *  a reader nothing. */
export function projectsWithLines<P extends { title: string; short_id?: string | null }>(lines: StandingLine[], projects: P[]): Array<{ project: P; line: StandingLine }> {
  return projects.flatMap((project) => {
    const line = standingLineFor(lines, project);
    return line ? [{ project, line }] : [];
  });
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
