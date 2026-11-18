// Work that reaches no goal (coverage.unplaced, ct-95900) as `cast org inputs`,
// `cast org health` and `cast brief` print it: one count line, then one line
// per item with its age, when it last moved and the session driving it. The
// full lists are in --json.

import { fmt } from "./colors.js";
import { formatRelative } from "@codecast/shared/time";

type SessionRef = { short_id: string; title: string; last_active_at: number } | null;
export type UnplacedView = {
  plans: Array<{ short_id: string; title: string; status: string; open_tasks: number; done_tasks: number; age_days: number; last_activity_at: number; driver: SessionRef }>;
  projects: Array<{ short_id?: string; title: string; open_tasks: number; open_plans: number; lead: string | null; age_days: number; last_activity_at: number; driver: SessionRef }>;
  loose_tasks: { total: number; by_session: Array<{ session: SessionRef; tasks: number; examples: Array<{ short_id: string; title: string }>; age_days: number; last_activity_at: number }> };
  sessions: Array<{ short_id: string; title: string; owner?: string; age_days: number; last_activity_at: number; bound: Array<{ kind: string; short_id: string }>; reason: string }>;
  truncated: boolean;
};

/** Items printed per kind; the rest are counted. */
const SHOWN = 8;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const cut = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const driven = (d: SessionRef) => (d ? ` · ${fmt.id(d.short_id)}` : fmt.muted(" · no session"));

export function unplacedCountLine(u: UnplacedView): string {
  const groups = u.loose_tasks.by_session.length;
  const parts = [
    u.plans.length ? plural(u.plans.length, "plan") + " with no project" : "",
    u.projects.length ? plural(u.projects.length, "project") + " with no goal" : "",
    u.loose_tasks.total ? `${plural(u.loose_tasks.total, "loose task")} from ${plural(groups, "session")}` : "",
    u.sessions.length ? plural(u.sessions.length, "long session") + " off any goal" : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}${u.truncated ? " (a floor)" : ""}` : "nothing: every live plan and project reaches a goal";
}

export function unplacedLines(u: UnplacedView | null | undefined, now: number, indent = "  "): string[] {
  if (!u) return [];
  const out = [`${indent}${fmt.muted("unplaced:")} ${unplacedCountLine(u)}`];
  const more = (n: number) => (n > SHOWN ? [`${indent}  ${fmt.muted(`+${n - SHOWN} more (--json)`)}`] : []);
  const at = (t: number) => fmt.muted(`moved ${formatRelative(t, now)}`);
  for (const p of u.plans.slice(0, SHOWN)) {
    out.push(`${indent}  ${fmt.muted("plan   ")} ${fmt.id(p.short_id)} ${cut(p.title)} ${fmt.muted(`· ${p.open_tasks} open of ${p.open_tasks + p.done_tasks} · ${p.status} · ${p.age_days}d old ·`)} ${at(p.last_activity_at)}${driven(p.driver)}`);
  }
  out.push(...more(u.plans.length));
  for (const p of u.projects.slice(0, SHOWN)) {
    const work = [p.open_tasks ? `${p.open_tasks} open` : "", p.open_plans ? plural(p.open_plans, "plan") : ""].filter(Boolean).join(", ");
    out.push(`${indent}  ${fmt.muted("project")} ${p.short_id ? `${fmt.id(p.short_id)} ` : ""}${cut(p.title)} ${fmt.muted(`· ${work} · ${p.lead ? `lead ${p.lead}` : "no lead"} · ${p.age_days}d old ·`)} ${at(p.last_activity_at)}${driven(p.driver)}`);
  }
  out.push(...more(u.projects.length));
  for (const g of u.loose_tasks.by_session.slice(0, SHOWN)) {
    const who = g.session ? `${fmt.id(g.session.short_id)} ${cut(g.session.title, 36)}` : fmt.muted("no session");
    out.push(`${indent}  ${fmt.muted("tasks  ")} ${who} ${fmt.muted(`· ${g.tasks}: ${g.examples.map((t) => t.short_id).join(", ")}${g.tasks > g.examples.length ? ", …" : ""} · oldest ${g.age_days}d ·`)} ${at(g.last_activity_at)}`);
  }
  out.push(...more(u.loose_tasks.by_session.length));
  for (const s of u.sessions.slice(0, SHOWN)) {
    out.push(`${indent}  ${fmt.muted("session")} ${fmt.id(s.short_id)} ${cut(s.title, 40)} ${fmt.muted(`· ${s.age_days}d running${s.owner ? ` · ${s.owner}` : ""} · on ${s.bound.map((b) => b.short_id).join(", ")}: ${s.reason} ·`)} ${at(s.last_activity_at)}`);
  }
  out.push(...more(u.sessions.length));
  return out;
}
