// Versions are numbered 1..n per app with no gaps, appended and never edited.
import { VERSION_SUMMARY_MAX } from "./limits";
import { clipLine } from "./text";

export const VERSION_KINDS = ["seed", "build", "restore", "fork"] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

/** The number the next appended version takes, given how many the app has. */
export function nextVersionNumber(versionCount: number): number {
  if (!Number.isInteger(versionCount) || versionCount < 0) throw new Error(`bad version count ${versionCount}`);
  return versionCount + 1;
}

/** "v12", "V12" or "12" as a version number; null for anything else. */
export function parseVersionNumber(raw: string): number | null {
  const m = /^v?(\d{1,6})$/i.exec(raw.trim());
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 ? n : null;
}

/** A one-line summary as the timeline shows it. */
export function cleanSummary(raw: string): string {
  return clipLine(raw, VERSION_SUMMARY_MAX);
}

/** A restore of exactly what the live version was built on undoes that
 *  version; any other restore brings an older version back. Returns the
 *  version undone, or null. A restore undone is a redo, said as bringing back. */
export function undoneBy(live: { number: number; kind: VersionKind; parent_number?: number | null }, restoring: number): number | null {
  return live.kind === "build" && live.parent_number === restoring ? live.number : null;
}

/** What a restore did, the way people say it: "undid v7", "brought back v3". */
export function restoreVerb(r: { undid: number | null; from: number }): string {
  return r.undid !== null ? `undid v${r.undid}` : `brought back v${r.from}`;
}

/** A restore's own one-line summary: what it took out, or whose files it
 *  brought back, so the timeline, the gallery and the builder's history read
 *  what really changed. */
export function restoreSummary(undone: { number: number; summary: string } | null, from: { summary: string }): string {
  return cleanSummary(undone ? `Undid v${undone.number}: ${undone.summary}` : from.summary);
}

/** What a version did, said after its author's name wherever Clayground
 *  tells what happened (the home feed, gallery tiles): "made it", "turns
 *  the background blue", "undid v7: turns the background blue", "forked it
 *  from Night Sky". A first build made the app; any other build is its own
 *  summary, so no line needs a bare version number. */
export function versionSaid(
  v: { kind: VersionKind; summary: string; parent_number?: number | null; source?: { version: number } | null; undid?: number | null },
  forkedFrom: string | null,
): string {
  if (v.kind === "fork") return forkedFrom ? `forked it from ${forkedFrom}` : "forked it";
  if (v.kind === "seed") return "started it";
  if (v.kind === "restore") return v.undid ? lowerFirst(v.summary) : `brought back v${v.source?.version ?? "?"}`;
  return v.parent_number ? lowerFirst(v.summary) : "made it";
}

/** "Turns it blue" reads "turns it blue" mid-sentence; "SVG frogs" stays. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}
