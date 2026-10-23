// Who starts work on the team's lines (components/line/settings/LineStarts):
// the rows the screen shows, one per role that leads a project with a line, and
// the review of a change to a line's limits.
import type { OrgRole } from "../../components/org/orgTypes";
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";
import type { RollupRow } from "../lineFlow";
import type { OwnedFlow } from "./ownedFlows";

export type RoleLine = { role: OrgRole; projects: Array<{ id: string; title: string }>; waiting: number; ready: number };

/** Each owned flow (ownedFlows) with its projects' waiting and ready problems, in the flows' order. */
export function roleLines(flows: ReadonlyArray<OwnedFlow>, rollups: ReadonlyArray<RollupRow>): RoleLine[] {
  const by = new Map(rollups.map((r) => [r.key, r]));
  return flows.map((f) => {
    const rows = f.projects.map((p) => by.get(p.id)).filter((r): r is RollupRow => !!r);
    return {
      role: f.owner,
      projects: f.projects,
      waiting: rows.reduce((n, r) => n + r.ready + r.notReady.reduce((m, x) => m + x.count, 0), 0),
      ready: rows.reduce((n, r) => n + r.ready, 0),
    };
  });
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
    name: "Flow limits",
    subject,
    shift: [`${cards} · ${dayWords(perDay)}`, `${nextCards} · ${dayWords(nextDay)}`],
    figures: [
      { value: String(nextCards), label: "at a time" },
      { value: nextDay == null ? "∞" : String(nextDay), label: "sessions a day", ...(nextDay == null ? { tone: "warn" as const } : {}) },
      ...(on && startsNow != null ? [{ value: String(startsNow), label: "start now", ...(startsNow > 0 ? { tone: "warn" as const } : {}) }] : []),
    ],
    rows: [...rows, { k: "Flow", v: on ? "On: it starts up to these limits" : "Off: nothing starts until it is on" }],
    confirm: "Set limits",
    keep: "Keep as is",
  };
}
