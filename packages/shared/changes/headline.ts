// The deterministic text every story and edition has before any prose arrives
// (docs/proposals/changes-page.md rule 1, 4.3, 7.1 output). Built only from
// commit subjects and counts, so it is free, instant and never wrong about
// what landed.
import { parseConventional } from "./classify";

export const HEADLINE_MAX = 90;
export const DEK_MAX = 160;

/** Cut at a word boundary to fit `max` chars, marking the cut with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** Where a sentence can stop and still be a whole thought. */
const CLAUSE_BREAKS = [", ", "; ", " and ", " while ", " with "];

/**
 * Model prose held to a length without an ellipsis. Text within `hard` chars
 * stays whole, since a headline a little over its target reads better than a
 * cut one. Past `hard` it is cut back to the last clause boundary that keeps
 * at least 60% of `max`, and ends there as a complete clause; a cut
 * mid-clause can invert the meaning ("stops emailing people never..."). Only
 * text with no boundary at all falls back to `clip`.
 */
export function fitProse(text: string, max: number, hard: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= hard) return t;
  const head = t.slice(0, hard + 1);
  const at = Math.max(...CLAUSE_BREAKS.map((b) => head.lastIndexOf(b)));
  return at >= max * 0.6 ? t.slice(0, at).replace(/[\s,;:]+$/, "") : clip(t, max);
}

/** Tools whose names are written in lowercase; a subject leading with one keeps it. */
const LOWERCASE_NAMES = new Set(["npm", "npx", "pnpm", "bunx", "gh", "tmux", "iterm", "eas", "cast"]);

/** Capitalize a plain leading word only: `jx7c6zk`, `#412`, `cast_check`, `foo.ts` and `npm` stay verbatim. */
const capitalize = (s: string) => {
  const m = /^([a-z][a-z'-]*)(?:[\s,;:!?)]|$)/.exec(s);
  return m && !LOWERCASE_NAMES.has(m[1]) ? s[0].toUpperCase() + s.slice(1) : s;
};

const GIT_REVERT = /^Revert\s+"(.+)"\s*$/;

/**
 * A commit subject as a headline: conventional prefix stripped, whitespace
 * folded, trailing period dropped, a plain first word capitalized. A revert keeps
 * its word and cleans what it reverts. Short ids (`jx7c6zk`, `#412`) pass
 * through untouched.
 */
export function cleanSubject(subject: string): string {
  const s = subject.replace(/\s+/g, " ").trim();
  const git = GIT_REVERT.exec(s);
  if (git) return `Revert "${cleanSubject(git[1])}"`;
  const conv = parseConventional(s);
  if (conv?.type === "revert") return `Revert "${cleanSubject(conv.description)}"`;
  const text = (conv ? conv.description : s).replace(/\.+$/, "").trim();
  return capitalize(text);
}

/** One commit's share of a story: the whole commit, or its slice of one area. */
export type HeadlineUnit = { sha: string; subject: string; timestamp: number; lines: number };

/** Largest first; ties go to the earlier commit, then the sha, so the pick never flips. */
function byWeight(a: HeadlineUnit, b: HeadlineUnit): number {
  return b.lines - a.lines || a.timestamp - b.timestamp || a.sha.localeCompare(b.sha);
}

/** The cleaned subject of the story's largest commit. */
export function storyHeadline(units: readonly HeadlineUnit[]): string {
  const top = [...units].sort(byWeight)[0];
  return top ? clip(cleanSubject(top.subject), HEADLINE_MAX) : "";
}

/**
 * The other subjects, cleaned, deduped and joined in time order. A story of
 * one commit falls back to the first paragraph of its body.
 */
export function storyDek(units: readonly HeadlineUnit[], body?: string): string {
  const top = [...units].sort(byWeight)[0];
  if (!top) return "";
  const headline = cleanSubject(top.subject);
  const seen = new Set([headline]);
  const others: string[] = [];
  for (const u of [...units].sort((a, b) => a.timestamp - b.timestamp || a.sha.localeCompare(b.sha))) {
    const c = cleanSubject(u.subject);
    if (seen.has(c)) continue;
    seen.add(c);
    others.push(c);
  }
  if (others.length) return clip(others.join("; "), DEK_MAX);
  const para = body?.split(/\n\s*\n/)[0]?.trim();
  return para ? clip(para, DEK_MAX) : "";
}

/** The facts of a batch commit's leftover slices, for a story made of nothing else. */
export function sliceDek(areaCounts: Record<string, number>): string {
  const areas = Object.entries(areaCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const files = areas.reduce((n, [, c]) => n + c, 0);
  return clip(`${files} ${files === 1 ? "file" : "files"} across ${areas.map(([a]) => a).join(", ")}`, DEK_MAX);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The edition headline before prose: the day's counts in large type (spec 4.3). */
export function statsHeadline(stats: { commits: number; stories: number; releases: number }): string {
  const parts = [plural(stats.commits, "commit")];
  if (stats.releases) parts.push(plural(stats.releases, "release"));
  parts.push(plural(stats.stories, "story", "stories"));
  return parts.join(", ");
}
