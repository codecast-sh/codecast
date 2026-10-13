// What agents asked a person to do by a date (line-journeys.md LJ6.1 `ask`):
// the `ask` needs For you lists beside lineNeeds', read off the line's
// findings, and the words for when each is due. Pure.
import { escalationFinding } from "./problemPage";
import type { LineNeed } from "./lineNeeds";
/** A finding as askNeeds reads it: the feed's facts, with the day the server read off its whole detail. */
export type AskSignal = {
  _id: string;
  short_id?: string | null;
  source: string;
  subject?: string | null;
  title: string;
  detail_md?: string | null;
  evidence_url?: string | null;
  task_id?: string | null;
  project_id?: string | null;
  created_at: number;
  observed_at?: number | null;
  ask_due?: number | null;
  ask_done?: { at: number } | null;
  retired?: unknown;
};

/**
 * What agents asked a person to do by a date (kind `ask`): every finding whose words ask a person to act and set a
 * day for it (the server's `ask_due`), until a person says it is done. Wherever the finding was filed, the ask is the
 * person's: a problem's Findings list holds it as evidence, never as the place it waits. One ask per task it is done
 * in (an agent that escalates the same task again replaces the older ask).
 */
export function askNeeds(signals: ReadonlyArray<AskSignal>, refOf: (taskId: string) => string | null): LineNeed[] {
  const newest = new Map<string, AskSignal>();
  for (const s of signals) {
    if (s.ask_due == null || s.ask_done || s.retired) continue;
    const key = s.evidence_url || s._id;
    const had = newest.get(key);
    if (!had || (s.observed_at || s.created_at) > (had.observed_at || had.created_at)) newest.set(key, s);
  }
  return [...newest.values()].flatMap((s): LineNeed[] => {
    const e = escalationFinding(s);
    if (!e) return [];
    const about = e.about.charAt(0).toUpperCase() + e.about.slice(1);
    const title = `${e.ask}: ${about}`;
    const ref = s.short_id ?? s._id;
    return [{
      key: `ask:${s._id}`, ref, kind: "ask", counted: true, ask: title, line: title, title, name: null,
      problemRef: null, caseId: null, projectId: s.project_id ?? null, process: null, since: s.observed_at || s.created_at, runId: null,
      decisionRef: null, cardRef: null, trial: false, note: null, fail: null, why: null, findings: null, aliases: [s._id],
      person: { signalId: s._id, act: e.ask, about, contact: e.contact, due: s.ask_due!, url: s.evidence_url ?? null, filed: s.task_id ? { id: s.task_id, ref: refOf(s.task_id) } : null },
    }];
  });
}

const DAY_MS = 86_400_000;
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** When an ask is due, against today. `short` is the list's ("Due today", "Due Thu, Oct 15", "1 day late"), `when` the
 *  reader's Due fact ("Today", "Thu, Oct 15", "Mon, Oct 12, 1 day late"); `late` colors both. */
export function dueWords(due: number, now: number): { short: string; when: string; late: boolean } {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const days = Math.round((due - today) / DAY_MS);
  const day = WEEKDAY.format(due);
  if (days < 0) {
    const late = `${-days} ${days === -1 ? "day" : "days"} late`;
    return { short: late, when: `${day}, ${late}`, late: true };
  }
  if (days === 0) return { short: "Due today", when: `Today, ${MONTH_DAY.format(due)}`, late: false };
  if (days === 1) return { short: "Due tomorrow", when: `Tomorrow, ${MONTH_DAY.format(due)}`, late: false };
  return { short: `Due ${day}`, when: day, late: false };
}
