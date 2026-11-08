// Permanent deletes in a team whose data is regulated (managed policy
// regulated_data; convex regulatedDeletion.ts): one session, one page, one
// call, or the whole team. Each goes through the shared review, which says in
// structure what goes, that it cannot be undone, and that it is logged.
import { parseTeamPolicy } from "@codecast/shared/contracts";
import type { SwitchFigure, SwitchLedger, SwitchRow } from "./ConsequentialSwitch";

type TeamRow = { _id?: unknown; name?: string; role?: string; policy?: unknown } | null | undefined;

/** The regulated team `teamId` names among the viewer's teams, with whether they administer it; null when it is not regulated. */
export function regulatedTeam(teams: ReadonlyArray<TeamRow> | null | undefined, teamId: unknown): { name: string; admin: boolean } | null {
  if (!teamId) return null;
  const team = (teams ?? []).find((t) => t && String(t._id) === String(teamId));
  if (!team || parseTeamPolicy(team.policy).regulated_data !== true) return null;
  return { name: team.name ?? "Team", admin: team.role === "admin" };
}

/** Whether the viewer may delete an object `ownerId` owns: its owner, or an admin of its regulated team (the server's rule). */
export function mayDeletePermanently(team: { admin: boolean } | null, ownerId: unknown, viewerId: unknown): boolean {
  return (!!ownerId && String(ownerId) === String(viewerId)) || !!team?.admin;
}

const COMMON_ROWS: SwitchRow[] = [
  { k: "Undo", v: "Not possible", tone: "warn" },
  { k: "Logged", v: "Team audit log" },
  { k: "Backups", v: "Age out in 14 days" },
];

/** One object deleted for good. */
export function permanentDeleteLedger(r: {
  what: "session" | "page" | "call";
  title: string;
  team: string;
  figures?: SwitchFigure[];
  reaches: string[];
  count?: number;
}): SwitchLedger {
  const n = r.count ?? 1;
  const noun = n > 1 ? `${n} ${r.what}s` : r.what;
  return {
    name: `Delete ${noun} permanently`,
    subject: r.title,
    shift: null,
    alert: "Can't be undone",
    figures: r.figures ?? [],
    rows: [{ k: "Team", v: r.team }, { k: "Deletes", v: "Every copy", list: r.reaches }, ...COMMON_ROWS],
    confirm: `Delete ${noun}`,
    keep: "Keep",
  };
}

export type DestroyPreview = {
  team_name: string;
  sessions: { n: number; more: boolean };
  calls: { n: number; more: boolean };
  tasks: { n: number; more: boolean };
  docs: { n: number; more: boolean };
  plans: { n: number; more: boolean };
  members: { n: number; more: boolean };
} | null | undefined;

const shown = (c: { n: number; more: boolean } | undefined) => (c ? `${c.n}${c.more ? "+" : ""}` : "…");

/** The whole team and all of its data, deleted for good: the BAA's destroy-at-termination step. */
export function destroyTeamLedger(r: { team: string; preview: DestroyPreview }): SwitchLedger {
  const p = r.preview ?? undefined;
  return {
    name: "Delete team and all data",
    subject: r.team,
    shift: null,
    alert: "Can't be undone",
    figures: [
      { value: shown(p?.sessions), label: "sessions", tone: "warn" },
      { value: shown(p?.calls), label: "calls", tone: "warn" },
      { value: shown(p?.tasks), label: "tasks" },
      { value: shown(p?.docs), label: "docs" },
      { value: shown(p?.plans), label: "plans" },
    ],
    rows: [
      { k: "Access", v: `Ends now for ${shown(p?.members)} members`, tone: "warn" },
      { k: "Deletes", v: "Every copy", list: ["Transcripts, files, snapshots", "Pages and their files", "Recordings and call transcripts", "Chat, tasks, docs, settings"] },
      { k: "Restore", v: "Never", tone: "warn" },
      ...COMMON_ROWS.slice(1),
    ],
    typed: { k: "Team name", expect: r.team },
    confirm: "Delete team and all data",
    keep: "Keep team",
    ...(r.preview === null ? { blocked: "Only an admin can do this" } : {}),
  };
}

/** What a session's permanent delete reaches, as the review lists it. */
export const SESSION_REACHES = ["Messages and files", "Diffs and snapshots", "Pages published from it", "Comments and insights"];
export const PAGE_REACHES = ["Every version", "Files and images", "Comments and viewers"];
export const CALL_REACHES = ["Recordings", "Transcript", "Shared frames", "Call chat"];
