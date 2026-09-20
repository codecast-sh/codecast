// The org record as a person reads it (docs/architecture/org-staffing.md S21,
// "The page"): what the History tab, the History section of a role's Scope
// view and `cast org log` share beyond the row contract. The rows, the entry's
// sentence and the effect lines are orgChange.ts's (orgLogLine,
// orgLogEntryLine, orgLogEffectLines); this file adds only what sits AROUND an
// entry: the door it came through, the day it falls on, and the one line for
// each thing an undo cannot take back.
//
// Pure and total: a door or a kind this build does not know still reads as
// words.
import type { OrgLogDoor, OrgLogEntry, OrgUndoPreview } from "./orgChange";

const DOOR_WORDS: Record<OrgLogDoor, string> = {
  proposal: "a proposal",
  settings: "Settings",
  chart: "the chart",
  project_page: "a project page",
  initiative: "an initiative",
  cli: "the command line",
  history: "History",
};

/** Where the change was made, in words: "proposal op-7", "Settings". */
export function orgLogDoorWords(entry: Pick<OrgLogEntry, "door" | "actor">): string {
  if (entry.door === "proposal" && entry.actor.proposal?.short_id) return `proposal ${entry.actor.proposal.short_id}`;
  return DOOR_WORDS[entry.door] ?? "another page";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an undo cannot take back, said once in the preview (S21). */
export function orgUndoCannotLine(c: OrgUndoPreview["cannot_take_back"][number]): string {
  switch (c.kind) {
    case "message_sent": return `${plural(c.count, "message")} a role already sent ${c.count === 1 ? "stays" : "stay"} sent.`;
    case "wake_ran": return `${plural(c.count, "wake")} that already ran ${c.count === 1 ? "stays" : "stay"} run.`;
    case "session_worked": return `The work ${plural(c.count, "session")} already did stays done.`;
    default: return "Some of what this change set in motion has already happened.";
  }
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Today", "Yesterday", else "Mon, Sep 14" (with the year once it differs). */
export function orgLogDayLabel(at: number, now: number = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(at)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(at);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : `, ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

/** "3:12 PM", the same on the page and in the terminal. */
export function orgLogClock(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Newest first, grouped by the local day each entry falls on. */
export function groupOrgLogByDay<E extends Pick<OrgLogEntry, "at" | "seq">>(entries: readonly E[], now: number = Date.now()): { day: number; label: string; entries: E[] }[] {
  const sorted = [...entries].sort((a, b) => b.at - a.at || b.seq - a.seq);
  const groups: { day: number; label: string; entries: E[] }[] = [];
  for (const e of sorted) {
    const day = dayStart(e.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else groups.push({ day, label: orgLogDayLabel(e.at, now), entries: [e] });
  }
  return groups;
}
