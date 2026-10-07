// How a version is said wherever a line names who made it: the toast, the
// restore card, the folded row, the peek. A build says its own summary; a
// restore says what it undid or brought back, with that version's summary,
// so an undo is never credited with the change it took out.
import { restoreSummary, restoreVerb, undoneBy } from "../../convex/lib/versions";
import type { TimelineEntry } from "../../convex/versions";

export type VersionLine = {
  /** "undid v7", "brought back v3", or null for a build. */
  verb: string | null;
  /** The version the verb is about (a restore's), else this one. */
  about: number;
  summary: string;
};

/** The version a restore undid. Restores made before the server recorded it
 *  are judged by the same rule from the timeline. */
export function undidBy(e: TimelineEntry | undefined, byNumber: Map<number, TimelineEntry>): number | null {
  if (!e || e.kind !== "restore" || !e.source) return null;
  if (e.undid !== null) return e.undid;
  const before = e.parent_number != null ? byNumber.get(e.parent_number) : undefined;
  return before ? undoneBy(before, e.source.version) : null;
}

/** The one-click way back from a live version: an undo brings back what it
 *  undid; anything else returns to the version it was made from. Null for a
 *  first version. */
export function reverseOf(e: TimelineEntry, byNumber: Map<number, TimelineEntry>): { target: number; label: string; busyLabel: string } | null {
  const undid = undidBy(e, byNumber);
  if (undid !== null) return { target: undid, label: `Bring back v${undid}`, busyLabel: "Bringing back" };
  return e.parent_number === null ? null : { target: e.parent_number, label: "Undo", busyLabel: "Undoing" };
}

/** A version's summary as one line: a build says what it did, a restore says
 *  it with its verb ("Undid v7: …", "Brought back v2: …") so it is never read
 *  as a fresh change by whoever restored it. */
export function versionSummary(e: TimelineEntry, byNumber: Map<number, TimelineEntry>): string {
  const line = versionLine(e, byNumber);
  if (!line.verb) return e.summary;
  const about = byNumber.get(line.about);
  // Past the loaded timeline, an undo's own summary already says it in full.
  if (!about) return e.undid !== null ? e.summary : `${upperFirst(line.verb)}: ${e.summary}`;
  return line.verb.startsWith("undid") ? restoreSummary(about, e) : `${upperFirst(line.verb)}: ${about.summary}`;
}

const upperFirst = (s: string) => s[0].toUpperCase() + s.slice(1);

/** What making `n` live does, said before anyone does it: "Everyone sees v3.
 *  Takes out v4 to v6: {v6's summary}". */
export function makeLiveSays(n: number, live: number, byNumber: Map<number, TimelineEntry>): string {
  const latest = byNumber.get(live);
  const range = live === n + 1 ? `v${live}` : `v${n + 1} to v${live}`;
  return `Everyone sees v${n}. Takes out ${range}${latest ? `: ${versionSummary(latest, byNumber)}` : ""}`;
}

export function versionLine(e: TimelineEntry, byNumber: Map<number, TimelineEntry>): VersionLine {
  if (e.kind !== "restore" || !e.source) return { verb: null, about: e.number, summary: e.summary };
  const undid = undidBy(e, byNumber);
  const about = undid ?? e.source.version;
  return { verb: restoreVerb({ undid, from: e.source.version }), about, summary: byNumber.get(about)?.summary ?? e.summary };
}

type Who = { id: string; name: string } | null | undefined;

/** "Peak", or "You" for the person reading. */
export const nameFor = (who: Who, meId: string) => (who?.id === meId ? "You" : (who?.name ?? "Someone"));

/** Whose a version was, said beside another person's act on it: "Ziggy's
 *  v7", "your v7", or plain "v7" when it was the actor's own. */
export function whoseVersion(n: number, author: Who, actor: Who, meId: string): string {
  if (!author || author.id === actor?.id) return `v${n}`;
  return author.id === meId ? `your v${n}` : `${author.name}'s v${n}`;
}

/** A restore said in full: "Peak undid Ziggy's v7", "You brought back v3". */
export function restoreSaid(
  r: { by: Who; version: number; undid: number | null; from_version: number },
  byNumber: Map<number, TimelineEntry>,
  meId: string,
): string {
  const undid = r.undid ?? undidBy(byNumber.get(r.version), byNumber);
  const about = undid ?? r.from_version;
  const verb = undid !== null ? "undid" : "brought back";
  return `${nameFor(r.by, meId)} ${verb} ${whoseVersion(about, byNumber.get(about)?.author, r.by, meId)}`;
}
