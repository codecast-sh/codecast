"use client";
// Who starts work on the team's lines (/line/settings?section=starts): one row
// per role that leads a project with a line, with what decides how much its
// line starts on its own (learning-loop.md LL5, the-line-end-to-end.md LE6):
// its start switch, its cards (problems at a time), its sessions a day, the
// problems waiting and ready, and what turning it on starts now. A person sets
// every role from this one screen. Turning a line on goes through its review
// (ConsequentialSwitch, lineStartLedger), the limits typed in the row included,
// so one confirm turns it on with them; changing the limits of a line goes
// through a review of its own; turning a line off is one press. Every write is
// updateOrgRole (the server takes it from a signed-in person only).
import { useMemo, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { DEFAULT_LINE_CARDS_CAP } from "@codecast/shared/contracts/orgCapacity";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { useInboxStore } from "../../../store/inboxStore";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useSyncOrgTreeFeeder } from "../../../hooks/useSyncOrgTree";
import { NO_PROJECT, type LineProject, type RollupRow } from "../../../lib/lineFlow";
import type { OrgRole } from "../../org/orgTypes";
import { admissionOf, capsWith, lineRoleOf, lineSwitchFields } from "../map/useLineAdmission";
import { ConsequentialSwitch, SwitchReview, type SwitchLedger } from "../../consequential/ConsequentialSwitch";
import { lineStartLedger, startsAtOnce } from "../../consequential/lineStartLedger";
import { useRunCost } from "../../consequential/useRunCost";
import "./lineStarts.css";

const MIN_CARDS = 1;
const MAX_CARDS = 50;
const MAX_PER_DAY = 200;

type RoleLine = { role: OrgRole; projects: Array<{ id: string; title: string }>; waiting: number; ready: number };

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

export function LineStarts({ projects, rollups }: { projects: ReadonlyArray<LineProject>; rollups: ReadonlyArray<RollupRow> }) {
  useSyncOrgTreeFeeder();
  const roles = useInboxStore((s) => s.orgTree?.roles);
  const rows = useMemo(() => (roles ? roleLines(roles as OrgRole[], projects, rollups) : []), [roles, projects, rollups]);
  return (
    <div className="lw-stage-fill lst" data-line-starts="">
      <div className="lst-head">
        <h2 className="lst-title">Who starts work</h2>
        <span className="lst-dim lw-num">{rows.length} {rows.length === 1 ? "line" : "lines"}</span>
      </div>
      {!roles ? <p className="lst-dim lst-empty">Loading the roles</p> : rows.length === 0 ? <p className="lst-dim lst-empty">No role leads a project with a line</p> : (
        <table className="lst-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Line</th>
              <th data-num="">Cards</th>
              <th data-num="">A day</th>
              <th data-num="">Waiting</th>
              <th data-num="">Ready</th>
              <th data-num="">Now</th>
              <th />
            </tr>
          </thead>
          {/* A limit written anywhere starts the row's draft over from it. */}
          <tbody>{rows.map((r) => <RoleRow key={`${r.role._id}:${r.role.caps?.cards ?? ""}:${r.role.caps?.hands_per_day ?? ""}`} line={r} />)}</tbody>
        </table>
      )}
    </div>
  );
}

