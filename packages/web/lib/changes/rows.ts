// A repository's changes as the grid and the chip draw them (docs/architecture/changes.md CH4):
// each change's row, the one action a person can take on it, and the groups by who acts next.
import type { ChangeTone, Lifecycle } from "./lifecycle";
import type { RepoChange } from "../../hooks/useRepoChanges";

/** Where a chip and its journey lead, and the one thing a person can do now. */
export type ChangeLinks = {
  action?: { label: string; href?: string; onClick?: () => void } | null;
  href?: string | null;
  pr?: { label: string; href: string } | null;
  run?: { label: string; href: string } | null;
  deploys?: ReadonlyArray<{ label: string; href: string }>;
};

export type ChangeRow = {
  key: string;
  lifecycle: Lifecycle;
  links?: ChangeLinks;
  writers?: ReadonlyArray<{ title: string | null; state: string; href?: string | null }>;
  /** Where it lives, beside its writers: `worktree`, a device's name. */
  where?: string | null;
  updated_at?: number | null;
  /** A landed change's `owner/repo#N` or `owner/repo@sha`: its row feeds the reach the grid reads back. */
  reach_ref?: string | null;
};

/** The one thing a person can do about a change now, as a link to where it is done. */
export function changeAction(c: RepoChange): ChangeLinks["action"] {
  const n = c.lifecycle.now;
  const writer = c.writers.find((w) => w.href);
  if (n.stage === "work" && n.state === "waiting" && writer) return { label: writer.title ? `Ship from ${writer.title}` : "Ship from its session", href: writer.href! };
  if (n.tone === "blue" && c.links.pr) return { label: "Open the pull request", href: c.links.pr };
  if (n.tone === "red" && n.stage === "deploy" && c.links.deploys[0]) return { label: `Open ${c.links.deploys[0].id}`, href: c.links.deploys[0].href };
  if (n.tone === "red" && c.links.pr) return { label: "See the failing check", href: `${c.links.pr}?tab=checks` };
  if (n.stage === "live" && n.state === "back" && c.links.deploys[0]) return { label: `Open ${c.links.deploys[0].id}`, href: c.links.deploys[0].href };
  return null;
}

/** A repository's change as the grid and the chip draw it. */
export function changeRowOf(c: RepoChange): ChangeRow {
  return {
    key: c.key,
    lifecycle: c.lifecycle,
    links: {
      href: c.links.href,
      pr: c.links.pr && c.refs.pr ? { label: `#${c.refs.pr}`, href: c.links.pr } : null,
      deploys: c.links.deploys.map((d) => ({ label: d.id, href: d.href })),
      action: changeAction(c),
    },
    writers: c.writers.map((w) => ({ title: w.title, state: w.state, href: w.href })),
    where: c.where,
    updated_at: c.updated_at,
    reach_ref: c.reach_ref,
  };
}

/** Who acts next, in the order a reader should look. Quiet and Closed start folded. */
const GROUPS: ReadonlyArray<{ id: string; label: string; tone: ChangeTone; tones: ReadonlyArray<ChangeTone>; folded?: true }> = [
  { id: "you", label: "Needs you", tone: "blue", tones: ["red", "blue"] },
  { id: "moving", label: "Moving", tone: "yellow", tones: ["yellow", "orange"] },
  { id: "waiting", label: "Waiting", tone: "muted", tones: ["muted"] },
  { id: "live", label: "Live", tone: "green", tones: ["green"] },
  { id: "quiet", label: "Quiet", tone: "dim", tones: [], folded: true },
  { id: "closed", label: "Closed", tone: "dim", tones: ["dim"], folded: true },
];

/** Nobody has touched a change in this long: it is not on its way anywhere until someone does. */
export const QUIET_AFTER_MS = 3 * 24 * 60 * 60_000;

/** Within a group, failures before a person's turn, then the newest first. */
const TONE_RANK: Record<ChangeTone, number> = { red: 0, blue: 1, orange: 2, yellow: 3, muted: 4, green: 5, dim: 6 };

/** A rollback is nobody's work in progress: it waits on a person to fix forward or ship again. */
export const groupTone = (l: Lifecycle): ChangeTone => (l.now.stage === "live" && l.now.state === "back" ? "red" : l.now.tone);

/**
 * Whether a change has gone quiet at `now`: not yet on main, not in motion, nobody's turn, and nobody's work touched it in
 * QUIET_AFTER_MS (or ever, as far as anything reports). A landed change never goes quiet: where it stands in
 * production always matters.
 */
export function isQuiet(r: ChangeRow, now: number): boolean {
  const n = r.lifecycle.now;
  // A person's turn and a failure wait on someone: their age is the reason to look, never a reason to fold them away.
  if (r.reach_ref || n.state === "active" || n.state === "stopped" || n.tone === "blue" || n.tone === "red") return false;
  return !r.updated_at || now - r.updated_at > QUIET_AFTER_MS;
}

export function groupChanges(rows: ReadonlyArray<ChangeRow>, now: number) {
  return GROUPS.map((g) => ({
    ...g,
    rows: rows
      .filter((r) => (g.id === "quiet" ? isQuiet(r, now) : !isQuiet(r, now) && g.tones.includes(groupTone(r.lifecycle))))
      .sort((a, b) => TONE_RANK[a.lifecycle.now.tone] - TONE_RANK[b.lifecycle.now.tone] || (b.updated_at ?? 0) - (a.updated_at ?? 0)),
  })).filter((g) => g.rows.length);
}

/** How many landed changes a grid keeps (and reads the deploys of), freshest first: older ones are done and only noise. */
export const LANDED_SHOWN = 30;

/** A grid's rows: everything not yet on main, and the freshest landed changes. */
export function boardRows(rows: ReadonlyArray<ChangeRow>): ChangeRow[] {
  const landed = rows.filter((r) => r.reach_ref).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, LANDED_SHOWN);
  const keep = new Set(landed);
  return rows.filter((r) => !r.reach_ref || keep.has(r));
}
