// Who a role is, as its trigger run reminds it (org-staffing.md S25): read
// fresh at firing, so a run never works from a stale idea of its area.
export interface RoleCard {
  handle: string;
  name: string;
  /** A person's name, or "@handle" of the role it reports to. */
  reports_to: string;
  /** What it looks after, by title; empty when the role names no scope. */
  scope: string[];
  charter?: string;
  /** The goals written on the projects it looks after. */
  goals: string[];
  /** The initiatives its work feeds (the ones it owns, and the ones its
   *  projects carry), each with its metric read against the target and the
   *  chain up to the top level goal, so the role knows what its area serves. */
  initiatives?: RoleCardInitiative[];
}
export interface RoleCardInitiative {
  short_id: string;
  title: string;
  /** Each metric as one line: "Weekly active teams: 412 of 1,000, behind (3 days ago)". */
  metrics: string[];
  /** The goals above it, nearest first, by title. */
  chain: string[];
}
/** "Serves: Win the private network (in-4), under Reach 1k teams; Weekly active teams: 412 of 1,000, behind (3 days ago)" */
export function roleCardInitiativeLine(i: RoleCardInitiative): string {
  return `${i.title} (${i.short_id})${i.chain.length ? `, under ${i.chain.join(", under ")}` : ""}${i.metrics.length ? `; ${i.metrics.join("; ")}` : ""}`;
}
/** The card's body as labelled lines, the one wording a wake frame and a
 *  session's org context (`cast org where`) both print. */
export function roleCardLines(r: RoleCard): string[] {
  return [
    r.scope.length ? `Looks after: ${r.scope.join(", ")}` : "Looks after no area of its own: it runs its routine and answers what it is asked.",
    r.charter ? `Charter: ${r.charter}` : "",
    r.goals.length ? `Goals: ${r.goals.join("; ")}` : "",
    ...(r.initiatives ?? []).map((i) => `Serves: ${roleCardInitiativeLine(i)}`),
  ].filter(Boolean);
}
export function parseRoleCardInitiativeLine(line: string): RoleCardInitiative {
  const [head, ...metrics] = line.split("; ");
  const m = head.match(/^(.*?) \((in-\d+)\)(?:, under (.*))?$/);
  return m
    ? { title: m[1], short_id: m[2], chain: m[3] ? m[3].split(", under ") : [], metrics }
    : { title: head, short_id: "", chain: [], metrics };
}
