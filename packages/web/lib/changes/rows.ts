// A repository's changes as the grid and the chip draw them (docs/architecture/changes.md CH4):
// each change's row, the one action a person can take on it, and the groups by who acts next.
import type { ChangeTone, Lifecycle } from "./lifecycle";
import type { RepoChange } from "../../hooks/useRepoChanges";
import type { ChangeOwner } from "./assemble";
import { isMineCommit } from "../deploys/targets";

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
  writers?: ReadonlyArray<{ title: string | null; state: string; href?: string | null; conversation_id?: string | null }>;
  /** Where it lives, beside its writers: `worktree`, a device's name. */
  where?: string | null;
  updated_at?: number | null;
  /** A landed change's `owner/repo#N` or `owner/repo@sha`: its row feeds the reach the grid reads back. */
  reach_ref?: string | null;
  /** What a link can name it by: a branch, a pull request, its commits. */
  refs?: { branch: string | null; pr: number | null; shas: ReadonlyArray<string> };
  owner?: ChangeOwner | null;
};

/** The person reading: who "mine" means. */
export type ChangeViewer = { userId: string | null; login: string | null; name: string | null; devices: ReadonlySet<string> };

/** Whether a change is the viewer's, by the one fact that names its owner (assemble's ChangeOwner). */
export function isMineChange(r: Pick<ChangeRow, "owner">, me: ChangeViewer): boolean {
  const o = r.owner;
  if (!o) return false;
  switch (o.by) {
    case "pr": return !!me.login && o.login.toLowerCase() === me.login.toLowerCase();
    case "session": return !!me.userId && o.users.includes(me.userId);
    case "device": return o.devices.some((d) => me.devices.has(d));
    case "commit": return isMineCommit(o.author, me);
  }
}

/** The one thing a person can do about a change now, as a link to where it is done. */
export function changeAction(c: RepoChange): ChangeLinks["action"] {
  const n = c.lifecycle.now;
  const writer = c.writers.find((w) => w.href);
  if (n.stage === "work" && n.state === "waiting" && writer) return { label: writer.title ? `Ship from ${writer.title}` : "Ship from its session", href: writer.href! };
  if (n.tone === "blue" && c.links.pr) return { label: "Open the pull request", href: c.links.pr };
  if (n.tone === "red" && n.stage === "deploy" && c.links.deploys[0]) return { label: `Open ${c.links.deploys[0].id}`, href: c.links.deploys[0].href };
  // Red on main is main's run, never the pull request's checks (they passed before it landed).
  if (n.tone === "red" && n.stage === "check" && c.facts.check?.after_land) return c.links.ci_run ? { label: "Open the failing run", href: c.links.ci_run } : null;
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
    writers: c.writers.map((w) => ({ title: w.title, state: w.state, href: w.href, conversation_id: w.conversation_id })),
    where: c.where,
    updated_at: c.updated_at,
    reach_ref: c.reach_ref,
    refs: c.refs,
    owner: c.owner,
  };
}

export type ChangeGroupId = "you" | "moving" | "waiting" | "live" | "parked" | "closed";

/** Who acts next, in the order a reader should look. Quiet and Closed start folded. */
const GROUPS: ReadonlyArray<{ id: ChangeGroupId; label: string; tone: ChangeTone; tones: ReadonlyArray<ChangeTone>; folded?: true }> = [
  // Anyone's failure or turn; it is the viewer's own only once the grid shows only theirs (groupLabel).
  { id: "you", label: "Needs attention", tone: "blue", tones: ["red", "blue"] },
  { id: "moving", label: "Moving", tone: "yellow", tones: ["yellow", "orange"] },
  { id: "waiting", label: "Waiting", tone: "muted", tones: ["muted"] },
  { id: "live", label: "Live", tone: "green", tones: ["green"] },
  { id: "parked", label: "Parked", tone: "dim", tones: [], folded: true },
  { id: "closed", label: "Closed", tone: "dim", tones: ["dim"], folded: true },
];

/** Nobody has touched a change in this long: it is not on its way anywhere until someone does. */
export const PARKED_AFTER_MS = 3 * 24 * 60 * 60_000;

/** Within a group, failures before a person's turn, then the newest first. */
const TONE_RANK: Record<ChangeTone, number> = { red: 0, blue: 1, orange: 2, yellow: 3, muted: 4, green: 5, dim: 6 };

