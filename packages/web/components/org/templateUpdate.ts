// The Update card's words (sd-424: on a stable instance every template change
// waits for a person's click, so the card makes that click quick and
// informed). Pure, so the class wording and change lists are tested without a
// DOM; the role page and the upgrade proposal both read from here.
import type { ReleaseChanges, ReleaseClass } from "@codecast/shared/contracts/orgTemplateRelease";

/** Names from the offered release's manifest, so an added routine, input or setup step reads by its title. */
export type UpdateNames = { routines?: Record<string, { title: string; every?: string }>; setup?: Record<string, string>; inputs?: Record<string, string> };

export type UpdateSource = {
  update_available?: string | null;
  update_class?: ReleaseClass | null;
  update_changes?: ReleaseChanges | null;
  update_changelogs?: { version: string; text: string }[] | null;
  update_rollback?: { reason: string } | null;
  update_names?: UpdateNames | null;
  /** The pinned release's routines and setup: names for what an update removes or re-cadences. */
  routines?: { id: string; title?: string }[] | null;
  setup?: { id: string; title?: string }[] | null;
  template?: { changelog?: string | null } | null;
};

export type UpdateCard = {
  kind: ReleaseClass | "rollback" | "unclassified";
  /** The class in plain words, leading the card; null when the server sent no class. */
  heading: string | null;
  /** One line per change a person should know about before clicking. */
  changes: string[];
  note: string | null;
  /** The button's label, or null when no update is offered from here (authority). */
  action: "Update" | "Roll back" | null;
  /** Every changelog between the current release (exclusive) and the offered one (inclusive), newest first. */
  changelogs: { version: string; text: string }[];
};

export const CLASS_HEADING: Record<ReleaseClass, string> = {
  content: "Wording only",
  structure: "Changes what the role does",
  authority: "Changes what the role may do",
};

/** "3 releases behind" when the instance trails the template, for every update policy; null when current. */
export function releasesBehindLabel(n: number | null | undefined): string | null {
  return n && n > 0 ? `${n} release${n === 1 ? "" : "s"} behind` : null;
}

/** The change lines for a structure (or rollback) jump, each item named by its title where the release has one. */
export function changeLines(c: ReleaseChanges, s: Pick<UpdateSource, "update_names" | "routines" | "setup">): string[] {
  const names = s.update_names ?? {};
  const routine = (id: string) => names.routines?.[id]?.title ?? s.routines?.find((r) => r.id === id)?.title ?? id;
  const step = (id: string) => names.setup?.[id] ?? s.setup?.find((x) => x.id === id)?.title ?? id;
  const input = (key: string) => names.inputs?.[key] ?? key;
  const every = (id: string) => names.routines?.[id]?.every;
  const list = (ids: string[]) => ids.join(", ");
  return [
    ...c.routines_added.map((id) => `New routine: ${routine(id)}${every(id) ? ` (every ${every(id)})` : ""}`),
    ...c.routines_removed.map((id) => `Retired routine: ${routine(id)}`),
    ...c.routines_recadenced.map((r) => `${routine(r.id)} runs every ${r.to} instead of every ${r.from}`),
    ...c.inputs_added.map((k) => `New input: ${input(k)}`),
    ...c.inputs_removed.map((k) => `Input no longer asked: ${input(k)}`),
    ...c.setup_added.map((id) => `New setup step: ${step(id)}`),
    ...c.setup_removed.map((id) => `Setup step removed: ${step(id)}`),
    ...(c.evidence_changed.length ? [`Evidence checks changed: ${list(c.evidence_changed)}`] : []),
    ...(c.ledgers_changed.length ? [`Ledgers changed: ${list(c.ledgers_changed)}`] : []),
    ...(c.scoreboard_changed.length ? [`Scoreboard changed: ${list(c.scoreboard_changed)}`] : []),
  ];
}

/** What the card says for the offered release, or null when nothing is offered. */
export function updateCard(s: UpdateSource): UpdateCard | null {
  const to = s.update_available;
  if (!to) return null;
  const changelogs = s.update_changelogs?.length ? s.update_changelogs : !s.update_rollback && s.template?.changelog?.trim() ? [{ version: to, text: s.template!.changelog!.trim() }] : [];
  const lines = s.update_changes ? changeLines(s.update_changes, s) : [];
  if (s.update_rollback) {
    return { kind: "rollback", heading: `This release was withdrawn: ${s.update_rollback.reason}`, changes: lines, note: `Rolling back moves the role to ${to}, the newest release still offered.`, action: "Roll back", changelogs };
  }
  const c = s.update_class;
  if (c === "authority") {
    return { kind: c, heading: CLASS_HEADING[c], changes: s.update_changes?.authority_changed ?? [], note: "This cannot arrive as an update. A separate permission request follows for you to decide.", action: null, changelogs };
  }
  if (c === "structure") {
    const added = s.update_changes?.routines_added.length ?? 0;
    return { kind: c, heading: CLASS_HEADING[c], changes: lines, note: added === 1 ? "The new routine arrives paused and needs Activate under Triggers once it is ready." : added > 1 ? "New routines arrive paused; each needs Activate under Triggers once it is ready." : null, action: "Update", changelogs };
  }
  if (c === "content") return { kind: c, heading: CLASS_HEADING[c], changes: [], note: "The charter, prompts or guides changed. What the role does and may do stay the same.", action: "Update", changelogs };
  return { kind: "unclassified", heading: null, changes: lines, note: null, action: "Update", changelogs };
}
