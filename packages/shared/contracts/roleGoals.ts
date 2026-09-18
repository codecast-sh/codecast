// A person's goals, as a role keeps them in its brief (docs/architecture/
// org-roles-run-work.md R6). Goals are text, set in the conversation or on
// the Brief tab, one section per person who reports to the role:
//
//   ## Goals: Ashot
//   1. Ship the org feature by October (high) — ct-52526, pl-711, jx7csbd
//   2. Close the fundraising deck
//
// A goal is one line in the person's own words. `(high)`, `(medium)` or
// `(low)` anywhere on the line is its priority. The short ids on the line
// (sessions jx…, tasks ct-N, plans pl-N) are the sessions, tasks and plans the
// role has matched to it; the server reads those rows live to say what moved
// and what stalled, so nothing derived is ever written back into the brief.
//
// One parser for the wake frame, the brief query, the Scope tab, the health
// query and the stall sweep, so every surface reads the same goals.

export type GoalPriority = "high" | "medium" | "low";

export type ParsedGoal = {
  /** The goal in the person's words, without the priority mark and the refs. */
  text: string;
  priority: GoalPriority | null;
  refs: { sessions: string[]; tasks: string[]; plans: string[] };
  /** The line as written, for a surface that shows the brief's own words. */
  raw: string;
};

export type GoalSection = {
  /** The name after "Goals:" as the role wrote it; matched to a person by name. */
  person: string;
  goals: ParsedGoal[];
};

/** The heading a goal section opens with. A brief with several sections has
 *  one per person; anything after the heading up to the next heading of any
 *  level is that person's section. */
export const GOAL_HEADING = /^#{1,6}\s*Goals?\s*(?:for|:)\s*(.+?)\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const GOAL_LINE = /^(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const PRIORITY = /\((high|medium|low)\)/i;
const SESSION_REF = /\bjx[0-9a-z]{5,}\b/g;
const TASK_REF = /\bct-\d+\b/g;
const PLAN_REF = /\bpl-\d+\b/g;

function uniq(list: string[]): string[] {
  return Array.from(new Set(list));
}

export function parseGoalLine(line: string): ParsedGoal | null {
  const m = line.trim().match(GOAL_LINE);
  if (!m) return null;
  const raw = m[1];
  const priority = (raw.match(PRIORITY)?.[1]?.toLowerCase() as GoalPriority | undefined) ?? null;
  const refs = {
    sessions: uniq(raw.match(SESSION_REF) ?? []),
    tasks: uniq(raw.match(TASK_REF) ?? []),
    plans: uniq(raw.match(PLAN_REF) ?? []),
  };
  // The text is the line with the priority and the refs taken out, and the
  // dash or comma that joined the refs to the words dropped with them.
  const text = raw
    .replace(PRIORITY, "")
    .replace(SESSION_REF, "").replace(TASK_REF, "").replace(PLAN_REF, "")
    .replace(/[\s,;:·—–-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,;.])/g, "$1")
    .trim();
  if (!text) return null;
  return { text, priority, refs, raw };
}

/** Every goal section in a brief's narrative, in the order written. */
export function parseGoalSections(narrative: string): GoalSection[] {
  const out: GoalSection[] = [];
  let current: GoalSection | null = null;
  for (const line of (narrative ?? "").split("\n")) {
    const heading = line.match(GOAL_HEADING);
    if (heading) {
      current = { person: heading[1].trim(), goals: [] };
      out.push(current);
      continue;
    }
    if (ANY_HEADING.test(line)) { current = null; continue; }
    if (!current) continue;
    const goal = parseGoalLine(line);
    if (goal) current.goals.push(goal);
  }
  return out;
}

/** Two names for one person: the brief says "Ashot", the roster says "Ashot
 *  Petrosian" or the email. The first word wins ties, so a first name in the
 *  brief matches the roster's full name. */
export function goalSectionMatchesPerson(sectionName: string, person: { name?: string | null; email?: string | null }): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const a = norm(sectionName);
  if (!a) return false;
  const name = norm(person.name ?? "");
  const email = norm(person.email ?? "");
  if (a === name || a === email) return true;
  if (email && a === email.split("@")[0]) return true;
  if (name && (name.startsWith(a + " ") || a.startsWith(name + " "))) return true;
  const first = name.split(" ")[0];
  return !!first && a === first;
}

/** The section a role writes for a person who has no goals yet: the shape,
 *  never the words. Shown to the role in its frame and to a person on the
 *  Brief tab. */
export function goalSectionTemplate(personName: string): string {
  return [`## Goals: ${personName}`, `1. <the goal in their words> (high)`, `2. <the next goal>`].join("\n");
}
