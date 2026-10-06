// Versions are numbered 1..n per app with no gaps, appended and never edited.
import { VERSION_SUMMARY_MAX } from "./limits";

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
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > VERSION_SUMMARY_MAX ? `${s.slice(0, VERSION_SUMMARY_MAX - 1).trimEnd()}…` : s;
}