/** A whole number from `min` to `max`, or null for blank. */
const wholeIn = (text: string, min: number, max: number): number | null => {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

function RoleRow({ line }: { line: RoleLine }) {
  const { role } = line;
  const { data: queue } = useQueryNoThrow(api.orgLine.queue, { role_id: role._id });
  const admission = admissionOf(role, queue);
  const cards = role.caps?.cards ?? DEFAULT_LINE_CARDS_CAP;
  const perDay = role.caps?.hands_per_day ?? null;
  // The limits as typed: what the review shows and the confirm writes. Blank sessions a day is no limit.
  const [cardsText, setCardsText] = useState(String(cards));
  const [dayText, setDayText] = useState(perDay == null ? "" : String(perDay));
  const draftCards = wholeIn(cardsText, MIN_CARDS, MAX_CARDS);
  const draftDay = dayText.trim() === "" ? null : wholeIn(dayText, 1, MAX_PER_DAY);
  const valid = draftCards != null && (dayText.trim() === "" || draftDay != null);
  const changed = valid && (draftCards !== cards || draftDay !== perDay);
  const drafted = { ...admission, slots: draftCards ?? cards, handsCap: valid ? draftDay : perDay };
  const cost = useRunCost(line.projects[0]?.id ?? null);
  const subject = `@${role.handle} · ${line.projects.map((p) => p.title).join(", ")}`;
  const limitRows = limitChangeRows(cards, perDay, draftCards ?? cards, valid ? draftDay : perDay);
  const onLedger: SwitchLedger = useMemo(() => {
    const l = lineStartLedger({ project: line.projects.map((p) => p.title).join(", "), admission: drafted, roleOwnSwitchOff: !autonomyOn(role.trust), waiting: line.waiting, ready: line.ready, cost });
    return { ...l, subject, rows: [...limitRows, ...l.rows] };
  }, [drafted.slots, drafted.handsCap, admission.queued, admission.busy, admission.hands, line.waiting, line.ready, cost, role.trust, subject]); // eslint-disable-line react-hooks/exhaustive-deps
  const write = (on: boolean | null) => {
    const caps = { cards: draftCards ?? cards, hands_per_day: valid ? draftDay : perDay };
    if (on == null) { useInboxStore.getState().updateOrgRole(role._id, { caps: capsWith(role.caps, caps) }); return; }
    const fields = lineSwitchFields(role, on);
    useInboxStore.getState().updateOrgRole(role._id, on ? { ...fields, caps: capsWith(fields.caps, caps) } : fields);
  };
  const [limitsReview, setLimitsReview] = useState(false);
  const startsNow = admission.on ? null : startsAtOnce({ ...drafted, queued: line.ready || admission.queued });
  const paused = role.status !== "active";
  return (
    <tr className="lst-row" data-line-starts-role={role.handle} data-on={admission.on ? "" : undefined}>
      <td className="lst-who">
        <b>@{role.handle}{paused && <span className="lst-paused">paused</span>}</b>
        <span className="lst-dim">{line.projects.map((p) => p.title).join(" · ")}</span>
      </td>
      <td>
        <ConsequentialSwitch on={admission.on} ledger={onLedger} onTurnOn={() => write(true)} onTurnOff={() => write(false)} trigger={({ on, press, reviewing }) => (
          <button type="button" role="switch" aria-checked={on} aria-haspopup={on ? undefined : "dialog"} aria-expanded={on ? undefined : reviewing} onClick={press} className="lst-switch" data-line-starts-switch={on ? "on" : "off"} aria-label={`@${role.handle}'s line`}>
            <span className="lst-knob" aria-hidden />{on ? "On" : "Off"}
          </button>
        )} />
      </td>
      <td data-num=""><input className="lst-num" inputMode="numeric" value={cardsText} onChange={(e) => setCardsText(e.target.value)} aria-label={`@${role.handle}'s cards at a time`} data-invalid={draftCards == null ? "" : undefined} data-line-starts-cards /></td>
      <td data-num=""><input className="lst-num" inputMode="numeric" value={dayText} placeholder="no limit" onChange={(e) => setDayText(e.target.value)} aria-label={`@${role.handle}'s sessions a day`} data-invalid={dayText.trim() !== "" && draftDay == null ? "" : undefined} data-line-starts-day /></td>
      <td data-num="" className="lw-num">{line.waiting}</td>
      <td data-num="" className="lw-num">{line.ready}</td>
      {/* On: how many of its places run now. Off: how many turning it on starts at once, with the limits as typed. */}
      <td data-num="" className="lw-num" data-line-starts-now="">
        {admission.on ? (admission.busy != null ? `${admission.busy} of ${admission.slots} running` : "") : startsNow != null ? <span className="lst-starts">starts {startsNow}</span> : ""}
      </td>
      <td className="lst-acts">
        {changed && (
          <button type="button" className="lst-apply" onClick={() => setLimitsReview(true)} data-line-starts-apply>
            Set limits
          </button>
        )}
        {limitsReview && <SwitchReview ledger={limitsLedger(subject, cards, perDay, draftCards ?? cards, valid ? draftDay : perDay, admission.on, startsAtOnce({ ...drafted, queued: line.ready || admission.queued }), limitRows)} onClose={() => setLimitsReview(false)} onConfirm={() => { setLimitsReview(false); write(null); }} />}
      </td>
    </tr>
  );
}

const dayWords = (n: number | null) => (n == null ? "no limit" : `${n} a day`);

/** The limits a confirm changes, one row each, only those that change. */
function limitChangeRows(cards: number, perDay: number | null, nextCards: number, nextDay: number | null): SwitchLedger["rows"] {
  return [
    ...(nextCards !== cards ? [{ k: "Cards at a time", v: `${cards} → ${nextCards}`, ...(nextCards > cards ? { tone: "warn" as const } : {}) }] : []),
    ...(nextDay !== perDay ? [{ k: "Sessions a day", v: `${dayWords(perDay)} → ${dayWords(nextDay)}`, ...(nextDay == null || (perDay != null && nextDay > perDay) ? { tone: "warn" as const } : {}) }] : []),
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
