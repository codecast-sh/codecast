// Decision areas: who decides for which projects, and how an open decision
// is shared out among the members covering its project. Pure, so the server's
// ask-time routing, its Share out plan, the web's preview and the CLI all
// read one rule.
//
// - The owner of a decision is whoever it was passed to, else its holder,
//   else the single person it was asked of, else the asking session's owner.
// - A decision's pool is the members whose areas name its project: people
//   (never bots) who take decisions and are not away.
// - The pool member with the fewest open decisions owns it; a tie goes to
//   whoever was given one longest ago (never counts as longest).
// - Areas are written in plain words ("Samvit: deals and intros; Jason:
//   desk"); one model call maps the words onto the workspace's members and
//   projects (areasPrompt, parseAreasReply).

export type DecisionOwnerRef = { kind: "user" | "role"; id: string };

type OwnedRow = {
  passed_to?: { kind: "user" | "role"; id: string } | null;
  holder?: { kind: "user" | "role"; id: string } | null;
  asked_user_ids?: readonly string[] | null;
  user_id?: string | null;
};

/** The one person (or role) expected to answer; null when nobody is. Anyone who can read it may still answer it. */
export function decisionOwnerOf(d: OwnedRow): DecisionOwnerRef | null {
  if (d.passed_to) return { kind: d.passed_to.kind, id: String(d.passed_to.id) };
  if (d.holder) return { kind: d.holder.kind, id: String(d.holder.id) };
  if (d.asked_user_ids) return d.asked_user_ids.length > 0 ? { kind: "user", id: String(d.asked_user_ids[0]) } : null;
  return d.user_id ? { kind: "user", id: String(d.user_id) } : null;
}

/** One member as the rotation reads them. */
export type AreaMember = {
  user_id: string;
  project_ids: readonly string[];
  takes_decisions: boolean;
  away: boolean;
  bot: boolean;
  /** Open decisions they own now. */
  open: number;
  /** When the rotation last gave them one. */
  assigned_at?: number;
};

/** Whether a membership's fields say it takes decisions: unset reads as yes, so naming someone's areas is enough. */
export const takesDecisions = (m: { takes_decisions?: boolean | null }): boolean => m.takes_decisions !== false;

/** The members who may own a decision about any of these projects. */
export function areaPool<M extends AreaMember>(members: readonly M[], projectIds: readonly string[]): M[] {
  if (projectIds.length === 0) return [];
  const wanted = new Set(projectIds.map(String));
  return members.filter((m) => !m.bot && !m.away && m.takes_decisions && m.project_ids.some((p) => wanted.has(String(p))));
}

/** Fewest open first; a tie goes to whoever was given one longest ago, then a stable order. */
export function pickAreaOwner<M extends AreaMember>(pool: readonly M[]): M | null {
  let best: M | null = null;
  for (const m of pool) {
    if (!best) { best = m; continue; }
    if (m.open !== best.open) { if (m.open < best.open) best = m; continue; }
    const a = m.assigned_at ?? 0;
    const b = best.assigned_at ?? 0;
    if (a !== b) { if (a < b) best = m; continue; }
    if (m.user_id < best.user_id) best = m;
  }
  return best;
}

/** One open decision as Share out reads it: the projects it is about and who owns it now. */
export type ShareOutRow = { id: string; project_ids: readonly string[]; owner: string | null; created_at: number };
export type ShareOutMove = { decision_id: string; from: string | null; to: string };

/**
 * The rule run over a workspace's open decisions, oldest first, as if each
 * were asked again now: each is taken off its owner's count, given to the
 * pool member the rule picks, and added to theirs. A decision whose project
 * nobody covers, or whose pick is its owner already, stays. Returns the moves
 * and the members as the moves leave them.
 */
export function planShareOut(rows: readonly ShareOutRow[], members: readonly AreaMember[], now: number): { moves: ShareOutMove[]; unmatched: number } {
  const live = members.map((m) => ({ ...m }));
  const byId = new Map(live.map((m) => [m.user_id, m]));
  const moves: ShareOutMove[] = [];
  let unmatched = 0;
  let tick = 0;
  for (const row of [...rows].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))) {
    const pool = areaPool(live, row.project_ids);
    if (pool.length === 0) { unmatched++; continue; }
    const owner = row.owner ? byId.get(row.owner) : undefined;
    if (owner) owner.open = Math.max(0, owner.open - 1);
    const pick = pickAreaOwner(pool)!;
    pick.open++;
    if (pick.user_id === row.owner) continue;
    pick.assigned_at = now + tick++;
    moves.push({ decision_id: row.id, from: row.owner, to: pick.user_id });
  }
  return { moves, unmatched };
}

// ── Plain words onto members and projects ──

/** One member's areas, as applied. */
export type AreaAssignment = { user_id: string; project_ids: string[]; takes_decisions: boolean };
export type AreasRosterMember = { user_id: string; name: string; email?: string };
export type AreasRosterProject = { id: string; title: string; short_id?: string };

export const AREAS_MAX_TOKENS = 1500;
export const AREAS_WORDS_MAX = 4000;