/** A rollback is nobody's work in progress: it waits on a person to fix forward or ship again. */
export const groupTone = (l: Lifecycle): ChangeTone => (l.now.stage === "live" && l.now.state === "back" ? "red" : l.now.tone);

/**
 * Whether a change is parked at `now`: nothing is moving it (not shipped, or pushed and not checked), or it is not yet on
 * main, not in motion, nobody's turn, and nobody's work touched it in PARKED_AFTER_MS (or ever, as far as anything
 * reports). A landed change is never parked: where it stands in production always matters.
 */
/** Whether a change still has somewhere to go: not live (green) and not set aside (dim). */
export function isComing(r: ChangeRow): boolean {
  return r.lifecycle.now.tone !== "green" && r.lifecycle.now.tone !== "dim";
}

/** The edge a row in Needs you wears: red for a failure or a rollback, blue for a person's turn. */
export function attentionTone(r: ChangeRow) {
  const g = groupTone(r.lifecycle);
  return g === "red" || g === "blue" ? g : undefined;
}

export function isParked(r: ChangeRow, now: number): boolean {
  const n = r.lifecycle.now;
  // A person's turn and a failure wait on someone: their age is the reason to look, never a reason to fold them away.
  if (r.reach_ref || n.state === "active" || n.state === "stopped" || n.tone === "blue" || n.tone === "red") return false;
  return !!n.parked || !r.updated_at || now - r.updated_at > PARKED_AFTER_MS;
}

/** A group's name: the failures and turns read "Needs you" once the grid holds only the viewer's changes. */
export const groupLabel = (g: { id: ChangeGroupId; label: string }, mine: boolean) => (g.id === "you" && mine ? "Needs you" : g.label);

/** The groups a reader can narrow the grid to, by clicking the group's name. */
export const PICKABLE_GROUPS: ReadonlyArray<ChangeGroupId> = ["you", "moving", "waiting"];

/** A group's name by its id, as its head in the grid reads. */
export const groupName = (id: ChangeGroupId, mine: boolean) => groupLabel(GROUPS.find((g) => g.id === id)!, mine);

/** The group a change falls in at `now` (groupChanges' rule for one row). */
export function groupOf(r: ChangeRow, now: number): ChangeGroupId | null {
  if (isParked(r, now)) return "parked";
  const tone = groupTone(r.lifecycle);
  return GROUPS.find((g) => g.id !== "parked" && g.tones.includes(tone))?.id ?? null;
}

/**
 * The rows a filtered grid draws: the viewer's own (`mine`), in one group (`group`). A row `keep` names (the one a link
 * points at) is drawn whatever the filter says, so a link never opens on a row the filter hid.
 */
export function filterChanges(rows: ReadonlyArray<ChangeRow>, f: { mine: boolean; group: ChangeGroupId | null }, me: ChangeViewer, now: number, keep?: (r: ChangeRow) => boolean): ChangeRow[] {
  if (!f.mine && !f.group) return [...rows];
  return rows.filter((r) => keep?.(r) || ((!f.mine || isMineChange(r, me)) && (!f.group || groupOf(r, now) === f.group)));
}

/** The groups that hold rows, in reading order; `keep` names one drawn even when empty. */
export function groupChanges(rows: ReadonlyArray<ChangeRow>, now: number, keep?: ChangeGroupId | null) {
  return GROUPS.map((g) => ({
    ...g,
    rows: rows
      .filter((r) => (g.id === "parked" ? isParked(r, now) : !isParked(r, now) && g.tones.includes(groupTone(r.lifecycle))))
      .sort((a, b) => TONE_RANK[a.lifecycle.now.tone] - TONE_RANK[b.lifecycle.now.tone] || (b.updated_at ?? 0) - (a.updated_at ?? 0)),
  })).filter((g) => g.rows.length || g.id === keep);
}

/** How many landed changes a grid keeps (and reads the deploys of), freshest first: older ones are done and only noise. */
export const LANDED_SHOWN = 30;

/** A grid's rows: everything not yet on main, and the freshest landed changes. */
export function boardRows(rows: ReadonlyArray<ChangeRow>): ChangeRow[] {
  const landed = rows.filter((r) => r.reach_ref).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, LANDED_SHOWN);
  const keep = new Set(landed);
  return rows.filter((r) => !r.reach_ref || keep.has(r));
}
