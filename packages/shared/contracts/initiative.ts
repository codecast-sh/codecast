// An initiative (docs/architecture/initiatives-projects-role-page.md I1): a
// goal the company is trying to reach, carried by an intentional set of
// projects, with one owner who drives it. ONE definition of its values and its
// synced row, read by the server validators (convex/initiatives.ts), the CLI
// (`cast initiative`) and the web store, so no two surfaces name a different
// status or health.
//
// The row is raw. Everything a page shows beside it is derived at render from
// the store: progress (tasks done over tasks in its projects), each project's
// lead (contracts/orgLead.ts), the owner's face and name, and sub initiatives
// (rows whose `parent_initiative_id` names this one).

export const INITIATIVE_STATUSES = ["proposed", "planned", "active", "completed", "cancelled"] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

/** What an update may say. `none` is the row's value before any update exists. */
export const INITIATIVE_UPDATE_HEALTHS = ["on_track", "at_risk", "off_track"] as const;
export type InitiativeUpdateHealth = (typeof INITIATIVE_UPDATE_HEALTHS)[number];
export type InitiativeHealth = "none" | InitiativeUpdateHealth;
export const INITIATIVE_HEALTHS = ["none", ...INITIATIVE_UPDATE_HEALTHS] as const;

export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  proposed: "Proposed",
  planned: "Planned",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const INITIATIVE_HEALTH_LABEL: Record<InitiativeHealth, string> = {
  none: "No update",
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

/** A person or a role: roles are colleagues (org-roles-run-work.md R5). */
export type InitiativeOwner =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string };

/** Who wrote an update: a person, or a role through its standing session. */
export type InitiativeUpdateAuthor =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string; conversation_id?: string };

export type InitiativePriority = "p0" | "p1" | "p2" | "p3";

/**
 * How a goal is measured: one or two numbers with a target each, read against
 * the target wherever the goal is read (the page, the health panel, the role
 * card and the review), so "on track" means against the target and not only
 * what the owner said. The value is reported the way a template's scoreboard
 * is (`cast initiative report in-N key=value --source`, the same
 * `recordScores` path as `cast org template report`), and lives in
 * `scoreboard` under the metric's key with its source and date.
 */
export type InitiativeMetric = {
  /** A slug (metricKeyOf(name)); the scoreboard's key. */
  key: string;
  name: string;
  /** The number to reach, as written: "1000", "$50k", "< 5%", "at least 40". */
  target: string;
};
export const INITIATIVE_METRICS_MAX = 2;
/** A reported value: the template scoreboard's own shape (orgTemplateState.ScoreState). */
export type InitiativeScore = { value: string; observed_at: number; source: string };

export const metricKeyOf = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

/**
 * Read a number out of a target or a value as people write them: "1,000",
 * "$50k", "2.5M", "38%", "at least 40", "< 5%". Null when there is none.
 */
