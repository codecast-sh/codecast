// Who starts work on the team's lines (components/line/settings/LineStarts):
// the rows the screen shows, one per role that leads a project with a line, and
// the review of a change to a line's limits.
import type { OrgRole } from "../../components/org/orgTypes";
import { lineRoleOf } from "../../components/line/map/useLineAdmission";
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";
import { NO_PROJECT, type LineProject, type RollupRow } from "../lineFlow";

export type RoleLine = { role: OrgRole; projects: Array<{ id: string; title: string }>; waiting: number; ready: number };

/** Each role that leads a project with a line, with the projects it leads and their waiting problems, by role name. */
export function roleLines(roles: ReadonlyArray<OrgRole>, projects: ReadonlyArray<Pick<LineProject, "_id" | "title">>, rollups: ReadonlyArray<RollupRow>): RoleLine[] {
  const by = new Map<string, RoleLine>();
  for (const r of rollups) {
    if (r.key === NO_PROJECT) continue;
    const role = lineRoleOf(roles as OrgRole[], r.key);
    if (!role) continue;
    const row = by.get(role._id) ?? { role, projects: [], waiting: 0, ready: 0 };
    row.projects.push({ id: r.key, title: projects.find((p) => p._id === r.key)?.title ?? r.title });
    row.waiting += r.ready + r.notReady.reduce((n, x) => n + x.count, 0);
    row.ready += r.ready;
    by.set(role._id, row);
  }
  return [...by.values()].sort((a, b) => a.role.name.localeCompare(b.role.name));
}

const dayWords = (n: number | null) => (n == null ? "no limit" : `${n} a day`);

/** The limits a confirm changes, one row each, only those that change. */
export function limitChangeRows(cards: number, perDay: number | null, nextCards: number, nextDay: number | null): SwitchLedger["rows"] {
  return [
    ...(nextCards !== cards ? [{ k: "Cards", v: `${cards} → ${nextCards}`, ...(nextCards > cards ? { tone: "warn" as const } : {}) }] : []),
    ...(nextDay !== perDay ? [{ k: "A day", v: `${dayWords(perDay)} → ${dayWords(nextDay)}`, ...(nextDay == null || (perDay != null && nextDay > perDay) ? { tone: "warn" as const } : {}) }] : []),
  ];
}

/** The review of changing a line's limits: what it allows from now, and, on a line that runs, what it starts at once. */
export function limitsLedger(subject: string, cards: number, perDay: number | null, nextCards: number, nextDay: number | null, on: boolean, startsNow: number | null, rows: SwitchLedger["rows"]): SwitchLedger {
  return {
    name: "Line limits",
    subject,
    shift: [`${cards} · ${dayWords(perDay)}`, `${nextCards} · ${dayWords(nextDay)}`],
    figures: [
      { value: String(nextCards), label: "at a time" },
      { value: nextDay == null ? "∞" : String(nextDay), label: "sessions a day", ...(nextDay == null ? { tone: "warn" as const } : {}) },
      ...(on && startsNow != null ? [{ value: String(startsNow), label: "start now", ...(startsNow > 0 ? { tone: "warn" as const } : {}) }] : []),
    ],
    rows: [...rows, { k: "Line", v: on ? "On: it starts up to these limits" : "Off: nothing starts until it is on" }],
    confirm: "Set limits",
    keep: "Keep as is",
  };
}