export const AREAS_SYSTEM = `You map a team's own description of who decides for which areas onto its members and projects.

The team wrote, in plain words, which person covers which areas. Read it against the roster: the members, each with a key, and the projects, each with a key and title. A person is named by first name, full name, handle or email; an area is named by a project's title, a word from it, or an obvious synonym ("deals" for a project titled "Deal flow"). Give each member the projects their words name. A person said not to take decisions gets takes_decisions false. A member the words do not mention gets no entry.

Never invent a key: use only keys from the roster. A phrase that names no project goes in "unplaced", in the team's own words, so the person can see what was not matched.

Answer with JSON only, in this shape:
{"members": [{"member": "<member key>", "projects": ["<project key>"], "takes_decisions": true}], "unplaced": ["<phrase>"]}`;

const memberKey = (i: number) => `m${i + 1}`;
const projectKey = (i: number) => `p${i + 1}`;

export function areasPrompt(words: string, members: readonly AreasRosterMember[], projects: readonly AreasRosterProject[]): string {
  const lines = [
    "Members:",
    ...members.map((m, i) => `- ${memberKey(i)}: ${m.name}${m.email ? ` <${m.email}>` : ""}`),
    "",
    "Projects:",
    ...projects.map((p, i) => `- ${projectKey(i)}: ${p.title}${p.short_id ? ` (${p.short_id})` : ""}`),
    "",
    "---",
    "",
    "Who decides for which areas, in the team's words:",
    "",
    words.trim().slice(0, AREAS_WORDS_MAX),
  ];
  return lines.join("\n");
}

/** The reply as assignments onto real ids; every member is listed, the unmentioned ones with no projects. Null when unreadable. */
export function parseAreasReply(
  raw: unknown,
  members: readonly AreasRosterMember[],
  projects: readonly AreasRosterProject[],
  current: ReadonlyMap<string, boolean> = new Map(),
): { assignments: AreaAssignment[]; unplaced: string[] } | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).members)) return null;
  const memberOf = new Map(members.map((m, i) => [memberKey(i), m.user_id]));
  const projectOf = new Map(projects.map((p, i) => [projectKey(i), p.id]));
  const named = new Map<string, AreaAssignment>();
  for (const e of (raw as any).members) {
    const userId = memberOf.get(String(e?.member ?? "").trim().toLowerCase());
    if (!userId) continue;
    const ids = Array.isArray(e?.projects) ? e.projects.map((k: unknown) => projectOf.get(String(k).trim().toLowerCase())).filter((p: string | undefined): p is string => !!p) : [];
    const prior = named.get(userId);
    named.set(userId, {
      user_id: userId,
      project_ids: [...new Set([...(prior?.project_ids ?? []), ...ids])],
      takes_decisions: e?.takes_decisions === false ? false : prior?.takes_decisions ?? true,
    });
  }
  const unplaced = Array.isArray((raw as any).unplaced) ? (raw as any).unplaced.filter((u: unknown): u is string => typeof u === "string" && !!u.trim()).map((u: string) => u.trim()) : [];
  const assignments = members.map((m) => named.get(m.user_id) ?? { user_id: m.user_id, project_ids: [], takes_decisions: current.get(m.user_id) ?? true });
  return { assignments, unplaced };
}

/** A map as one line of plain words: "Samvit: Deals, Intros; Jason: Desk". Members with no projects are left out. */
export function areasText(assignments: readonly AreaAssignment[], nameOf: (userId: string) => string, titleOf: (projectId: string) => string): string {
  return assignments
    .filter((a) => a.project_ids.length > 0)
    .map((a) => `${nameOf(a.user_id)}${a.takes_decisions ? "" : " (not taking decisions)"}: ${a.project_ids.map(titleOf).join(", ")}`)
    .join("; ");
}

/** What suggests a person decides for a project, strongest first: they lead it (the lead role's line ends at them), a
 *  role covering it keeps them, they answered its decisions before. */
export type AreaSignal = { project_id: string; user_id: string; kind: "lead" | "kept" | "answered" };
const SIGNAL_WEIGHT: Record<AreaSignal["kind"], number> = { lead: 5, kept: 3, answered: 1 };

/**
 * The split the areas card proposes: each project to the person its signals
 * point at most (ties to the stronger signal's person, then a stable order).
 * A workspace with no signals at all gets everyone on every project, so the
 * rotation alone shares the work.
 */
export function proposeSplit(projectIds: readonly string[], people: readonly string[], signals: readonly AreaSignal[]): AreaAssignment[] {
  const allowed = new Set(people);
  const byPerson = new Map<string, string[]>();
  let any = false;
  for (const p of projectIds) {
    const score = new Map<string, number>();
    for (const s of signals) if (s.project_id === p && allowed.has(s.user_id)) score.set(s.user_id, (score.get(s.user_id) ?? 0) + SIGNAL_WEIGHT[s.kind]);
    const top = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!top) continue;
    any = true;
    byPerson.set(top[0], [...(byPerson.get(top[0]) ?? []), p]);
  }
  if (!any) return people.map((u) => ({ user_id: u, project_ids: [...projectIds], takes_decisions: true }));
  return people.filter((u) => byPerson.has(u)).map((u) => ({ user_id: u, project_ids: byPerson.get(u)!, takes_decisions: true }));
}

export const AREAS_CARD_QUESTION = "Who decides for which areas?";
export const AREAS_CARD_USE = "Use this split";
export const AREAS_CARD_LEAVE = "Leave areas unset";