export function metricNumber(text: string | null | undefined): number | null {
  const m = (text ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?\s*([kKmM])?(?![a-zA-Z])/);
  if (!m) return null;
  const n = Number(m[0].replace(/[kKmM\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = m[1]?.toLowerCase();
  return unit === "k" ? n * 1_000 : unit === "m" ? n * 1_000_000 : n;
}
/** The way a target is to be met: reach it (the default), or stay under it ("< 5%", "under 3", "at most 10"). */
export const metricDirection = (target: string): "at_least" | "at_most" => /^\s*(<=?|under|below|at most|no more than|max(?:imum)?)\b/i.test(target) || /\bor (?:less|fewer|under)\b/i.test(target) ? "at_most" : "at_least";

export type MetricStanding = "met" | "behind" | "unknown";
export type MetricReading = InitiativeMetric & {
  /** The reported value as written, or null before one was reported. */
  value: string | null;
  observed_at: number | null;
  source: string | null;
  /** Against the target: met, behind, or unknown when either side is not a number. */
  standing: MetricStanding;
  /** How far toward a reach target, 0 to 1; null when it cannot be read. */
  progress: number | null;
};

/** One metric read against its target. */
export function metricReading(metric: InitiativeMetric, score?: InitiativeScore | null): MetricReading {
  const value = score?.value ?? null;
  const n = metricNumber(value);
  const t = metricNumber(metric.target);
  const direction = metricDirection(metric.target);
  const standing: MetricStanding = n === null || t === null ? "unknown" : direction === "at_most" ? (n <= t ? "met" : "behind") : (n >= t ? "met" : "behind");
  const progress = n === null || t === null || t <= 0 || direction === "at_most" ? null : Math.max(0, Math.min(1, n / t));
  return { ...metric, value, observed_at: score?.observed_at ?? null, source: score?.source ?? null, standing, progress };
}
export const metricReadings = (row: Pick<InitiativeRow, "metrics" | "scoreboard">): MetricReading[] => (row.metrics ?? []).map((m) => metricReading(m, row.scoreboard?.[m.key]));

/** "Weekly active teams: 412 of 1,000, behind (28 Sep)" or "Weekly active teams: not reported yet, target 1,000". */
export function metricLine(r: MetricReading, now = Date.now()): string {
  if (r.value === null) return `${r.name}: not reported yet, target ${r.target}`;
  const when = r.observed_at ? ` (${dayWord(r.observed_at, now)})` : "";
  const word = r.standing === "met" ? "met" : r.standing === "behind" ? "behind" : "";
  return `${r.name}: ${r.value} of ${r.target}${word ? `, ${word}` : ""}${when}`;
}
function dayWord(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const d = new Date(at);
  return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`;
}

/** The goal's standing against its numbers as one word: behind if any metric is, met if every reported one is, else unknown. */
export function initiativeStanding(readings: MetricReading[]): MetricStanding {
  if (readings.some((r) => r.standing === "behind")) return "behind";
  if (readings.length && readings.every((r) => r.standing === "met")) return "met";
  return "unknown";
}

export type InitiativeLink = { short_id: string; title: string };
/**
 * The goals above this one, nearest first, up to the top level goal: what a
 * role's work feeds. Cycles and missing rows end the walk.
 */
export function initiativeChain<T extends { _id: string; short_id: string; title: string; parent_initiative_id?: string }>(row: T, byId: (id: string) => T | undefined): InitiativeLink[] {
  const out: InitiativeLink[] = [];
  const seen = new Set<string>([row._id]);
  let cur: T | undefined = row;
  while (cur?.parent_initiative_id && !seen.has(cur.parent_initiative_id)) {
    seen.add(cur.parent_initiative_id);
    cur = byId(cur.parent_initiative_id);
    if (!cur) break;
    out.push({ short_id: cur.short_id, title: cur.title });
  }
  return out;
}
/** "Win the private network, under Reach 1k teams" */
export const chainLine = (chain: InitiativeLink[]): string => chain.length ? `under ${chain.map((c) => c.title).join(", under ")}` : "";

export type InitiativeRow = {
  _id: string;
  /** "in-N". */
  short_id: string;
  /** The optimistic stub's own key; the server row carrying it supersedes the stub. */
  client_key?: string;
  title: string;
  /** Purpose, scope and context. */
  description?: string;
  status: InitiativeStatus;
  /** Absent means nobody drives it, which is the first finding of a review. */
  owner?: InitiativeOwner;
  target_date?: number;
  priority?: InitiativePriority;
  labels?: string[];
  /** Project ids in the order the owner arranged them. A project may sit in several initiatives. */
  project_ids: string[];
  /** One level of nesting: a row that has a parent is never a parent itself. The parent is the top level goal this one feeds. */
  parent_initiative_id?: string;
  /** One or two numbers the goal is measured by, each with a target (at most INITIATIVE_METRICS_MAX). */
  metrics?: InitiativeMetric[];
  /** The reported values by metric key, with a source and a date each (the template scoreboard's shape). */
  scoreboard?: Record<string, InitiativeScore>;
  /** Copied from the latest update when it is posted; `none` before one exists. */
  health: InitiativeHealth;
  /** When the latest update was posted, so a list shows the date with no updates loaded. */
  health_at?: number;
  latest_update_id?: string;
  /** ACCESS. */
  workspace: string;
  /** ROUTING. */
  team_id?: string;
  /** Who created it. Named `user_id` because the access stamp reads that field on every table. */
  user_id: string;
  created_at: number;
  updated_at: number;
};

export type InitiativeUpdateRow = {
  _id: string;
  client_key?: string;
  initiative_id: string;
  body: string;
  health: InitiativeUpdateHealth;
  by: InitiativeUpdateAuthor;
  at: number;
  workspace: string;
  user_id: string;
};

/** Reads `in-7`, `IN-7` and a bare `7` as the short id; anything else is returned untouched (a Convex id). */
export function normalizeInitiativeRef(ref: string): string {
  const t = (ref || "").trim();
  if (/^\d+$/.test(t)) return `in-${t}`;
  return /^in-\d+$/i.test(t) ? t.toLowerCase() : t;
}
